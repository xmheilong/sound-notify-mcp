#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOUNDS_DIR = join(__dirname, 'sounds');
const CATALOG_PATH = join(SOUNDS_DIR, 'catalog.json');
const VERSION = '1.1.0';
// catalog 缺失/损坏时的最后兜底（音效 id）
const FALLBACK_DEFAULT_ID = 'notify';
// 单段提示音最大时长（秒），防止长音频一直响
const MAX_SEC = 2;
// 自检用：只解析不发声
const DRY_RUN = process.env.SOUND_NOTIFY_DRY_RUN === '1';

// initialize 返回的用法说明（给模型读，不是给用户读的界面文案）
const INSTRUCTIONS = [
  'sound-notify plays short notification sounds to signal agent progress.',
  'Tools: list_sounds (list bundled sounds with localized names) and play_sound (play one).',
  'When to call: when the user asks for an audible cue ("完成后响一下", "play a sound when done"), or when project rules/AGENTS.md request a notification on task completion or failure — then call play_sound({ "lang": "<user language>", "intent": "success" }) when the task finishes and intent "error" when it fails.',
  'Always pass "lang" set to the language the user writes in ("zh", "en", ...): MCP has no standard locale field, so this is the only reliable signal for localized names and replies. If omitted, the server falls back to client metadata, environment variables and OS locale.',
  'play_sound with no arguments plays the default sound. Long files are clipped to 2s and a synthesized tone is used if nothing matches. No network access; no data leaves the machine.',
].join(' ');

// ---- 本地化文案 ----
const I18N = {
  zh: {
    played: '已播放：',
    notFound: (v) => `未找到「${v}」`,
    pathMissing: '路径不存在',
    badIntent: (v) => `未知意图「${v}」`,
    fallback: '回退到默认音效',
    synth: '使用合成兜底音',
    playFailed: '播放失败：',
    sep: '，',
  },
  en: {
    played: 'Played: ',
    notFound: (v) => `Sound "${v}" not found`,
    pathMissing: 'Path not found',
    badIntent: (v) => `Unknown intent "${v}"`,
    fallback: 'fallback to default sound',
    synth: 'using synthesized tone',
    playFailed: 'Playback failed: ',
    sep: ', ',
  },
};
const t = (lang) => I18N[lang] || I18N.en;

// ---- 语言推断 ----
// MCP 协议没有标准 locale 字段，因此按「显式信号 > 宿主探测 > en」分层。
// 最可靠的信号是 Agent 依据用户对话语言传入的 lang；宿主探测只做兜底。
let clientLocale = '';
let hostLangPromise = null;

function normalizeLang(v) {
  const s = String(v ?? '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-');
  if (!s) return '';
  if (/^(zh|cn|hans|hant|中文|汉语|简体|繁体)/.test(s)) return 'zh';
  if (/^(en|英文|英语)/.test(s)) return 'en';
  const m = s.match(/^([a-z]{2})(?:-|$)/);
  return m ? m[1] : '';
}

function explicitLang(arg, meta) {
  return (
    normalizeLang(arg?.lang) ||
    normalizeLang(meta?.['openai/locale'] || meta?.locale || meta?.['webplus/i18n']) ||
    normalizeLang(clientLocale) ||
    normalizeLang(process.env.SOUND_NOTIFY_LANG || process.env.LC_ALL || process.env.LANG) ||
    ''
  );
}

function icuLang() {
  try {
    return normalizeLang(Intl.DateTimeFormat().resolvedOptions().locale);
  } catch {
    return '';
  }
}

// Windows 的 UI 语言、区域格式、键盘布局是互相独立的设置。
// Get-WinUILanguageOverride 未手动设置时返回空，需逐级回退。
function probeWinUiLanguage() {
  return new Promise((resolve) => {
    const cmd = [
      "try { $l = Get-WinUILanguageOverride } catch { $l = '' }",
      "if (-not $l) { try { $l = (Get-WinUserLanguageList)[0].LanguageTag } catch { $l = '' } }",
      "if (-not $l) { try { $l = (Get-UICulture).Name } catch { $l = '' } }",
      'Write-Output $l',
    ].join('; ');
    let ps;
    try {
      ps = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], {
        windowsHide: true,
      });
    } catch {
      return resolve('');
    }
    let out = '';
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(normalizeLang(v));
    };
    ps.stdout.on('data', (d) => (out += d.toString('utf8')));
    ps.on('error', () => finish(''));
    ps.on('close', () => finish(out.trim()));
    // 探测不能拖住播放；输出是 BCP 47 字符串，无中文编码问题
    setTimeout(() => {
      ps.kill();
      finish(out.trim());
    }, 1500).unref();
  });
}

