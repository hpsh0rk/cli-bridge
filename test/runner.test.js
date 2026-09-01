import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execAdapter, killProcessTree } from '../src/core/runner.js';
import { BridgeError } from '../src/errors.js';
import { useTempHome, FAKE_CODE } from './helpers.js';
import { workspaceRoot } from '../src/core/config.js';

const CAPS = { text: true, image: false, stream: false };
const LIMITS = { timeoutMs: 300000, concurrency: 1, outputMaxBytes: 8388608 };

function jsonDecl(overrides = {}) {
  return {
    id: 'fake',
    displayName: 'Fake',
    binary: process.execPath,
    run: {
      args: ['-e', FAKE_CODE, '{input}'],
      output: 'json',
      jsonResponsePath: 'response',
      jsonStatusPath: 'status',
      jsonStatusSuccess: ['SUCCESS'],
      usagePath: 'usage',
    },
    capabilities: CAPS,
    limits: LIMITS,
    options: [],
    ...overrides,
  };
}

test('json 输出：提取 response 与 usage；{input} 经 argv 传入', async (t) => {
  useTempHome(t);
  const r = await execAdapter({ decl: jsonDecl(), input: 'hello', options: {}, timeoutMs: 30000, runId: 'r1' });
  assert.equal(r.output, 'echo:hello');
  assert.equal(r.meta.exitCode, 0);
  assert.deepEqual(r.meta.usage, { total_tokens: 7 });
  // workspace 隔离目录被创建在沙箱 HOME 下
  assert.ok(fs.existsSync(path.join(workspaceRoot(), 'fake', 'r1')));
});

test('非成功退出码 → E_TOOL_FAILED（附 stderr 摘要）', async (t) => {
  useTempHome(t);
  await assert.rejects(
    () => execAdapter({ decl: jsonDecl(), input: '__fail__', options: {}, timeoutMs: 30000, runId: 'r2' }),
    (e) => e instanceof BridgeError && e.code === 'E_TOOL_FAILED' && /boom/.test(e.extra.stderrTail) && e.extra.exitCode === 3
  );
});

test('超时：终止进程组并抛 E_TIMEOUT（可重试）', async (t) => {
  useTempHome(t);
  const started = Date.now();
  await assert.rejects(
    () => execAdapter({ decl: jsonDecl(), input: '__slow__', options: {}, timeoutMs: 300, runId: 'r3' }),
    (e) => {
      assert.ok(e instanceof BridgeError && e.code === 'E_TIMEOUT' && e.toEnvelope().error.retryable === true);
      assert.ok(Date.now() - started < 5000, '应在超时点附近返回而不是等满挂起时间');
      return true;
    }
  );
});

test('二进制缺失 → E_TOOL_UNAVAILABLE（附 installHint）', async (t) => {
  useTempHome(t);
  await assert.rejects(
    () => execAdapter({ decl: jsonDecl({ binary: 'definitely-missing-bin-xyz', installHint: '装一下' }), input: 'x', options: {}, timeoutMs: 5000, runId: 'r4' }),
    (e) => e instanceof BridgeError && e.code === 'E_TOOL_UNAVAILABLE' && e.extra.installHint === '装一下'
  );
});

test('text 输出：原样返回 stdout', async (t) => {
  useTempHome(t);
  const decl = jsonDecl({
    run: { args: ['-e', 'process.stdout.write("plain:" + process.argv[1])', '{input}'], output: 'text' },
  });
  const r = await execAdapter({ decl, input: 'hi', options: {}, timeoutMs: 30000, runId: 'r5' });
  assert.equal(r.output, 'plain:hi');
});

test('ndjson 输出：取最后一条匹配事件', async (t) => {
  useTempHome(t);
  const script = `console.log(JSON.stringify({type:"started"}));console.log(JSON.stringify({type:"item.completed",item:{item_type:"agent_message",text:"final answer"}}));`;
  const decl = jsonDecl({
    run: {
      args: ['-e', script, '{input}'],
      output: 'ndjson',
      ndjsonPick: { type: 'item.completed', 'item.item_type': 'agent_message' },
      ndjsonTextPath: 'item.text',
    },
  });
  const r = await execAdapter({ decl, input: 'x', options: {}, timeoutMs: 30000, runId: 'r6' });
  assert.equal(r.output, 'final answer');
});

