# cli-bridge 通用 CLI 桥接器 · 整体设计

> 版本：v1 设计稿（2026-08）
> 上游原型：单工具 agy 验证版（已演进删除；实测结论沉淀在 `src/adapters/agy.js` 注释与本文档）
> 定位：一个跑在用户本机的守护进程，让**网页 / 本地程序 / AI Agent** 以统一、受控、可审计的方式调用用户已安装的命令行 AI 工具（agy、codex、claude、gemini…）。

---

## 1. 目标与非目标

**目标**

- 网站只需对接一份稳定的 HTTP 协议，不需要知道底层是哪个 CLI。
- 支持多个 CLI 工具，新增工具 = 增加一个适配器，不改核心。
- 所有"谁能调用、能调什么、能传什么"全部配置化，默认最小权限。
- 一套代码三种分发：npx 临时启动、全局 CLI 常驻、Skill 供 AI Agent 使用。
- 安全是一等公民：白名单 + token + 固化命令模板，网页永远碰不到 shell。

**非目标（v1 明确不做）**

- 不做云端中转/多用户服务——桥永远只服务"本机上的这个用户"。
- 不绑定 0.0.0.0 / 局域网暴露——v1 只有回环地址 + Unix Domain Socket。
- 不绕过浏览器的进程沙箱——"用户本地启动桥"是绕不过去的最小动作，围绕它优化体验而不是对抗它。

---

## 2. 总体架构

```
                         ┌────────────────────────────────────────────┐
  浏览器网页(https) ──▶  │  HTTP 通道  127.0.0.1:39487                │
  （你的域名/任意站点）   │  CORS 白名单 + per-origin token            │
                         │                                            │        ┌─────────┐
                         │  ┌────────────────────────────────────┐    │ spawn  │  agy    │
  本地 CLI / Agent  ──▶  │  │          核心（core）               │ ─────▶ ├─────────┤
  （cli-bridge run /    │  │  任务队列 · 限流 · 超时 · 审计日志    │        │  codex  │
    curl --unix-socket）│  │  配置存储 · token 存储 · 适配器注册表 │ ─────▶ ├─────────┤
                         │  └────────────────────────────────────┘        │  claude │
                         │  UDS 通道  ~/.cli-bridge/bridge.sock           │  gemini │
                         └────────────────────────────────────────────┘    └─────────┘
```

**一个守护进程，两条通道，一层核心，N 个适配器：**

| 通道 | 谁在用 | 鉴权方式 | 为什么 |
|---|---|---|---|
| HTTP（TCP 回环） | 浏览器网页 | CORS 白名单 + per-origin token + Host 校验 | 跨域网页不可信，需完整网络防线 |
| UDS（Unix socket / Windows 命名管道） | 本机 CLI、AI Agent（ZCode skill 等） | 文件权限（socket 目录 0700，无 token） | 本机文件系统权限即信任边界，免去 token 烦恼 |

核心只认"运行请求"这一个概念，通道层只做鉴权和传输。这样"方便其他人接入"的问题被拆成两个简单答案：**网页看协议（第 3 节），本机程序用 CLI/UDS（第 8 节）**。

---

## 3. 接入协议（对外契约 v1）

协议是这个项目的核心资产：版本化、稳定、自描述。任何网站或 Agent 只依赖本节。

### 3.1 统一响应信封

```jsonc
// 成功
{ "ok": true,  "data": { /* ... */ } }
// 失败
{ "ok": false, "error": { "code": "E_TOOL_DISABLED", "message": "工具 agy 未启用", "retryable": false } }
```

错误码枚举（稳定，接入方按 code 分支处理）：