function readJsonc(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    try {
      const txt = fs.readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '');
      return JSON.parse(txt);
    } catch {
      return null;
    }
  }
}

// 只读用户级配置中的语言键；不输出整份配置，失败一律静默跳过。
// strong = 明确的 UI locale；weak = 语义较弱的偏好（如提交信息语言）。
function probeIdeLanguage() {
  const roots = [process.env.APPDATA, process.env.XDG_CONFIG_HOME, process.env.HOME].filter(Boolean);
  const candidates = [];
  const products = ['CodeBuddy CN', 'CodeBuddy', 'WorkBuddy', 'Code', 'Cursor', 'Trae CN'];
  for (const r of roots) {
    for (const p of products) {
      candidates.push(join(r, p, 'User', 'locale.json'));
      candidates.push(join(r, p, 'User', 'settings.json'));
    }
    if (process.platform !== 'win32') {
      candidates.push(join(r, '.config', 'Code', 'User', 'locale.json'));
      candidates.push(join(r, '.config', 'Code', 'User', 'settings.json'));
    }
  }
  let weak = '';
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const data = readJsonc(file);
      if (!data || typeof data !== 'object') continue;
      const strong = normalizeLang(data.locale || data['workbench.language']);
      if (strong) return { strong, weak: '' };
      if (!weak) weak = normalizeLang(data['codingcopilot.commitMessageLanguage']);
    } catch {
      continue;
    }
  }
  return { strong: '', weak };
}

async function inferHostLang() {
  const ide = probeIdeLanguage();
  if (ide.strong) return ide.strong;
  const osLang = process.platform === 'win32' ? await probeWinUiLanguage() : icuLang();
  if (osLang) return osLang;
  return ide.weak || icuLang() || 'en';
}

function getHostLang() {
  if (!hostLangPromise) hostLangPromise = inferHostLang().catch(() => '');
  return hostLangPromise;
}

async function resolveLang(arg, meta) {
  return explicitLang(arg, meta) || (await getHostLang()) || 'en';
}

// ---- 音效清单 ----
function fileSlug(file) {
  return file.replace(/^\d+__[^_]+__/, '').replace(/\.wav$/i, '');
}

function loadCatalog() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  } catch {
    raw = {};
  }
  const intents = raw.intents && typeof raw.intents === 'object' ? raw.intents : {};
  const entries = [];

  for (const item of Array.isArray(raw.sounds) ? raw.sounds : []) {
    if (!item || typeof item.file !== 'string') continue;
    if (path.basename(item.file) !== item.file) continue; // 防止清单里写路径穿越
    if (!fs.existsSync(join(SOUNDS_DIR, item.file))) continue;
    const id = String(item.id || fileSlug(item.file));
    entries.push({
      id,
      file: item.file,
      files: item.files && typeof item.files === 'object' ? item.files : {},
      slug: fileSlug(item.file),
      labels: item.labels && typeof item.labels === 'object' ? item.labels : {},
      intents: Object.keys(intents).filter((k) => intents[k] === id),
    });
  }

  // 目录里新增但未登记的 .wav 自动纳入，保持「丢个文件进去就能用」
  try {
    for (const f of fs.readdirSync(SOUNDS_DIR)) {
      if (!/\.wav$/i.test(f) || entries.some((e) => e.file === f)) continue;
      const slug = fileSlug(f);
      entries.push({
        id: slug,
        file: f,
        files: {},
        slug,
        labels: { zh: { name: slug, aliases: [] }, en: { name: slug, aliases: [] } },
        intents: [],
      });
    }
  } catch {
    // 目录不可读时交给后面的合成兜底音
  }

  return { entries, defaults: raw.defaults || {}, intents };
}

function displayName(entry, lang) {
  return entry.labels?.[lang]?.name || entry.labels?.en?.name || entry.slug;
}

