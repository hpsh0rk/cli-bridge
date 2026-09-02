# cli-bridge 接入协议 v1

> 版本：1.1（稳定契约）· 更新时间：2026-08-31
> 适用：cli-bridge v0.4.x。协议按语义版本演进：v1 内只增不改——新增字段与错误码向后兼容，破坏性变更会升主版本并保留旧版端点。
>
> 接入方只需要本文件 + 固定默认端口（39487）+ 一次性 `tools allow` 配置。底层是 agy、codex 还是任何其他 CLI，对接入方完全不可见。

---

## 1. 总览

cli-bridge 是跑在用户本机的守护进程，暴露两条通道：

| 通道 | 地址 | 谁用 | 鉴权 |
|---|---|---|---|
| HTTP | `http://127.0.0.1:39487`（仅回环） | 浏览器网页 | CORS 来源白名单 + per-origin token（`x-bridge-token` 头）+ Host 校验 |
| UDS | `~/.cli-bridge/bridge.sock`（Windows：命名管道 `\\.\pipe\cli-bridge`） | 本机程序 / curl / AI Agent | 文件权限（目录 0700），免 token |

两条通道使用同一份协议（下文全部端点在 UDS 上同样可用，且免 token）。

```bash
# UDS 调用示例
curl --unix-socket ~/.cli-bridge/bridge.sock http://localhost/v1/tools
```

## 2. 统一响应信封与错误码

```jsonc
// 成功
{ "ok": true,  "data": { /* ... */ } }
// 失败
{ "ok": false, "error": { "code": "E_TOOL_DISABLED", "message": "工具 agy 未启用", "retryable": false } }
```

接入方按 `error.code` 分支处理，不要解析 `message`（文案可能变化）。`retryable: true` 的错误可在等待 `retryAfterMs`（如有）后重试。

| code | HTTP | 含义 | 附加字段 |
|---|---|---|---|
| `E_AUTH` | 401 | token 缺失/无效/与来源不匹配/已吊销 | — |
| `E_ORIGIN` | 403 | Origin 不在白名单，或 Host 非法（防 DNS rebinding） | — |
| `E_TOOL_NOT_FOUND` | 404 | 适配器不存在 | — |
| `E_TOOL_DISABLED` | 403 | 工具存在但未在白名单启用 | — |
| `E_TOOL_UNAVAILABLE` | 503 | 二进制未安装或不可执行 | `installHint` |
| `E_RATE_LIMIT` | 429 | 超过频控（默认 10 次/分钟 per token） | `retryAfterMs` |
| `E_BUSY` | 503 | 任务队列已满（默认深度 8） | `retryAfterMs` |
| `E_TIMEOUT` | 504 | 工具执行超时（进程组已被终止） | `durationMs` |
| `E_TOOL_FAILED` | 502 | 工具非成功退出或输出无法解析 | `exitCode`、`stderrTail`（≤500 字符）、`durationMs` |
| `E_BAD_REQUEST` | 400 | 参数校验失败（含请求体超限/非法 JSON） | `detail: [{field, problem}]` |
| `E_CANCELLED` | 409 | 运行被 `POST /runs/:id/cancel` 取消 | `durationMs` |
| `E_NOT_FOUND` | 404 | 运行记录不存在或已过保留期（10 分钟） | — |
| `E_INTERNAL` | 500 | 桥内部错误 | — |

> 注：`E_CANCELLED` / `E_NOT_FOUND` / `E_INTERNAL` 是 v1 实现对设计稿错误码表的补充，同样遵循"只增不改"。

## 3. 鉴权规则