| code | HTTP | 含义 |
|---|---|---|
| `E_AUTH` | 401 | token 缺失/无效/已吊销 |
| `E_ORIGIN` | 403 | Origin 不在白名单 |
| `E_TOOL_NOT_FOUND` | 404 | 适配器不存在 |
| `E_TOOL_DISABLED` | 403 | 工具存在但未在白名单启用 |
| `E_TOOL_UNAVAILABLE` | 503 | 二进制未安装或未登录（附 installHint） |
| `E_RATE_LIMIT` | 429 | 超过频控 |
| `E_BUSY` | 503 | 队列已满（附 retryAfterMs） |
| `E_TIMEOUT` | 504 | 工具执行超时 |
| `E_TOOL_FAILED` | 502 | 工具非成功退出（附 stderr 摘要） |
| `E_BAD_REQUEST` | 400 | 参数校验失败（附字段级 detail） |

### 3.2 端点

| 方法/路径 | 鉴权 | 说明 |
|---|---|---|
| `GET /v1/health` | 无 | `{ok, version, tokenRequired}`。**不泄露工具列表**，仅用于网页探测桥是否存在 |
| `GET /v1/tools` | token | 已启用适配器列表：`{id, displayName, capabilities:{text,image,stream}, optionsSchema, available}` |
| `POST /v1/tools/:id/run` | token | 发起运行（见下） |
| `GET /v1/runs/:runId` | token | 查询运行状态与结果（异步模式轮询用） |
| `POST /v1/runs/:runId/cancel` | token | 取消（杀进程组） |
| `GET /v1/events?runId=` | token | SSE 运行事件流（queued/running/output/succeeded/failed） |

`POST /v1/tools/agy/run` 请求体：

```jsonc
{
  "input": "你好",              // 必填，唯一的自由文本，只会进入 {input} 槽位
  "options": { "model": "..." }, // 可选，逐项过适配器 options 白名单校验
  "wait": true,                  // 默认 true 同步等待；false 返回 202 + runId
  "timeoutMs": 120000            // 可选，不超过适配器上限
}
```

同步成功响应：

```jsonc
{ "ok": true, "data": {
    "runId": "r_01J...", "status": "succeeded",
    "output": "你好！请问……",          // 已按适配器声明提取（如 agy 的 $.response）
    "meta": { "durationMs": 3062, "usage": { "total_tokens": 29148 }, "exitCode": 0 }
} }
```

### 3.3 网页接入标准流程（写入接入文档，所有站点照抄）

```
探测 /v1/health ──失败──▶ 引导页：展示 "npx cli-bridge start" 复制命令 / 二进制下载
      │成功                          （用户在终端启动后回到页面）
      ▼
用户点击「连接」◀── 必须在用户手势里发起首次真实请求（Chrome 142+ LNA 权限弹窗）
      │
   无 token? ──▶ 配对流程（§6.3），token 存 localStorage（按 origin 隔离）
      ▼
GET /v1/tools 拉能力 → POST /v1/tools/:id/run（长任务用 wait:false + SSE）
```

LNA 失败特征：`fetch` 抛 `TypeError: Failed to fetch` 且桥确实在跑 → 页面展示"请在浏览器弹窗中允许本地网络访问"并引导重试；iframe 场景加 `allow="local-network-access"`。官方 JS SDK（§8）封装以上全部，业务方一行接入。

---

## 4. 适配器模型与工具白名单

### 4.1 适配器声明（声明式，代码不拼命令行）

```jsonc
{
  "id": "agy",
  "displayName": "Antigravity CLI",
  "binary": "agy",
  "installHint": "参见 antigravity.google/docs/cli",
  "probe":   { "args": ["models"], "expectExit": [0] },          // doctor / available 探测
  "run": {
    "args": ["-p", "{input}", "--output-format", "json"],        // 模板固定；唯一变量 {input}
    "output": "json",                                            // json | text | ndjson
    "jsonResponsePath": "response",
    "jsonStatusPath": "status",
    "jsonStatusSuccess": ["SUCCESS"],
    "usagePath": "usage"
  },
  "capabilities": { "text": true, "image": false, "stream": false },
  "limits": { "timeoutMs": 300000, "concurrency": 1, "outputMaxBytes": 8388608 },
  "options": [                                                    // 页面可传的选项白名单，默认空
    { "name": "model", "flag": "--model", "type": "enum", "values": ["<模型列表>"] }
  ]
}
```