// 语言专属文件（可选扩展点）：配了且存在才用，否则用通用文件
function pickFile(entry, lang) {
  const f = entry.files?.[lang];
  if (typeof f === 'string' && path.basename(f) === f && fs.existsSync(join(SOUNDS_DIR, f))) {
    return f;
  }
  return entry.file;
}

// ---- 内置音效列表（按语言本地化；保留 name / path 旧字段）----
function listBundledSounds(lang) {
  const cat = loadCatalog();
  return cat.entries.map((e) => ({
    id: e.id,
    name: displayName(e, lang),
    file: e.file,
    fileName: e.file,
    aliases: (e.labels?.[lang]?.aliases || []).slice(),
    intents: e.intents,
    lang,
    path: join(SOUNDS_DIR, pickFile(e, lang)),
  }));
}

function normKey(v) {
  return String(v ?? '')
    .normalize('NFKC')
    .replace(/\.wav$/i, '')
    .replace(/^\d+__[^_]+__/, '')
    .replace(/[\s_\-./\\:]+/g, '')
    .toLowerCase();
}

// 中文名、英文名、别名、id、原文件名 slug 都能命中
function findSound(input, lang, cat) {
  const key = normKey(input);
  if (!key) return null;
  const labelsOf = (e) => Object.values(e.labels || {});
  const stages = [
    (e) => normKey(e.labels?.[lang]?.name) === key,
    (e) => (e.labels?.[lang]?.aliases || []).some((a) => normKey(a) === key),
    (e) => labelsOf(e).some((l) => normKey(l?.name) === key),
    (e) => labelsOf(e).some((l) => (l?.aliases || []).some((a) => normKey(a) === key)),
    (e) => normKey(e.id) === key,
    (e) => normKey(e.slug) === key,
    (e) => {
      const pool = [
        ...labelsOf(e).flatMap((l) => [l?.name, ...(l?.aliases || [])]),
        e.slug,
        e.id,
      ]
        .map(normKey)
        .filter(Boolean);
      return pool.some((v) => v.includes(key) || (key.length >= 2 && v.length >= 2 && key.includes(v)));
    },
  ];
  for (const stage of stages) {
    const hit = cat.entries.find(stage);
    if (hit) return hit;
  }
  return null;
}

// 解析 target -> { wavPath, temp, note, label }
function resolveTarget(arg, lang, cat) {
  const L = t(lang);
  let wavPath = null;
  let note = '';
  let label = '';
  let temp = false;

  const useEntry = (entry) => {
    if (!entry) return false;
    wavPath = join(SOUNDS_DIR, pickFile(entry, lang));
    label = displayName(entry, lang);
    return true;
  };

  if (arg.file) {
    if (fs.existsSync(arg.file)) {
      wavPath = arg.file;
      label = path.basename(arg.file);
    } else {
      note = L.pathMissing + L.sep;
    }
  } else if (arg.sound) {
    if (!useEntry(findSound(arg.sound, lang, cat))) note = L.notFound(arg.sound) + L.sep;
  } else if (arg.intent) {
    const id = cat.intents[arg.intent];
    const hit = id ? cat.entries.find((e) => e.id === id) : null;
    if (!useEntry(hit)) note = L.badIntent(arg.intent) + L.sep;
  }

  if (!wavPath) {
    const defId = cat.defaults[lang] || cat.defaults.en || FALLBACK_DEFAULT_ID;
    const def = cat.entries.find((e) => e.id === defId) || cat.entries[0];
    useEntry(def);
    if (note) note += L.fallback;
  }
  if (!wavPath || !fs.existsSync(wavPath)) {
    wavPath = writeTempWav(synthesizeWav());
    temp = true;
    label = '';
    note += L.synth;
  }
  return { wavPath, temp, note: note.trim(), label };
}