- token 只经请求头传递（`x-bridge-token: <token>`，兼容 `Authorization: Bearer <token>`），**永不出现在 URL**。
- **per-origin 绑定**：浏览器跨域请求恒带 `Origin`，token 只在 `Origin` 与签发时 origin 完全一致时有效。
- **无 Origin 的本机 HTTP 客户端**（curl、脚本、Agent）只能使用 `cli-bridge token create --origin local` 签发的 token。走 UDS 则完全免 token（推荐）。
- **桥自带演示页（`GET /`）**：桥自身同源请求（Origin 为 `http://127.0.0.1:PORT` / `http://localhost:PORT`）豁免来源白名单（同源本不受 CORS 约束），token 仍必填且按 local 规则校验。其他任何 http 来源不享受豁免。
- token 由用户在本机终端签发并粘贴进网页（v1 配对流程）；服务端只存 SHA-256 哈希，可随时 `token revoke`。
- `GET /v1/health` 无需鉴权，且响应恒带 `Access-Control-Allow-Origin: *`——首次探测发生在 `origins add` 之前，若按白名单给 CORS，非白名单页面会读不到响应（fetch 抛 `TypeError`），检测永远失败。

## 4. 端点

### 4.1 `GET /v1/health`（无鉴权）

```jsonc
{ "ok": true, "version": "0.1.0", "tokenRequired": true }
```

只用于探测桥是否存在与鉴权策略，**不泄露工具列表**。

### 4.2 `GET /v1/tools`（需 token）

```jsonc
{ "ok": true, "data": [
  {
    "id": "agy",
    "displayName": "Antigravity CLI",
    "capabilities": { "text": true, "image": false, "stream": false, "conversation": false },
    "optionsSchema": [],               // 页面可传的选项白名单（如 agy 的 conversationId）
    "available": true,                 // 二进制是否已安装
    "installHint": "…",                // 仅 available=false 时出现
    "untested": true                   // 仅声明未实测的适配器出现（如 codex）
  }
] }
```

只返回白名单内启用的工具。`capabilities.conversation` 为 true 表示该工具支持多轮会话续聊（OpenAI 兼容层自动使用，见 §7.2）。

### 4.3 `POST /v1/tools/:id/run`（需 token）

请求体：

```jsonc
{
  "input": "你好",              // 必填，非空字符串；唯一的自由文本，只会填入工具命令模板的 {input} 槽位
  "options": { "conversationId": "…" }, // 可选；逐项过该工具的选项白名单，白名单外的键直接 400。
                                 // agy 支持 conversationId（映射为 --conversation，续聊指定会话）
  "wait": true,                 // 默认 true 同步等待；false → 202 + runId（异步）
  "timeoutMs": 120000           // 可选整数，不超过适配器上限（超出 → 400）
}
```

同步成功（200）：

```jsonc
{ "ok": true, "data": {
    "runId": "r_01J…", "status": "succeeded",
    "output": "你好！请问……",      // 工具输出按适配器声明提取
    "meta": { "durationMs": 3062, "exitCode": 0, "usage": { "total_tokens": 29148 },
              "conversationId": "025a193f…" }   // 工具会话 id（仅声明会话能力的工具有）；可回填到 options.conversationId 实现多轮续聊
} }
```

同步失败：错误信封（§2），HTTP 状态码随错误码。

异步提交成功（**202**）：

```jsonc
{ "ok": true, "data": { "runId": "r_01J…", "status": "queued" } }
```

### 4.4 `GET /v1/runs/:runId`（需 token）

```jsonc
{ "ok": true, "data": {
    "runId": "r_01J…", "tool": "agy",
    "status": "succeeded",           // queued | running | succeeded | failed | timeout | cancelled
    "createdAt": "2026-08-30T…",
    "events": [ { "type": "queued", "ts": 1756500000000 }, … ],
    "output": "…",                   // 终态为 succeeded 时
    "meta": { … },                   // 同上
    "error": { "code": "…", "message": "…", "retryable": false }  // 失败类终态时
} }
```

终态记录保留 10 分钟，之后返回 `E_NOT_FOUND`。

### 4.5 `POST /v1/runs/:runId/cancel`（需 token）

杀整个工具进程组。返回 `{ "ok": true, "data": { "runId": "…", "status": "cancelling" | "cancelled" | "<已终态>" } }`。幂等：对已终态运行重复调用返回其当前状态。

