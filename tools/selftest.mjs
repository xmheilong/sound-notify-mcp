#!/usr/bin/env node
// 黑盒自检：通过 stdio JSON-RPC 驱动 server.mjs。
// 内部设置 SOUND_NOTIFY_DRY_RUN=1，只解析不发声，可安全用于 CI。
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, '..', 'server.mjs');

const NOTIFY = '625753__teh_bucket__onoff-sounds-with-variation.wav';
const LUDIC = '276614__mickleness__ludic.wav';
const EERIE = '527662__iwanplays__eerie-bell-loop.wav';
const JOKER = '658005__lilmati__laughing-joker-01-remastered-inner-demon-04.wav';

// 清掉外部语言信号，让每个场景的信号来源可控
const CLEAN_ENV = {
  SOUND_NOTIFY_DRY_RUN: '1',
  SOUND_NOTIFY_LANG: '',
  LC_ALL: '',
  LANG: '',
};

function scenario({ env = {}, initMeta, calls }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, ...CLEAN_ENV, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const byId = new Map();
    let buf = '';
    let stderr = '';
    let done = false;
    const expect = 2 + calls.length; // initialize + tools/list + 每个 tools/call

    const finish = (timedOut) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      resolve({ byId, stderr, timedOut });
    };
    const timer = setTimeout(() => finish(true), 8000);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined) byId.set(msg.id, msg);
        } catch {
          continue;
        }
      }
      if (byId.size >= expect) finish(false);
    });
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.stdin.on('error', () => {});
    child.on('error', () => finish(false));

    const lines = [
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: initMeta ? { _meta: initMeta } : {},
      }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      ...calls.map((c, i) =>
        JSON.stringify({ jsonrpc: '2.0', id: 3 + i, method: 'tools/call', params: c })
      ),
    ];
    child.stdin.write(lines.join('\n') + '\n');
  });
}

const call = (name, args) => ({ name, arguments: args });
const text = (r, id) => r.byId.get(id)?.result?.content?.[0]?.text || '';
const json = (r, id) => {
  try {
    return JSON.parse(text(r, id));
  } catch {
    return null;
  }
};

let passed = 0;
const failures = [];
function check(name, ok, hint = '') {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${hint ? ' — ' + hint : ''}`);
  }
}
function reportTimeout(r) {
  if (r.timedOut) console.log(`  (stderr) ${r.stderr.slice(0, 500)}`);
}

// ---- 场景 A：中文，显式 lang ----
const zh = await scenario({
  calls: [
    call('list_sounds', { lang: 'zh' }),
    call('play_sound', { lang: 'zh', sound: '提示音' }),
    call('play_sound', { lang: 'zh', sound: '小丑笑声' }),
    call('play_sound', { lang: 'zh', intent: 'success' }),
    call('play_sound', { lang: 'zh', sound: '完全不存在的音效' }),
    call('play_sound', { lang: 'zh' }),
    call('list_sounds', { lang: 'zh', query: '笑声' }),
    call('play_sound', { lang: 'zh', file: 'C:/definitely/not/here.wav' }),
  ],
});
reportTimeout(zh);
const zhList = json(zh, 3) || [];
const zhNotify = zhList.find((s) => s.id === 'notify') || {};
check('A1 中文显示名', zhNotify.name === '开关提示音', JSON.stringify(zhNotify.name));
check('A2 保留原始文件名', zhNotify.file === NOTIFY, JSON.stringify(zhNotify.file));
check('A3 清单含 5 个音效', zhList.length === 5, `实际 ${zhList.length}`);
check('A4 每条都有 lang/path', zhList.every((s) => s.lang === 'zh' && !!s.path));
check('A5 中文别名播放', text(zh, 4).includes('已播放：开关提示音') && text(zh, 4).includes(NOTIFY));
check('A6 中文名播放小丑笑声', text(zh, 5).includes('小丑笑声') && text(zh, 5).includes(JOKER));
check('A7 intent=success 命中默认音', text(zh, 6).includes(NOTIFY));
check('A8 未命中回退默认音', text(zh, 7).includes('回退到默认音效') && text(zh, 7).includes(NOTIFY));
check('A9 无参数按中文默认播放', text(zh, 8).includes('开关提示音') && text(zh, 8).includes(NOTIFY));
const filtered = json(zh, 9) || [];
check('A10 query 过滤', filtered.length === 1 && filtered[0].id === 'joker');
check('A11 file 不存在时回退', text(zh, 10).includes('路径不存在') && text(zh, 10).includes(NOTIFY));
const zhTools = zh.byId.get(2)?.result?.tools || [];
const playTool = zhTools.find((t) => t.name === 'play_sound') || {};
check('A12 工具 schema 含 lang/intent', !!playTool.inputSchema?.properties?.lang && playTool.inputSchema?.properties?.intent?.enum?.length === 5);
check('A13 dry-run 生效', text(zh, 4).includes('[dry-run]'));
const initRes = zh.byId.get(1)?.result || {};
check(
  'A14 initialize 返回 instructions（用法说明）',
  typeof initRes.instructions === 'string' &&
    initRes.instructions.includes('play_sound') &&
    initRes.instructions.includes('lang'),
  JSON.stringify(initRes.instructions || '').slice(0, 60)
);

// ---- 场景 B：英文，显式 lang + 旧版兼容 ----
const en = await scenario({
  calls: [
    call('list_sounds', { lang: 'en' }),
    call('play_sound', { lang: 'en', sound: 'On/Off Notification' }),
    call('play_sound', { lang: 'en', sound: 'ludic' }),
    call('play_sound', { lang: 'en', sound: 'onoff-sounds-with-variation' }),
    call('play_sound', { lang: 'en', intent: 'error' }),
  ],
});
reportTimeout(en);
const enList = json(en, 3) || [];
check('B1 英文显示名', (enList.find((s) => s.id === 'notify') || {}).name === 'On/Off Notification');
check('B2 英文别名/名称播放', text(en, 4).includes('Played: On/Off Notification') && text(en, 4).includes(NOTIFY));
check('B3 旧版简写 ludic 仍可用', text(en, 5).includes(LUDIC));
check('B4 旧版原文件名仍可用', text(en, 6).includes(NOTIFY));
check('B5 intent=error 命中诡异铃音', text(en, 7).includes(EERIE));
check('B6 每条 lang=en', enList.every((s) => s.lang === 'en'));

// ---- 场景 C：客户端 _meta locale ----
const meta = await scenario({
  initMeta: { 'openai/locale': 'zh-CN' },
  calls: [call('play_sound', {})],
});
reportTimeout(meta);
check('C1 _meta locale 推断为中文', text(meta, 3).includes('已播放：'), text(meta, 3).slice(0, 120));

// ---- 场景 D：环境变量 ----
const env = await scenario({
  env: { SOUND_NOTIFY_LANG: 'zh_CN' },
  calls: [call('play_sound', {})],
});
reportTimeout(env);
check('D1 环境变量推断为中文', text(env, 3).includes('已播放：'), text(env, 3).slice(0, 120));

// ---- 场景 E：无任何显式信号，走宿主语言探测 ----
const host = await scenario({ calls: [call('play_sound', {})] });
reportTimeout(host);
check('E1 宿主探测未超时', !host.timedOut, host.stderr.slice(0, 200));
check('E2 宿主探测仍能播放', /已播放：|Played:/.test(text(host, 3)) && !host.byId.get(3)?.result?.isError, text(host, 3).slice(0, 120));

console.log(`\n${failures.length ? 'FAIL' : 'PASS'} — ${passed} checks passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
}