test('输出截断：超过 outputMaxBytes 截断并标记', async (t) => {
  useTempHome(t);
  const decl = jsonDecl({
    run: { args: ['-e', 'process.stdout.write("x".repeat(100))', '{input}'], output: 'text' },
    limits: { ...LIMITS, outputMaxBytes: 16 },
  });
  const r = await execAdapter({ decl, input: 'x', options: {}, timeoutMs: 30000, runId: 'r7' });
  assert.equal(r.output.length, 16);
  assert.equal(r.meta.truncated, true);
});

test('状态非 SUCCESS → E_TOOL_FAILED', async (t) => {
  useTempHome(t);
  const script = `console.log(JSON.stringify({status:"ERROR",response:"bad thing happened"}));`;
  const decl = jsonDecl({ run: { args: ['-e', script, '{input}'], output: 'json', jsonResponsePath: 'response', jsonStatusPath: 'status', jsonStatusSuccess: ['SUCCESS'] } });
  await assert.rejects(
    () => execAdapter({ decl, input: 'x', options: {}, timeoutMs: 30000, runId: 'r8' }),
    (e) => e instanceof BridgeError && e.code === 'E_TOOL_FAILED' && /ERROR/.test(e.message) && /bad thing/.test(e.message)
  );
});

test('取消：进程组被杀后以 E_CANCELLED 收尾', async (t) => {
  useTempHome(t);
  let cancelled = false;
  let child;
  const p = execAdapter({
    decl: jsonDecl(),
    input: '__slow__',
    options: {},
    timeoutMs: 30000,
    runId: 'r9',
    isCancelled: () => cancelled,
    onSpawn: (c) => {
      child = c;
    },
  });
  // 与 engine.cancel 一致：标记取消 + 杀进程组
  setTimeout(() => {
    cancelled = true;
    killProcessTree(child);
  }, 100);
  await assert.rejects(
    () => p,
    (e) => e instanceof BridgeError && e.code === 'E_CANCELLED'
  );
});

test('会话续聊：选项白名单映射为 --conversation argv；conversation_id 提取进 meta', async (t) => {
  useTempHome(t);
  // fake CLI 回显是否收到 --conversation 及其值，模拟 agy 的会话行为
  const script = `
const a = process.argv;
const ci = a.indexOf('--conversation');
console.log(JSON.stringify({
  response: ci !== -1 ? 'resumed:' + a[ci + 1] : 'fresh',
  status: 'SUCCESS',
  conversation_id: ci !== -1 ? a[ci + 1] : 'new-conv-id',
}));
`;
  const decl = jsonDecl({
    run: {
      args: ['-e', script, '{input}'],
      output: 'json',
      jsonResponsePath: 'response',
      jsonStatusPath: 'status',
      jsonStatusSuccess: ['SUCCESS'],
      jsonConversationIdPath: 'conversation_id',
    },
    options: [{ name: 'conversationId', flag: '--conversation', type: 'string' }],
  });
  // 首轮（无 conversationId）：开新会话，返回新 id
  const fresh = await execAdapter({ decl, input: 'hi', options: {}, timeoutMs: 30000, runId: 'rc0' });
  assert.equal(fresh.output, 'fresh');
  assert.equal(fresh.meta.conversationId, 'new-conv-id');
  // 续聊轮（带 conversationId）：选项映射为 argv，id 回流 meta
  const resumed = await execAdapter({ decl, input: 'hi', options: { conversationId: 'conv-42' }, timeoutMs: 30000, runId: 'rc1' });
  assert.equal(resumed.output, 'resumed:conv-42');
  assert.equal(resumed.meta.conversationId, 'conv-42');
});