### 4.6 `GET /v1/events?runId=`（需 token，SSE）

`text/event-stream`。每条事件：

```
event: running
data: {"type":"running","ts":1756500000000}
```

事件序列：`queued` → `running` → `succeeded` | `failed` | `timeout` | `cancelled`（失败类终态的 data 含 `error`）。连接建立时先补发已发生的事件；终态后服务端关闭流；每 15s 发送心跳注释 `: ping`。

> 不用 `EventSource`（它无法带自定义请求头），用 `fetch` 读取响应流。

## 5. 浏览器接入标准流程

> **零配置的浏览器验证**：直接打开桥自带的控制台 `http://127.0.0.1:39487/`——同源请求，无跨域与 LNA 问题，粘贴 local token 即可运行/取消。下文流程针对**部署在外部 https 站点**的页面。

```
探测 GET /v1/health ──失败──▶ 引导页：展示 "npx @sh0rk/cli-bridge start" 复制命令
      │成功                     （用户在终端启动后回到页面重试）
      ▼
「连接」按钮（必须在用户点击手势里发起首次真实请求；Chrome 142+ 会弹
  "本地网络访问" 权限，拒绝后 fetch 抛 TypeError: Failed to fetch）
      │
   401? ──▶ 配对：引导用户在终端执行
            cli-bridge token create --origin https://你的域名
            → 粘贴 token → GET /v1/tools 验证 → 存 localStorage（按 origin 隔离）
      ▼
GET /v1/tools 拉能力 → POST /v1/tools/:id/run
（长任务用 wait:false + 轮询 /v1/runs/:id 或 SSE /v1/events）
```

注意事项：

- https 页面直连 `http://127.0.0.1` 不算混合内容（localhost 是 potentially trustworthy origin），桥端无需 TLS。
- 桥必须先把你的站点加入来源白名单：本机执行 `cli-bridge origins add https://你的域名`（仅 https）。
- LNA 失败特征：`fetch` 抛 `TypeError: Failed to fetch` 且桥确实在跑 → 展示"请在浏览器弹窗中允许本地网络访问"；iframe 场景需 `allow="local-network-access"`。
- 预检：请求头含 `x-bridge-token` 的跨域请求会触发 CORS 预检；Origin 不在白名单时连预检都过不去（403），这是设计行为。

### 5.1 最小可用网页代码

```js
const BASE = 'http://127.0.0.1:39487';
const token = localStorage.getItem('bridge-token');

async function connect() {
  const health = await fetch(`${BASE}/v1/health`).then(r => r.json()).catch(() => null);
  if (!health?.ok) throw new Error('桥未运行，请在终端执行 npx @sh0rk/cli-bridge start');
  const tools = await fetch(`${BASE}/v1/tools`, { headers: { 'x-bridge-token': token } });
  if (tools.status === 401) throw new Error('需要配对 token');
  return tools.json();
}

async function run(toolId, input) {
  const res = await fetch(`${BASE}/v1/tools/${toolId}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-bridge-token': token },
    body: JSON.stringify({ input, wait: true }),
  }).json();
  if (!res.ok) throw new Error(`${res.error.code}: ${res.error.message}`);
  return res.data.output;
}
```

## 6. 安全模型（接入方须知）

- 网页永远只能表达"用工具 X、输入 Y、在选项白名单内微调 Z"，不存在执行任意命令的接口；命令模板在桥端硬编码，`{input}` 是唯一自由文本槽位。
- 桥只绑回环地址；Host 头校验防 DNS rebinding。
- 所有运行落审计日志（时间 · 来源 · token 哈希前 8 位 · 工具 · 状态 · 耗时），默认不记录 prompt 内容。
- token 泄露的爆炸半径被 per-origin 绑定限制在被授权的那个站点；可在本机随时吊销。

---

## 7. OpenAI 兼容层

让 OpenAI SDK / 聊天前端把 `base_url` 指到 `http://127.0.0.1:39487/v1` 即可无缝接入（api_key 填桥 token，走 `Authorization: Bearer`）。鉴权、来源白名单、频控、队列、审计与原生端点完全一致；错误响应用 OpenAI 信封 `{"error":{message,type,param,code}}`，`code` 为 §2 的错误码，`type` 按 OpenAI 语义映射（`invalid_request_error` / `authentication_error` / `rate_limit_error` / `api_error`）。