function writeWavHeader(buf, dataLen, sr, ch, bits) {
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(ch, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE((sr * ch * bits) / 8, 28);
  buf.writeUInt16LE((ch * bits) / 8, 32);
  buf.writeUInt16LE(bits, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
}

// ---- 合成兜底音（「叮~咚」双音，无需任何外部文件）----
function synthesizeWav() {
  const sr = 44100;
  const segs = [
    { f: 740, d: 0.18 },
    { f: 0, d: 0.07 },
    { f: 988, d: 0.22 },
  ];
  const amp = 0.9;
  const samples = [];
  for (const s of segs) {
    if (s.f === 0) {
      for (let i = 0; i < sr * s.d; i++) samples.push(0);
      continue;
    }
    const n = Math.floor(sr * s.d);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const env = Math.min(1, t / 0.008) * Math.min(1, (s.d - t) / 0.008);
      const v = amp * Math.sin(2 * Math.PI * s.f * t) * env;
      samples.push(Math.max(-1, Math.min(1, v)));
    }
  }
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    data.writeInt16LE(Math.round(samples[i] * 32767), i * 2);
  }
  const buf = Buffer.alloc(44 + data.length);
  writeWavHeader(buf, data.length, sr, 1, 16);
  data.copy(buf, 44);
  return buf;
}

// ---- 裁剪 WAV 到前 MAX_SEC 秒（兼容标准 PCM）----
function trimWav(buf, maxSec) {
  try {
    if (buf.length < 44) return buf;
    if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return buf;
    const sr = buf.readUInt32LE(24);
    const ch = buf.readUInt16LE(22);
    const bits = buf.readUInt16LE(34);
    if (bits !== 16) return buf;
    const bytesPerSec = (sr * ch * bits) / 8;
    const maxBytes = Math.max(1, Math.floor(maxSec * bytesPerSec));
    let off = 12;
    let dataOff = -1;
    let dataLen = -1;
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4);
      const size = buf.readUInt32LE(off + 4);
      if (id === 'data') {
        dataOff = off + 8;
        dataLen = size;
        break;
      }
      off = off + 8 + size + (size & 1);
    }
    if (dataOff < 0) return buf;
    const take = Math.min(dataLen, maxBytes);
    const data = buf.slice(dataOff, dataOff + take);
    const out = Buffer.alloc(44 + data.length);
    writeWavHeader(out, data.length, sr, ch, bits);
    data.copy(out, 44);
    return out;
  } catch {
    return buf;
  }
}

function writeTempWav(buf) {
  const p = path.join(
    os.tmpdir(),
    `sound-notify-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`
  );
  fs.writeFileSync(p, buf);
  return p;
}

// ---- 跨平台播放 ----
function playFile(wavPath) {
  return new Promise((resolve, reject) => {
    const platform = process.platform;
    if (platform === 'darwin') {
      const ps = spawn('afplay', [wavPath], { windowsHide: true });
      ps.on('error', reject);
      ps.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`afplay exit ${c}`))));
      return;
    }
    if (platform === 'win32') {
      // Windows: 用 .NET SoundPlayer 同步播放，纯 API、无窗口、不调起默认播放器。
      // windowsHide 隐藏 PowerShell 控制台；PlaySync 会阻塞到播完再退出。
      const safe = wavPath.replace(/'/g, "''");
      const ps = spawn(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', `(New-Object System.Media.SoundPlayer('${safe}')).PlaySync()`],
        { windowsHide: true }
      );
      ps.on('error', reject);
      ps.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`SoundPlayer exit ${c}`))));
      return;
    }
    // linux: 依次尝试可用播放器
    const players = [
      ['aplay', [wavPath]],
      ['paplay', [wavPath]],
      ['ffplay', ['-autoexit', '-nodisp', wavPath]],
    ];
    let i = 0;
    const tryNext = () => {
      if (i >= players.length) return reject(new Error('no usable audio player on linux'));
      const [c, a] = players[i++];
      const ps = spawn(c, a, { windowsHide: true });
      ps.on('error', tryNext);
      ps.on('close', (c2) => (c2 === 0 ? resolve() : tryNext()));
    };
    tryNext();
  });
}