内置适配器：`agy`（已验证）、`codex`、`claude`、`gemini`。**codex/claude 的具体 flags（如 `codex exec --json`、`claude -p --output-format json`）实现时以各自 `--help` 实测为准**，本设计只锁定 schema 不锁定 flag。

### 4.2 四层白名单（安全核心，缺一不可）

| 层 | 白名单内容 | 默认值 | 谁能改 |
|---|---|---|---|
| ① 工具白名单 | 哪些 CLI 允许被调用 | **全关** | `cli-bridge tools allow agy`（本机交互确认） |
| ② 来源白名单 | 哪些网站 Origin 允许连接 | **空** | `cli-bridge origins add https://…`（须 https，需确认） |
| ③ 选项白名单 | 页面能覆盖哪些 flag/参数 | 空数组 | 适配器声明 + 配置覆盖 |
| ④ 命令模板固化 | 页面输入只能填 `{input}` 槽位 | 硬编码 | **任何配置都改不了**（无 shell、无字符串拼接、argv 数组直传） |

页面请求永远只能表达"用工具 X、输入 Y、在选项白名单内微调 Z"，不存在"执行任意命令"这个接口。恶意页面即使过了前三层，也只能得到"用 agy 跑一个 prompt"这一种能力。

---

## 5. 配置系统

### 5.1 解析优先级与安全不变量

```
内置默认 < ~/.cli-bridge/config.json < 环境变量 CLI_BRIDGE_* < CLI 显式 flags
```

**安全不变量（写死在代码里）：**

1. 配置只从 `~/.cli-bridge/` 读取，**永不读取当前工作目录下的配置文件**——防止恶意仓库/npm 包通过项目内配置文件削弱安全设置。
2. `origins` 增删必须走交互式 CLI 确认或配对流程，环境变量/env 只能"启动时临时放宽"，且启动横幅明确告警。
3. 配置文件权限 0600；写入一律经由 `cli-bridge config set`，保证 schema 校验。

### 5.2 配置 schema

```jsonc
// ~/.cli-bridge/config.json
{
  "server": { "port": 39487 },                 // host 恒为 127.0.0.1，不提供配置项
  "auth":   { "requireToken": true },
  "origins": ["https://your-domain.com"],
  "tools": {
    "allow": ["agy", "codex"],
    "overrides": { "agy": { "timeoutMs": 300000, "options": [] } }
  },
  "limits": { "runsPerMinute": 10, "queueDepth": 8, "maxBodyBytes": 1048576 },
  "log":    { "level": "info", "redactPrompts": true, "audit": true }
}
```

### 5.3 管理命令（配置即命令，命令即文档）

```
cli-bridge start [--port N] [--verbose]
cli-bridge tools list | allow <id> | deny <id>
cli-bridge origins list | add <url> | remove <url>
cli-bridge token list | create --origin <url> [--label] | revoke <tokenId>
cli-bridge config get <key> | set <key> <value>
cli-bridge doctor          # 逐工具探测二进制/登录态、端口占用、配置校验、浏览器连通自检
cli-bridge run <tool> <input>   # 本机快捷调用（走 UDS，等价 HTTP POST /run）
```

---

## 6. 认证与配对（安全设计重点）

### 6.1 威胁模型与对策

