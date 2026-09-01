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
 * 图片（实测注意，2026-08-31 复核）：generate_image 产物写进会话 brain 目录
 *   （~/.gemini/antigravity-cli/brain/<conversation_id>/，conversation_id 即 stdout JSON 里的会话 id），
 *   不再落盘 cwd（8/30 的旧实测结论已失效）——桥据 image.searchDirs 扫描 brain 会话目录收割，
 *   按 mtime 晚于 run 开始过滤，避免误收旧会话产物。该工具可能瞬时失败（疑配额限流），
 *   失败时 agent 会转入无效 shell 兜底——桥据 image.toolName 快速失败；
 *   成功时进程可能挂住不退出，桥按"文件稳定即收割"处理。
 *   文件写入需要 --dangerously-skip-permissions（非交互模式下无法响应权限询问）。
 *
 * 多轮会话（实测 2026-08-31）：`--conversation <id>` 续聊指定会话，stdout JSON 与 stream-json
 *   的 result/init 事件都带 conversation_id。续聊轮上游复用 prompt cache（KV cache）——
 *   实测第二轮 input_tokens 33981 中 cache_read_tokens 24480。注意 usage 口径：
 *   input_tokens 不含缓存命中部分（两者相加才是完整 prompt），result.usage 是会话累计值。
 *   续聊不存在的会话 id 不报错：stderr 警告后开新会话（上下文丢失但仍 SUCCESS）。
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
    jsonConversationIdPath: 'conversation_id',
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
      conversationIdPath: 'result.conversation_id',
    },
  },
  image: {
    extraArgs: ['--dangerously-skip-permissions'],
    extensions: ['.png', '.jpg', '.jpeg', '.webp'],
    fileStableMs: 2000,
    toolName: 'generate_image',
    searchDirs: ['~/.gemini/antigravity-cli/brain'],
  },
  capabilities: { text: true, image: true, stream: true, conversation: true },
  limits: { timeoutMs: 300000, concurrency: 1, outputMaxBytes: 8388608 },
  options: [{ name: 'conversationId', flag: '--conversation', type: 'string' }],
};