// ---- stdio JSON-RPC ----
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line) handle(line);
  }
});

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function handle(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  const meta = { ...(msg._meta || {}), ...(params?._meta || {}) };

  if (method === 'initialize') {
    clientLocale = meta['openai/locale'] || meta.locale || meta['webplus/i18n'] || '';
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'sound-notify', version: VERSION },
        // MCP 标准可选字段：客户端可把它注入模型上下文，是最省事的「使用说明」入口。
        instructions: INSTRUCTIONS,
      },
    });
    return;
  }
  if (method === 'ping') {
    if (id !== undefined) send({ jsonrpc: '2.0', id, result: {} });
    return;
  }
  if (method === 'notifications/initialized') return;

  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: [listTool, playTool] } });
    return;
  }

  if (method === 'tools/call') {
    const name = params?.name;
    const arg = params?.arguments || {};

    if (name === 'list_sounds') {
      const lang = await resolveLang(arg, meta);
      let sounds = listBundledSounds(lang);
      if (arg.query) {
        const q = normKey(arg.query);
        sounds = sounds.filter((s) =>
          [s.name, s.id, s.file, ...s.aliases].some((v) => normKey(v).includes(q))
        );
      }
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: JSON.stringify(sounds, null, 2) }] },
      });
      return;
    }

    if (name === 'play_sound') {
      const lang = await resolveLang(arg, meta);
      const L = t(lang);
      const info = resolveTarget(arg, lang, loadCatalog());
      let playPath = info.wavPath;
      try {
        // 内置音效已预裁剪为 2s，直接播放原文件。
        // 只有外部传入的长文件才需要裁剪成临时文件。
        if (!info.temp && arg.file) {
          const clipped = trimWav(fs.readFileSync(info.wavPath), MAX_SEC);
          if (clipped.length < fs.statSync(info.wavPath).size) {
            playPath = writeTempWav(clipped);
          }
        }
        if (!DRY_RUN) await playFile(playPath);
        const text =
          `${L.played}${info.label ? info.label + ' · ' : ''}${info.wavPath}` +
          (info.note ? ' (' + info.note + ')' : '') +
          (DRY_RUN ? ' [dry-run]' : '');
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
      } catch (e) {
        send({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: L.playFailed + e.message }], isError: true },
        });
      } finally {
        // 临时文件延迟删除：播放器是异步启动的，立刻删会报「找不到文件」
        if (playPath !== info.wavPath) {
          setTimeout(() => fs.unlink(playPath, () => {}), 15000).unref();
        }
        if (info.temp) {
          setTimeout(() => fs.unlink(info.wavPath, () => {}), 15000).unref();
        }
      }
      return;
    }

    if (id !== undefined)
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
    return;
  }

  if (id !== undefined)
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
}

const listTool = {
  name: 'list_sounds',
  description:
    'List the built-in CC0 notification sounds. Pass "lang" (the language the USER is writing in, e.g. "zh" or "en") to get localized display names: Chinese users see names like "开关提示音", English users see "On/Off Notification". The original .wav file name is returned in "file". Optional "query" filters by name/alias/id.',
  inputSchema: {
    type: 'object',
    properties: {
      lang: {
        type: 'string',
        description: 'BCP 47 / short language code of the user\'s conversation language ("zh", "en", ...). The agent should pass this based on the language the user writes in. Controls localized names.',
      },
      query: {
        type: 'string',
        description: 'Optional substring filter on localized name, alias, id or file name.',
      },
    },
  },
};

const playTool = {
  name: 'play_sound',
  description:
    'Play a notification sound to signal that the agent task is complete. Pass "lang" set to the language the USER is writing in ("zh" for Chinese, "en" for English) so names/replies are localized; if omitted, the server infers it from client metadata, environment and OS settings. "sound" accepts localized names (e.g. "提示音", "小丑笑声"), original English names or short suffixes like "ludic". "intent" picks a sound by meaning (success/error/alert/playful/calm). "file" plays an explicit .wav path (overrides everything). Long files are clipped to 2s; falls back to a synthesized tone if nothing is found. Cross-platform (Windows/macOS/Linux).',
  inputSchema: {
    type: 'object',
    properties: {
      sound: {
        type: 'string',
        description: 'Localized name, English name, alias, id or original .wav file name of a bundled sound (see list_sounds). Falls back to the default sound if not found.',
      },
      file: {
        type: 'string',
        description: 'Explicit .wav file path to play (overrides "sound" and "intent").',
      },
      lang: {
        type: 'string',
        description: 'BCP 47 / short language code of the user\'s conversation language ("zh", "en", ...). The agent should pass this based on the language the user writes in.',
      },
      intent: {
        type: 'string',
        enum: ['success', 'error', 'alert', 'playful', 'calm'],
        description: 'Semantic shortcut: pick a suitable sound by intent instead of a name.',
      },
    },
  },
};