| 威胁 | 场景 | 对策（层层独立，单点失效不致沦陷） |
|---|---|---|
| 恶意网站探测并调用 | 任意网页对 127.0.0.1 扫端口、发简单请求 | ① token 必带（连 GET /v1/tools 都要）→ 简单请求天然失效；② 自定义头 `x-bridge-token` 强制预检 → 无白名单的 Origin 连预检都过不去；③ 频控兜底 |
| CORS 绕过读响应 | 页面用 no-cors/fire-and-forget | 读不到响应；且无 token 拒绝执行，请求无意义 |
| DNS rebinding | evil.com 解析到 127.0.0.1 | Host 头只接受 `127.0.0.1:port` / `localhost:port` |
| 恶意 iframe 借道 | 父页面白名单内，iframe 打手 | `x-bridge-token` 仍然必需；文档要求 iframe 场景单独授权 |
| 本地低权限进程 | 同机其他进程扫端口 | UDS 通道 0700 目录权限；HTTP 通道建议始终开 token（默认开） |
| 配置被篡改 | 恶意 repo / npm postinstall 写配置 | §5.1 不变量：只读 `~/.cli-bridge/`；写操作走交互 CLI |
| token 泄露 | localStorage 被 XSS 读走 | per-origin 绑定（token 只对签发时的 Origin 有效）；服务端存哈希；可随时 `token revoke` |
| 工具输出炸弹 | prompt 诱导工具输出超大内容 | outputMaxBytes 截断 + `truncated` 标记 |
| 供应链 | npx 拉到恶意版本 | 发布 npm provenance；文档建议锁版本 `npx cli-bridge@1.x`；二进制提供 checksum |

### 6.2 token 模型

- **per-origin**：`token create --origin https://site.com` 签发的 token 只在请求 `Origin` 匹配时有效。一个网站被吊销不影响其他网站。
- 服务端只存 SHA-256 哈希（`tokens.json` 0600），文件泄露不等于 token 泄露。
- 比较用恒定时间比较；只经 header 传递，永不出现在 URL（SSE 特例见 §3.2，用 fetch 流替代 EventSource 可避免 query 传 token）。
- 默认 `requireToken: true`——包括本机 HTTP 调用；本机程序走 UDS 免 token（文件权限即边界）。

### 6.3 配对流程（v1 手动，v2 自动）

**v1（剪贴板配对，零依赖）：**

```
网页「连接本地」→ 展示引导 → 用户终端执行 cli-bridge token create --origin https://site.com
→ CLI 打印并复制 token → 用户粘贴进网页输入框 → 网页验证(GET /v1/tools) → 存 localStorage
```

**v2（自动配对，目标体验）：** `cli-bridge pair` 打开桥自带的本地确认页 `http://127.0.0.1:PORT/pair?ot=一次性码`，页面展示"允许 https://site.com 连接？[允许/拒绝]"，确认后 302 到 `https://site.com/#bridge-token=…` 完成交换，并把该 origin 写入配置（等价 origins add）。一次性码 60 秒过期，防恶意页面抢先打开。

### 6.4 审计

每次 run 记录本地审计日志（默认开）：`时间 · origin(token 哈希前 8 位) · 工具 · 状态 · 耗时`。**默认不记录 prompt 内容**（`redactPrompts: true`），用户随时能回答"刚才哪个网站在用我的 agy"。

---

## 7. 执行与进程安全

- **spawn 规范**：`execFile`（argv 数组，无 shell、无拼接）；`{input}` 作为单个 argv 元素传入。
- **工作目录隔离**：每次 run 在 `~/.cli-bridge/workspace/<tool>/<runId>/` 下执行，工具写文件不会落进用户目录；任务结束可选清理（图片类适配器读取后保留）。
- **进程树管控**：超时/取消时杀整个进程组（detached + `process.kill(-pid)`），`windowsHide: true`。
- **环境变量**：继承用户环境（工具需要登录态），但不做任何"透传页面提供的环境变量"这种接口——页面无权触碰 env。
- **限流与队列**：per-token 令牌桶（默认 10 次/分钟）；per-tool 并发（agy=1）+ 全局队列深度，超出返回 `E_BUSY` + retryAfterMs。
- **降权执行（v2，可选）**：macOS `sandbox-exec` / Linux bubblewrap 包裹工具进程，适配器声明是否支持（agy 自带 `--sandbox` flag，直接映射）。

---

## 8. 分发与接入方式

一套代码（npm 包 `cli-bridge`，零第三方依赖），三个出口：

