/**
 * agy 适配器。以下均在本机实测（2026-08-30）：
 *
 * 非交互（v1 基线）：`agy -p "<prompt>" --output-format json`
 *   → stdout JSON { conversation_id, status:"SUCCESS", response, duration_seconds, usage }
 *
 * 流式（OpenAI 兼容层）：`--output-format stream-json` 输出 NDJSON 事件：
 *   {"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"…"}} 增量文本
 *   {"event":"result","result":{"status":"SUCCESS","response":"…","usage":{…}}}          最终结果
 *
 * 图片（实测注意）：agent 调 generate_image 工具产出图片落盘 cwd；该工具可能瞬时失败
 *   （疑配额限流，实测 3 次调用 1 成功 2 失败），失败时 agent 会转入无效 shell 兜底——
 *   桥据 image.toolName 快速失败；成功时进程可能挂住不退出，桥按"文件稳定即收割"处理。
 *   文件写入需要 --dangerously-skip-permissions（非交互模式下无法响应权限询问）。
 */
export default {
  id: 'agy',
  displayName: 'Antigravity CLI',
  binary: 'agy',
  installHint: '安装 Antigravity CLI 并登录（参见 antigravity.google/docs/cli）',
  probe: { args: ['models'], expectExit: [0] },
  run: {
    args: ['-p', '{input}', '--output-format', 'json'],
    output: 'json',
    jsonResponsePath: 'response',
    jsonStatusPath: 'status',
    jsonStatusSuccess: ['SUCCESS'],
    usagePath: 'usage',
  },
  stream: {
    args: ['-p', '{input}', '--output-format', 'stream-json'],
    deltas: { when: { event: 'step_update', 'step_update.step_type': 'agent_response' }, path: 'step_update.text_delta' },
    final: {
      when: { event: 'result' },
      outputPath: 'result.response',
      statusPath: 'result.status',
      successValues: ['SUCCESS'],
      usagePath: 'result.usage',
    },
  },
  image: {
    extraArgs: ['--dangerously-skip-permissions'],
    extensions: ['.png', '.jpg', '.jpeg', '.webp'],
    fileStableMs: 2000,
    toolName: 'generate_image',
  },
  capabilities: { text: true, image: true, stream: true },
  limits: { timeoutMs: 300000, concurrency: 1, outputMaxBytes: 8388608 },
  options: [],
};

