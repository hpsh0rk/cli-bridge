---
name: cli-bridge
description: 通过本机 cli-bridge 守护进程统一调用用户已安装的 CLI AI 工具（agy、codex…）。当用户要让 AI Agent 使用 agy/codex 等本机命令行 AI 工具、或要求通过 cli-bridge 的统一受控入口（白名单 + 审计）调用时使用。
---

# cli-bridge · AI Agent 使用指南

cli-bridge 是跑在用户本机的受控桥：白名单 + 审计 + 固定命令模板。你是它的用户之一，
与"网页用户"共享同一个桥、同一套白名单与审计记录。

## 何时用

- 用户要求调用 agy / codex 等本机 CLI AI 工具，且本机有 cli-bridge；
- 用户明确要求通过统一受控入口调用（可审计、走白名单）。

如果用户只是想直接跑某个 CLI，直接执行该命令即可，不必绕道桥。

## 一次性准备（按序自检）

1. 探测桥是否在运行：
   ```bash
   cli-bridge doctor          # 或 node <仓库>/bin/cli-bridge.js doctor
   ```
2. 未运行则启动（后台常驻）：
   ```bash
   cli-bridge start
   ```
3. 确认目标工具已启用（doctor 输出 / `cli-bridge tools list`）。未启用时**先征求用户同意**再执行：
   ```bash
   cli-bridge tools allow agy
   ```

## 调用（首选 UDS 通道，免 token）

```bash
cli-bridge run agy "帮我总结这段文字：……"
# 原始信封（脚本处理用）：
cli-bridge run agy "…" --json
```

等价的 HTTP 形式（UDS 上免 token，适合编程调用）：

```bash
curl --unix-socket ~/.cli-bridge/bridge.sock \
  -X POST http://localhost/v1/tools/agy/run \
  -H 'Content-Type: application/json' \
  -d '{"input":"你好","wait":true}'
```

## 错误处理纪律（按 error.code）

| code | 你该做的 |
|---|---|
| `E_BUSY` (503) | 队列满，按 `retryAfterMs` 等待后重试 |
| `E_RATE_LIMIT` (429) | 同上，不要立即重试 |
| `E_TIMEOUT` (504) | 可重试一次；仍超时则报告用户，不要反复轰炸 |
| `E_TOOL_UNAVAILABLE` (503) | 工具未安装，把 `installHint` 转告用户 |
| `E_TOOL_DISABLED` (403) | 征求用户同意后 `cli-bridge tools allow <id>` |
| `E_AUTH` (401) | HTTP 通道 token 问题；改走 UDS 或让用户签发 token |
| 其他 | 原样报告，不要盲目重试 |

长任务：`"wait": false` 拿 runId，然后轮询 `GET /v1/runs/:runId` 或读 SSE `/v1/events?runId=`；需要中止时 `POST /v1/runs/:runId/cancel`。

## 红线

- 不要替用户修改 `origins`（来源白名单）或签发网页 token——那决定"哪个网站能用用户的工具"。
- 审计日志默认记录你的每次调用（时间/工具/状态/耗时），prompt 默认不落盘；不要建议用户关闭审计。
- 协议细节见 `docs/PROTOCOL.md`；错误码只按 code 分支，不要解析文案。