### 7.1 `GET /v1/models`

```jsonc
{ "object": "list", "data": [ { "id": "agy", "object": "model", "created": 0, "owned_by": "cli-bridge" } ] }
```

### 7.2 `POST /v1/chat/completions`

请求同 OpenAI：`model`（= 工具 id）、`messages`、`stream`、`stream_options.include_usage`；`temperature` 等其余参数静默忽略。请求体上限：chat 端点为 `max(config.limits.maxBodyBytes, 20MB)`（图片 data URL 内联需要大请求体，其余端点仍按全局配置）。

- **model 斜杠约定（v0.5.0 新增）**：`"<toolId>/<cliModel>"`（如 `"agy/claude-sonnet-4-6"`）→ 调用该工具并透传 `--model <cliModel>`（工具须在选项白名单声明 `model`）；前缀不是已知工具 id 时整体视为 toolId（保持旧行为）。响应与流式块回显客户端请求的原始 model 字符串。
- **图片附件 / vision 输入（v0.5.0 新增）**：message `content` 数组支持 `{type:"image_url", image_url:{url:"data:image/png;base64,…"}}` 分段（OpenAI 多模态格式）。
  - 仅接受 **data URL 内联**；http(s) 外链一律 400（UDS 通道按本机信任域设计，桥不做任意出网抓取）。
  - **仅支持单轮**：messages 中含 assistant 历史时带图片直接 400（图片进会话前缀键会破坏续聊语义）。
  - 桥把图片写入 run 工作目录 `attachments/` 子目录，输入文本末尾追加绝对路径清单（agy 实测相对路径会被解析到 $HOME）；适配器以 `attachments` 能力声明（扩展名/数量/单文件上限/extraArgs——agy 带附件时自动挂 `--dangerously-skip-permissions`，非交互下文件读取权限默认 deny）。附件目录与图片收割隔离，不会被误认成生成产物。
- **`response_format`（v0.5.0 新增）**：`{type:"json_schema", json_schema:{name, schema}}` → 透传工具的 `--json-schema`（agy 在 stream-json 模式作用于最终 result）；其余取值静默忽略。
- **messages → input 映射（多轮会话续聊）**：
  - **首轮 / 单轮**：无 assistant 消息时 system 原样前置、用户内容直传，不加标签；content 支持分段数组（取 text 部分）。
  - **多轮自动续聊**：请求历史含 assistant 回复、且新增的是末条 user 消息时，桥按「对话前缀 → 工具会话」映射查上一轮的会话 id——命中则**只把新增消息发给 CLI**（如 agy 的 `--conversation <id>` 续聊），上游 prompt cache（KV cache）因此复用，token 花费显著降低（实测 agy 续聊轮 input 33981 中 24480 来自缓存）；未命中（首轮多轮、历史被编辑/分支、映射过期）回退为带角色标签的整段转写（`System: …\n\nUser: …\n\nAssistant: …`），行为退化为 v1 基线。
  - 会话映射由桥在服务端维护（LRU 200 条、2 小时过期），接入方**零改动**即可受益；多轮聊天前端照常每轮重发完整 messages 即可。
  - 已知退化：工具侧会话被清理时，续聊轮会在新会话上进行（该轮上下文缺失但请求成功），桥会把新会话 id 登记进映射，后续轮次继续链接。