| 出口 | 形态 | 用户动作 | 适用 |
|---|---|---|---|
| **npx** | `npx cli-bridge@1 start` | 复制一条命令 | 网站引导页首选；临时使用 |
| **CLI** | 全局安装 `npm i -g cli-bridge` / 平台二进制（Bun compile，GitHub Releases + checksum） | 装一次常驻/开机自启 | 重度用户 |
| **Skill** | `skills/cli-bridge/SKILL.md` | 交给 AI Agent 安装使用 | ZCode/Claude 等 Agent 场景 |

**Skill 的定位**：让 AI Agent 成为桥的用户之一。SKILL.md 教 Agent 三件事：
1. 用 `cli-bridge doctor` / `cli-bridge start` 帮用户装好、起好桥；
2. 用 `cli-bridge run agy "…"`（UDS 通道，免 token）直接调用工具；
3. 遵守协议错误码处理（`E_BUSY` 重试、`E_TIMEOUT` 取消）。
这样"网页用户"和"Agent 用户"共享同一个桥、同一套白名单与审计。

**JS SDK（可选发布 `@scope/bridge-client`，约 2KB）**：封装探测、LNA 重试、配对、SSE，站点侧最终形态是：

```js
const bridge = new BridgeClient();               // 默认 127.0.0.1:39487，自动读 localStorage token
await bridge.ensureConnected();                  // 失败 → 返回引导信息（npx 命令/下载页）
const r = await bridge.run('agy', '你好', { onEvent: e => render(e) });
```

**接入方只需要三样东西**：协议文档（§3）+ 固定默认端口 + `tools allow` 的一次性配置。适配器内部细节对接入方完全不可见。

---

## 9. 代码结构与技术选型

```
cli-bridge/                      # 新包（原 agy-web-bridge 保留为原型参考）
├── package.json                 # bin: cli-bridge；零 dependencies；engines >= 18
├── bin/cli-bridge.js
├── src/
│   ├── cli.js                   # 命令解析：start/pair/tools/origins/token/config/doctor/run
│   ├── server/
│   │   ├── http.js              # HTTP 通道 + 中间件链（host→cors→auth→ratelimit→route）
│   │   └── uds.js               # UDS/命名管道通道
│   ├── core/
│   │   ├── runner.js            # execFile、进程组、超时、输出截断
│   │   ├── queue.js             # per-tool 并发 + 全局队列 + 频控
│   │   ├── config.js            # 配置加载/校验/写入（含安全不变量断言）
│   │   └── audit.js
│   ├── adapters/
│   │   ├── registry.js          # 内置注册表 + schema 校验
│   │   ├── agy.js  codex.js  claude.js  gemini.js
│   └── pairing/pair-page.js     # v2 本地确认页
├── skills/cli-bridge/SKILL.md
└── docs/PROTOCOL.md             # §3 的完整规范（对外发布的契约）
```

选型理由：**零依赖纯 Node ESM**——npx 安装体积小、可审计性强（供应链是本项目的威胁面之一）、无框架升级负担。协议先行，SDK/二进制后置。

---

## 10. 演进路线

| 阶段 | 内容 |
|---|---|
| **v1（可用版）** | 双通道、适配器（agy 实测 + codex/claude 实测 flags）、配置系统、per-origin token、runs API + 轮询、doctor、审计日志、npm 分发、Skill |
| **v1.1** | 图片类适配器（`imageOutputDir` 读取 → base64/文件返回）、SSE 流式输出、平台二进制分发、JS SDK |
| **v2** | 自动配对页、per-tool scope（token 只能调部分工具）、本地确认 UI（高危工具弹出系统通知确认）、MCP 网关暴露（让任意 MCP 客户端调用桥）、降权沙箱执行 |

---

## 附：本设计与调研结论的对应关系

- 浏览器进程沙箱不可绕 → 保留"用户本地启动桥"为唯一安装动作，npx/二进制/Skill 全部围绕它优化。
- Chrome 142+ LNA 权限 → §3.3 用户手势内首次请求 + 失败引导模式，写入协议文档与 SDK。
- localhost 不算混合内容 → https 站点可直连 http://127.0.0.1，无需桥端 TLS。
- 端口扫描被禁/恶意站点滥用 → 固定默认端口 + 四层白名单 + per-origin token。
