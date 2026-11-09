# sound-notify-mcp

一个极简的 [MCP](https://modelcontextprotocol.io) 服务：**任务完成时播放提示音**，跨平台（Windows / macOS / Linux），零运行时依赖，音效自带（CC0）。

从 1.1.0 起，音效名称支持**按用户语言本地化**：中文用户看到「开关提示音」「小丑笑声」并能直接用中文名播放，英文用户看到 `On/Off Notification` 等语义名；磁盘上的 `.wav` 仍保留 Freesound 原始文件名以便溯源。

## 特性

- 两个工具：
  - `list_sounds`：按语言列出内置音效，返回本地化名称、别名、真实文件名与路径，支持 `query` 过滤。
  - `play_sound`：播放提示音。支持 `sound`（中文名 / 英文名 / 别名 / 原文件名）、`intent`（按语义选音）、`file`（显式 `.wav` 路径）与 `lang`（用户语言）。
- **分层语言推断**：显式 `lang` → 客户端 `_meta` locale → 环境变量 → IDE 配置 → 操作系统语言 → `en`。
- **自带用法说明**：`initialize` 返回标准 `instructions` 字段，客户端若支持会直接注入模型上下文，Agent 不用额外交代就知道什么时候该调用。
- 长音频自动裁剪到 2s；音效缺失时用 Node 合成一段「叮~咚」兜底音，任何系统都能响。
- Windows 用 PowerShell + .NET `SoundPlayer`，macOS 用 `afplay`，Linux 依次尝试 `aplay` / `paplay` / `ffplay`。

## 安装 / 运行

需 Node.js >= 18，无需安装任何依赖。

- **MCP Market（推荐）**：CodeBuddy / WorkBuddy 设置 → MCP → MCP Market，搜 `sound-notify` 一键安装，显示绿色状态即启动成功。
- **手动接入**：设置 → MCP → Add MCP，写入：

```json
{
  "mcpServers": {
    "sound-notify": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "sound-notify-mcp"],
      "description": "任务完成/失败时播放提示音"
    }
  }
}
```

- **本地开发**：`node <本机绝对路径>/server.mjs`（把 `command` 改成 `node`、`args` 改成绝对路径即可）。
- **纯命令行试用**：`echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | npx -y sound-notify-mcp`

## 怎么用（用户只需要看这一节）

装完之后**不用记参数**，用自然语言说就行：

| 你说 | Agent 会做 |
|---|---|
| 「完成后响一下」 | 结束时 `play_sound({ "intent": "success" })` |
| 「用提示音提醒我」/「响个铃」 | `play_sound()` 播默认音 |
| 「播放小丑笑声」 | `play_sound({ "sound": "小丑笑声" })` |
| 「失败的时候出个诡异铃声」 | 失败时 `play_sound({ "intent": "error" })` |
| 「有哪些音效」 | `list_sounds()` 列出清单 |

**它不会自己乱响**：MCP 工具只在 Agent 判断需要时才被调用。想让每次任务结束都响，把下面这段写进项目 `.codebuddy/rules`（或 `AGENTS.md`）：

```md
每次完成用户任务后，调用 play_sound({ "lang": "zh", "intent": "success" })；
任务失败或报错时，调用 play_sound({ "lang": "zh", "intent": "error" })。
```

> 语言由 Agent 通过 `lang` 参数传入，所以中文用户看到的是中文音效名和中文回复。没传时按「客户端 metadata → 环境变量 → IDE 配置 → 系统语言 → en」逐级兜底。

## 验证是否装好

MCP 列表里 `sound-notify` 为绿色后，点 **Try to Run**，或直接在对话里说「响一下」。

装好了却听不到声音，按顺序排查：

1. 在对话里明确要求一次（「现在响一下」），避免 Agent 认为没必要调用；
2. 用 `play_sound({ "file": "<某个 .wav 的绝对路径>" })` 排除音效查找问题；
3. 检查系统音量、静音、输出设备（Windows 还要看是否单独静音了该应用）；
4. 跑自检 `npm run selftest`（dry-run，不发声，只验证解析链路）。

## 工具参数

| 工具 | 参数 | 说明 |
|---|---|---|
| `list_sounds` | `lang` | 用户对话语言，`zh` / `en` / BCP 47（如 `zh-CN`）。决定显示名与别名 |
| | `query` | 可选，按名称 / 别名 / id / 文件名过滤 |
| `play_sound` | `lang` | 同上；**Agent 应根据用户使用的语言传入**，这是最可靠的语言信号 |
| | `sound` | 本地化名、英文名、别名、id 或原 `.wav` 文件名（不含扩展名） |
| | `intent` | `success` / `error` / `alert` / `playful` / `calm` |
| | `file` | 显式 `.wav` 路径，优先级最高 |

`list_sounds` 返回示例（中文）：

```json
{
  "id": "notify",
  "name": "开关提示音",
  "file": "625753__teh_bucket__onoff-sounds-with-variation.wav",
  "fileName": "625753__teh_bucket__onoff-sounds-with-variation.wav",
  "aliases": ["提示音", "默认", "任务完成", "完成", "通知", "开关"],
  "intents": ["success", "alert"],
  "lang": "zh",
  "path": ".../sounds/625753__teh_bucket__onoff-sounds-with-variation.wav"
}
```

`name` / `path` 是兼容旧版的字段；真实文件名始终在 `file`（`fileName`）里。

## 示例调用

```text
play_sound({ "lang": "zh" })                          → 已播放：开关提示音（默认）
play_sound({ "lang": "zh", "sound": "小丑笑声" })     → 中文名播放
play_sound({ "lang": "zh", "intent": "error" })       → 诡异铃音
play_sound({ "lang": "en", "sound": "Playful Blip" }) → 英文名播放
play_sound({ "sound": "ludic" })                      → 旧版简写仍然可用
play_sound({ "file": "C:\\path\\to\\custom.wav" })    → 自定义文件
```

## 语言是怎么推断的

| 优先级 | 信号 | 说明 |
|---|---|---|
| 1 | 工具参数 `lang` | **权威**：Agent 看得到用户对话语言，应主动传入 |
| 2 | `_meta["openai/locale"]` / `webplus/i18n` | 部分客户端在 `initialize` / `tools/call` 里带，非 MCP 标准 |
| 3 | `SOUND_NOTIFY_LANG` / `LC_ALL` / `LANG` | 适合脚本、CI、强制指定 |
| 4 | IDE 用户配置里的 `locale` / `commitMessageLanguage` | 只读语言相关键，找不到就跳过 |
| 5 | OS：Windows UI 语言（PowerShell）或 `Intl` 默认 locale | Windows 上 UI 语言与区域格式是两套设置，逐级回退 |
| 6 | `en` | 最终兜底 |

MCP 协议本身**没有**标准的客户端语言字段，所以服务端读到的系统语言不等于用户此刻的对话语言；系统推断只作为「Agent 没传 `lang`」时的兜底（例如纯命令行 `npx` 管道调用）。

环境变量：

- `SOUND_NOTIFY_LANG=zh`：强制指定语言。
- `SOUND_NOTIFY_DRY_RUN=1`：只解析不发声，供自检使用。

## 目录结构

```text
mcp-sound-server/
  server.mjs                 # MCP stdio 服务
  package.json
  sounds/
    catalog.json             # 多语言名称、别名、意图、默认音效
    ATTRIBUTION.md           # CC0 素材来源
    *.wav                    # 内置音效（已预裁剪为 2s）
  tools/
    selftest.mjs             # 黑盒自检（dry-run，不发声）
```

往 `sounds/` 里丢一个新的 `.wav` 即可直接播放（自动纳入清单，此时显示名就是文件名）；想给它中文名，在 `catalog.json` 里加一条 `sounds` 记录即可。

### 让不同语言播放不同文件（可选）

`catalog.json` 的单条记录支持 `files` 字段，未配置或文件不存在时自动回退通用 `file`：

```json
{
  "id": "notify",
  "file": "625753__teh_bucket__onoff-sounds-with-variation.wav",
  "files": { "zh": "任务完成.wav", "en": "task_complete.wav" },
  "labels": { "zh": { "name": "开关提示音", "aliases": [] } }
}
```

这可用于将来按语言播放不同语音内容；当前内置音效都是无语义音效，未启用该字段。

## 自检

```bash
npm run selftest
# 等价于 node tools/selftest.mjs（内部使用 SOUND_NOTIFY_DRY_RUN=1，不会发声）
```

覆盖：中英文显示名、中文/英文别名播放、旧版英文名兼容、`intent`、未命中回退、`file` 路径回退、`_meta` locale、环境变量、宿主语言推断、工具 schema。

## 许可证

代码 MIT；`sounds/*.wav` 为 Freesound CC0 素材，来源见 `sounds/ATTRIBUTION.md`。