- **响应桥扩展字段**：顶层（同步）与 stop / usage 块（流式）带 `bridge_conversation_id`（本轮所属工具会话 id），供接入方观测续聊是否生效；OpenAI 客户端会忽略未知字段。
- **usage 映射**：`usage` 由工具上报映射——`prompt_tokens = input_tokens + cache_read_tokens`（OpenAI 语义 prompt 含缓存命中部分）、`completion_tokens = output_tokens`、`total_tokens` 为完整总量；缓存命中时附 `prompt_tokens_details.cached_tokens`。注意工具侧 `result.usage` 为会话累计值，续聊轮的数字会随轮次增长。
- **同步响应**：标准 `chat.completion` 对象。
- **流式响应**（SSE，`Content-Type: text/event-stream`）：`chat.completion.chunk` 序列 —— 首块 `delta:{role:"assistant"}`（含**桥扩展字段 `bridge_run_id`**，OpenAI 客户端会忽略；接入方可用它调 `POST /v1/runs/:id/cancel` 取消流式运行）→ 若干 `delta:{content}`（**真增量**，来自 CLI 的流式输出）→ `finish_reason:"stop"`（含 `bridge_conversation_id`）→ `include_usage` 时追加 `choices:[]` 的用量块 → `data: [DONE]`。中途失败发 `data:{"error":{…}}` 后仍以 `[DONE]` 收尾。
- 流式能力由适配器声明（agy 经 `--output-format stream-json` 实测为真增量）。

### 7.3 `POST /v1/images/generations`

请求同 OpenAI Images：`model`（须为声明了 image 能力的工具）、`prompt`、可选 `response_format`（`"b64_json"` 默认 / `"url"`）、`n`（**仅支持 1**）；`size`/`quality` 等静默忽略（CLI 不保证精确尺寸）。请求体上限与 chat 同口径（托底 20MB）。

- **参考图 / i2i（v0.5.0 新增）**：可选 `image` 字段（data URL 字符串或其数组）→ 走附件管线：落盘 run 工作目录 `attachments/` 子目录，prompt 末尾追加绝对路径清单与「先 view_file 查看参考图、新图延续其视觉风格」指令；工具侧自行决定如何消费参考（agy 实测：agent 读图后调 generate_image，风格迁移成立）。仅接受 data URL 内联；数量/大小受适配器 `attachments` 能力约束。

```jsonc
// 响应
{ "created": 1788099000, "data": [ { "b64_json": "iVBOR…" } ] }
// response_format:"url" 时
{ "created": 1788099000, "data": [ { "url": "http://127.0.0.1:39487/v1/files/agy/r_01J…/image.png" } ] }
```

- 实现机制：桥在隔离工作目录中驱动工具生成并把图片**落盘收割**（文件出现且尺寸稳定即视为完成，进程是否退出不重要）；适配器可用 `image.searchDirs` 声明额外语境目录（如 agy 的 brain 会话目录——新版 `generate_image` 把产物写进 `~/.gemini/antigravity-cli/brain/<会话 id>/` 而非工作目录；claude 系模型实测写 `~/.gemini/antigravity-cli/scratch/`，均已收录），桥会一并扫描并把命中文件复制回工作目录，只认 mtime 晚于本次运行开始的文件，避免误收历史产物（run 工作目录的 `attachments/` 子目录不在扫描范围，参考图不会被误收成产物）；适配器可声明图片生成工具名，该工具报错时桥快速失败返回 `E_TOOL_FAILED`（附 detail），不空耗超时。
- `url` 模式指向 `GET /v1/files/:tool/:runId/:file`，**需要 token 请求头**，因此 `<img>` 标签无法直接引用——浏览器展示请用 `b64_json`（data URI）；url 适合程序化下载。
- 生成耗时波动大（数秒到数分钟），且依赖工具自身的图像能力与配额（agy 的 `generate_image` 实测存在配额限制）；失败会带明确错误信息，可稍后重试。
- CORS 契约：OpenAI 兼容层（含 `/v1/models`、`/v1/chat/completions`、`/v1/images/generations`）的**成功与错误响应**都会带来源白名单的 CORS 头——错误信封必须让跨域页面读到，否则浏览器拦截响应、`fetch` 只抛 `TypeError`（表现为 HTTP 0），接入方拿不到真实错误码。
