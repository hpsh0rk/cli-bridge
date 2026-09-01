# cli-bridge

让**网页 / 本地程序 / AI Agent** 以统一、受控、可审计的方式调用用户本机已安装的命令行 AI 工具（agy、codex…）。

桥永远只跑在用户本机、只服务本机用户；安全是一等公民：四层白名单 + per-origin token + 固化命令模板，网页永远碰不到 shell。

```
                         ┌────────────────────────────────────────────┐
  浏览器网页(https) ──▶  │  HTTP 通道  127.0.0.1:39487                │
                         │  CORS 白名单 + per-origin token            │
                         │                                            │        ┌─────────┐
  本地 CLI / Agent  ──▶  │  核心：队列 · 限流 · 超时 · 审计            │ ─────▶ │  agy    │
  (cli-bridge run /      │  配置 · token · 适配器注册表                │        ├─────────┤
    curl --unix-socket)  │  UDS 通道  ~/.cli-bridge/bridge.sock       │        │  codex  │
                         └────────────────────────────────────────────┘        └─────────┘
```

零第三方依赖，Node ≥ 18。协议与接入文档：[docs/PROTOCOL.md](docs/PROTOCOL.md)。整体设计：[DESIGN.md](DESIGN.md)。

## 前置要求

- Node ≥ 18（仅用内置模块，零 npm 依赖）；
- 至少安装并登录一个受支持的 CLI 工具（如 [Antigravity CLI](https://antigravity.google/docs/cli)：`agy`）；工具白名单默认全关，装好后在桥上显式启用。

## 安装

```bash
# 方式一：npm 发布包（推荐，装完即得全局命令 cli-bridge）
npm i -g @sh0rk/cli-bridge

# 方式二：从本目录源码全局安装
npm i -g .

# 方式三：从压缩包安装
npm pack                    # 产出 cli-bridge-0.1.0.tgz
npm i -g ./cli-bridge-0.1.0.tgz

# 方式四：推到 git 远端后，任何人可直接从仓库安装
npm i -g github:<你的用户名>/cli-bridge
```

安装后即可使用全局命令 `cli-bridge`；不装全局也可以 `node bin/cli-bridge.js <命令>`。

## 快速开始

```bash
cli-bridge start          # 或 node bin/cli-bridge.js start
```

启动后：

```bash
cli-bridge doctor                     # 体检：配置 / 工具 / 端口 / 桥状态
cli-bridge tools allow agy            # ① 启用工具（默认全关，交互确认）
cli-bridge origins add https://your-site.com   # ② 允许哪个网站连（仅 https）
cli-bridge token create --origin https://your-site.com   # ③ 签发 token（粘贴进网页）
cli-bridge run agy "你好"             # 本机快捷调用（走 UDS，免 token）
cli-bridge stop                       # 停桥（依据 ~/.cli-bridge/bridge.pid）
cli-bridge restart                    # 停 + 在前台重启（配置改完常用；[--port N] 同 start）
```

## 浏览器演示页

桥自带一个同源控制台，零配置在浏览器里跑通全流程（粘贴 token → 选工具 → 运行/取消 → 多轮对话/图片生成）：

```bash
cli-bridge token create --origin local   # 签发本机 token
open http://127.0.0.1:39487/
```

同源请求豁免 https 来源白名单（token 仍必填）；部署在外部 https 站点的页面走完整接入流程，见下节与 [docs/PROTOCOL.md §5](docs/PROTOCOL.md)。

## 在线调试台

不想在终端里逐步配对？打开 **[sh0rk.cn/tools/cli-bridge](https://sh0rk.cn/tools/cli-bridge)** ——本桥的网页版调试台：

- **一键复制安装命令**，照着引导装好并启动桥；
- **检测桥状态**（`GET /v1/health`），未装 / 未启动 / 被浏览器本地网络权限拦截都有对应提示；
- **配对向导**按你当前访问的页面 origin 动态生成 `origins add` 与 `token create` 命令，token 验证后只存本浏览器；
- **调试控制台**拉取工具白名单，同步 / 异步（SSE 事件流）两种模式运行，支持取消，另有图像生成模式；
- **多轮对话 demo**：像真实 OpenAI 客户端一样多轮聊天，直观展示会话续聊与每轮「缓存命中」的 token 数（见下文 OpenAI 兼容层）；
- 页面底部有**原始请求日志**，每个请求的 URL、状态码、耗时与响应体都可展开复制。

适合快速测试、排查接入问题，也可以当第三方网页接入的实现参考（页面源码在 [personal-site](https://github.com/hpsh0rk/personal-site) 的 `apps/web/src/pages/tools/cli-bridge.astro`）。

## 网页接入（30 秒版）

```js
const BASE = 'http://127.0.0.1:39487';
const r = await fetch(`${BASE}/v1/tools/agy/run`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-bridge-token': TOKEN },
  body: JSON.stringify({ input: '你好', wait: true }),
}).then(r => r.json());
// r.ok === true → r.data.output
```

完整流程（探测 → LNA 权限 → 配对 → 运行 → SSE）见 [docs/PROTOCOL.md §5](docs/PROTOCOL.md)。

## 本机 / AI Agent 接入

本机程序与 Agent 走 UDS 通道，免 token（文件权限 0700 即信任边界）：

```bash
curl --unix-socket ~/.cli-bridge/bridge.sock \
  -X POST http://localhost/v1/tools/agy/run \
  -H 'Content-Type: application/json' -d '{"input":"你好"}'
```

`skills/cli-bridge/SKILL.md` 可直接作为 ZCode / Claude 等 Agent 的 Skill 安装。

## 配置

所有状态都在 `~/.cli-bridge/`（0700，config/tokens 0600）：

```jsonc
// ~/.cli-bridge/config.json
{
  "server": { "port": 39487 },                 // host 恒为 127.0.0.1
  "auth":   { "requireToken": true },
  "origins": ["https://your-site.com"],        // 只能经 cli-bridge origins add 增删
  "tools":  { "allow": ["agy"], "overrides": {} },
  "adapters": {},                              // 声明级覆盖 / 自定义工具（见下）
  "limits": { "runsPerMinute": 10, "queueDepth": 8, "maxBodyBytes": 1048576 },
  "log":    { "level": "info", "redactPrompts": true, "audit": true }
}
```

安全不变量：配置只从 `~/.cli-bridge/` 读取（恶意仓库放 CWD 配置无效）；origins 增删只能走交互式 CLI；env（`CLI_BRIDGE_*`）只能启动时临时放宽，横幅明告。

## 适配器：内置与自定义

内置：`agy`（flags 已实测；支持流式、图片生成、多轮会话续聊）、`codex`（本机未安装，按官方文档声明，标记**未实测**；`npm i -g @openai/codex` 装好后 `available` 自动变为 true）。

**新增/修正工具不用改代码**——在 `adapters` 段写声明即可，示例：

```jsonc
{
  "adapters": {
    "claude": {
      "displayName": "Claude Code",
      "binary": "claude",
      "run": { "args": ["-p", "{input}", "--output-format", "json"], "output": "json", "jsonResponsePath": "result", "usagePath": "usage" },
      "capabilities": { "text": true, "image": false, "stream": false, "conversation": false },
      "limits": { "timeoutMs": 300000, "concurrency": 1, "outputMaxBytes": 8388608 },
      "options": []
    }
  },
  "tools": { "allow": ["claude"], "overrides": {} }
}
```

约束（schema 校验强制）：`run.args` 里 `{input}` 必须恰好出现一次且为独立 argv 元素（无 shell、无字符串拼接）；`output` 支持 `json`（`jsonResponsePath` 提取 + 可选 status 校验）、`ndjson`（`ndjsonPick` 选事件 + `ndjsonTextPath` 提取）、`text`。每次运行在 `~/.cli-bridge/workspace/<tool>/<runId>/` 下执行，超时/取消杀整个进程组。

**多轮会话续聊**（可选能力）：声明 `capabilities.conversation: true` + `options` 里的 `conversationId` 选项（映射为续聊 flag，如 agy 的 `--conversation`），并在输出声明里加 `jsonConversationIdPath`（json 模式）/ `stream.final.conversationIdPath`（stream 模式）提取工具回传的会话 id——OpenAI 兼容层即自动获得多轮续聊（见 `src/adapters/agy.js` 的完整示例）。

## 安全模型速览

| 威胁 | 对策 |
|---|---|
| 恶意网站扫描/调用 | token 必带 + 自定义头强制预检 + 频控 |
| DNS rebinding | Host 只接受 127.0.0.1 / localhost |
| token 被 XSS 偷走 | per-origin 绑定（别的站点用不了）+ 服务端只存哈希 + 随时吊销 |
| 配置被恶意仓库篡改 | 只读 `~/.cli-bridge/`，写入走交互 CLI |
| prompt 诱导超大输出 | outputMaxBytes 截断 + `truncated` 标记 |
| 工具失控写文件 | workspace 目录隔离 + 进程组超时/取消 |

审计日志：`~/.cli-bridge/audit.log`（时间 · 来源 · token 哈希前 8 位 · 工具 · 状态 · 耗时；默认不记录 prompt）。

## OpenAI 兼容层（无缝接入现有生态）

桥实现了 OpenAI 协议的常用子集，任何 OpenAI SDK / 聊天前端把 `base_url` 指到本桥即可用：

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:39487/v1", api_key="cb_…你的桥token")

# 流式聊天（真增量，非伪流式）
stream = client.chat.completions.create(model="agy", messages=[{"role": "user", "content": "你好"}], stream=True)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")

# 多轮对话：照常每轮重发完整 messages，桥自动续聊同一会话——
# 只把新增消息发给 CLI，上游 KV cache 复用，token 花费显著降低
# （实测 agy 第二轮 input 33981 中 24480 来自缓存，见 usage.prompt_tokens_details.cached_tokens）
msgs = [{"role": "user", "content": "记住暗号是芒果7号"}]
msgs.append({"role": "assistant", "content": client.chat.completions.create(model="agy", messages=msgs).choices[0].message.content})
msgs.append({"role": "user", "content": "暗号是什么？"})
r2 = client.chat.completions.create(model="agy", messages=msgs)
print(r2.choices[0].message.content)          # 芒果7号（续聊同一会话，无需重发上下文）
print(r2.usage.prompt_tokens_details.cached_tokens)  # 本轮从缓存读取的 token 数

# 图片生成（OpenAI Images 协议）
img = client.images.generate(model="agy", prompt="一只戴帽子的柴犬")
open("out.png", "wb").write(base64.b64decode(img.data[0].b64_json))
```

| 端点 | 说明 |
|---|---|
| `GET /v1/models` | 白名单内可用工具 → model 列表 |
| `POST /v1/chat/completions` | 同步 + SSE 流式；多轮 messages 自动走会话续聊（如 agy `--conversation`），只把新增消息发给 CLI，复用上游 KV cache 省 token；前缀不匹配回退整段转写；响应带桥扩展 `bridge_conversation_id`，usage 含 `prompt_tokens_details.cached_tokens`；temperature 等参数静默忽略 |
| `POST /v1/images/generations` | 仅 `n=1`；默认 `b64_json`；`response_format:"url"` 返回 `/v1/files/...`（取文件需带 token 头，`<img>` 标签用不了 URL，请用 b64）；size 等参数静默忽略 |
| `GET /v1/files/:tool/:runId/:file` | 图片文件取回（需 token 头） |

错误响应用 OpenAI 信封 `{"error":{message,type,code,param}}`，桥的错误码放在 `code` 字段。图片生成依赖工具自身的图像能力（agy 的 `generate_image` 有配额限制，实测时好时坏；失败时桥会快速中止并返回明确错误，不空耗超时）。

## 常见问题

- **端口被占用**：`cli-bridge start --port <N>` 换端口；默认 39487 只绑 127.0.0.1。
- **提示工具未启用（E_TOOL_DISABLED）**：这是白名单默认全关的设计，`cli-bridge tools allow <id>` 显式启用。
- **提示工具未安装（E_TOOL_UNAVAILABLE）**：按返回的 `installHint` 安装（如 `npm i -g @openai/codex`），装好无需重启桥即可被探测到。
- **图片生成报"配额已用尽"**：图片能力来自上游模型（agy 走 Google 的图像模型），有每日配额。桥会把上游的真实原因透传出来，例如：
  ```
  [E_TOOL_FAILED] 图片生成工具 generate_image 调用失败（已中止，避免无效重试）：
  图像生成配额已用尽（模型 gemini-3.1-flash-image），将于 2026-08-31T14:50:39Z 重置。
  ```
  按提示的时间等配额重置后重试即可，无需任何操作。失败时桥会快速中止（不空耗超时），`error.detail` 保留上游原始错误。
- **测试会不会动我的 agy 授权？** 不会。`npm test` 默认零外部调用；真实 agy 端到端需要 `npm run test:agy` 显式开启。
- **Windows 可用吗？** 代码已含命名管道（`\\.\pipe\cli-bridge`）分支，但未在 Windows 上实测，欢迎反馈。
- **桥开机自启**：用系统守护机制托管 `cli-bridge start`（如 macOS launchd / systemd），桥自身不内置守护。
- **改完配置要重启**：`origins add`、端口/限流调整等改完后用 `cli-bridge restart`——进程内默认 SIGTERM 优雅关闭、5s 未退会 SIGKILL。stop/restart 只读 pid 文件，**不扫描进程、不按端口猜**——杀错进程的风险为零；旧版本实例（无 pid 文件）手动结束一次、升级后即生效。

## 给维护者：发布流程

```bash
# 1. 改 package.json 的 version（semver：修复→patch，新功能→minor）
# 2. 回归
npm test                          # 快速套件（默认不含真实 agy 调用）
CLI_BRIDGE_AGY_E2E=1 npm run test:agy   # 有 agy 环境时跑真实端到端
# 3. 打包自查
npm pack --dry-run                # 核对包内容（files 字段控制范围）
# 4. 发布（scoped 包已配置 publishConfig.access=public）
npm publish
# 5. 打 tag 推送
git tag v0.1.x && git push origin v0.1.x
```

## 测试

```bash
npm test              # 80 个用例，零外部依赖、零 agy 调用（约 12s，绝不会弹授权页）
npm run test:agy      # 显式运行真实 agy 端到端（原生 + OpenAI 双协议 + 多轮会话续聊）
npm run test:agy:image  # 再加图片生成 e2e（受 agy 图片配额影响）
```

零第三方依赖（Node 内置 `node:test`）。**默认测试不调用 agy**：真实 agy e2e 的沙箱环境在极端情况下（与正在运行的 agy 会话发生令牌轮换竞争）可能触发 agy 向浏览器弹 Google 授权页，因此设为显式开启。

## 目录

```
bin/cli-bridge.js        # 可执行入口
src/cli.js               # 命令行：start/stop/restart/tools/origins/token/config/doctor/run
src/core/                # config · tokens · runner · queue · runs · engine · sessions · audit
src/adapters/            # registry + agy/codex 声明
src/server/              # http（HTTP 通道）· uds（UDS 通道）· openai（OpenAI 兼容层）· body
public/index.html        # 桥自带控制台页（文本流式 / 多轮对话 / 图片生成）
test/                    # 测试（node:test）
docs/PROTOCOL.md         # 对外协议契约（原生 v1 + OpenAI 兼容层）
skills/cli-bridge/       # AI Agent Skill
DESIGN.md                # 整体设计
AGENTS.md                # AI 协作开发规范
```

> `HANDOFF.md`（内部交接文档）仅存在于本地工作区，不随仓库与 npm 包分发。

## 路线

- **v1（当前）**：双通道、适配器、配置系统、per-origin token、runs API + SSE、doctor、审计、Skill、多轮会话续聊（KV cache 复用）。
- **v1.1**：图片类适配器输出、流式输出、平台二进制、JS SDK。
- **v2**：自动配对页、per-token scope、MCP 网关、降权沙箱执行。
