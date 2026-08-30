/**
 * codex 适配器。
 *
 * ⚠ 未实测：本机未安装 codex，flags 按官方文档声明（codex exec --json 输出 JSONL 事件），
 * 未经端到端验证。安装后如果输出解析失败，无需改代码——在 ~/.cli-bridge/config.json 的
 * adapters 段覆盖 run.args / 解析路径即可，例如：
 *   { "adapters": { "codex": { "run": { "args": ["exec", "{input}"], "output": "text" } } } }
 * 二进制装好后 available 会自动变为 true。
 */
export default {
  id: 'codex',
  displayName: 'OpenAI Codex CLI',
  binary: 'codex',
  untested: true,
  installHint: 'npm i -g @openai/codex',
  probe: { args: ['--version'], expectExit: [0] },
  run: {
    args: ['exec', '--json', '--skip-git-repo-check', '{input}'],
    output: 'ndjson',
    ndjsonPick: { type: 'item.completed', 'item.item_type': 'agent_message' },
    ndjsonTextPath: 'item.text',
  },
  capabilities: { text: true, image: false, stream: false },
  limits: { timeoutMs: 300000, concurrency: 1, outputMaxBytes: 8388608 },
  options: [],
};
