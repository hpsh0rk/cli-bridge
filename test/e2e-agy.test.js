import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { startBridge, post, rawRequest } from './helpers.js';
import { socketPath } from '../src/core/config.js';

const hasAgy = spawnSync('/usr/bin/which', ['agy']).status === 0;
const RUN_OPTS = { timeoutMs: 90000 };
// 真实 agy e2e 显式开启：npm run test:agy（或 CLI_BRIDGE_AGY_E2E=1）。
// 默认跳过的原因：沙箱 HOME 的登录态在极端情况下（如与正在运行的 agy 会话发生令牌轮换竞争）
// 会触发 agy 向用户浏览器弹 Google 授权页——不允许 `npm test` 有任何概率打扰用户。
const AGY_E2E = process.env.CLI_BRIDGE_AGY_E2E === '1';
const SKIP = hasAgy && AGY_E2E ? false : '需本机安装 agy 且 CLI_BRIDGE_AGY_E2E=1（npm run test:agy）。沙箱登录态由 startBridge 自动软链';

function udsRun(input) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ input, wait: true, ...RUN_OPTS });
    const req = http.request(
      {
        socketPath: socketPath(),
        method: 'POST',
        path: '/v1/tools/agy/run',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ status: res.statusCode, json: JSON.parse(text) });
          } catch {
            reject(new Error(`非 JSON 响应：${text.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

test('真实 agy 端到端：HTTP 同步运行（慢，约 3-10s）', { skip: SKIP }, async (t) => {
  const { port } = await startBridge(t, {
    configPatch: { auth: { requireToken: false }, tools: { allow: ['agy'] } },
  });
  const r = await post(port, '/v1/tools/agy/run', { input: '只回复两个字：pong', ...RUN_OPTS });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.data.status, 'succeeded');
  assert.ok(typeof r.json.data.output === 'string' && r.json.data.output.length > 0);
  assert.equal(r.json.data.meta.exitCode, 0);
  assert.ok(r.json.data.meta.durationMs > 0);
});

test('真实 agy：UDS 通道免 token 直调（慢）', { skip: SKIP }, async (t) => {
  await startBridge(t, {
    configPatch: { auth: { requireToken: true }, tools: { allow: ['agy'] } },
    uds: true,
  });
  const r = await udsRun('只回复两个字：pong');
  assert.equal(r.status, 200, r.json?.error?.message || '');
  assert.equal(r.json.ok, true);
  assert.ok(String(r.json.data.output).length > 0);
});

test('真实 agy：OpenAI 兼容层同步聊天（慢）', { skip: SKIP }, async (t) => {
  const { port } = await startBridge(t, {
    configPatch: { auth: { requireToken: false }, tools: { allow: ['agy'] } },
  });
  const r = await rawRequest({
    port,
    method: 'POST',
    path: '/v1/chat/completions',
    headers: { 'Content-Type': 'application/json' },
    body: { model: 'agy', messages: [{ role: 'user', content: '只回复两个字：pong' }] },
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.object, 'chat.completion');
  assert.ok(/pong/.test(r.json.choices[0].message.content));
  assert.ok(r.json.usage.total_tokens > 0);
});

test('真实 agy：OpenAI 兼容层流式聊天（慢，验证真增量 SSE）', { skip: SKIP }, async (t) => {
  const { port } = await startBridge(t, {
    configPatch: { auth: { requireToken: false }, tools: { allow: ['agy'] } },
  });
  const r = await rawRequest({
    port,
    method: 'POST',
    path: '/v1/chat/completions',
    headers: { 'Content-Type': 'application/json' },
    body: { model: 'agy', messages: [{ role: 'user', content: '写一段约120字的关于灯塔的散文' }], stream: true, stream_options: { include_usage: true } },
  });
  assert.equal(r.status, 200, r.text);
  assert.ok(r.headers['content-type'].includes('text/event-stream'));
  assert.ok(r.text.includes('data: [DONE]'));
  const chunks = r.text.split('\n\n').filter((s) => s.startsWith('data: ') && !s.includes('[DONE]')).map((s) => JSON.parse(s.slice(6)));
  const content = chunks.filter((c) => c.choices[0]?.delta?.content).map((c) => c.choices[0].delta.content).join('');
  assert.ok(content.length >= 60, '流式拼接出的正文非空');
  const usageChunk = chunks.find((c) => c.choices.length === 0 && c.usage);
  assert.ok(usageChunk && usageChunk.usage.total_tokens > 0, 'include_usage 应产出用量块');
});

test('真实 agy：OpenAI 兼容层多轮会话续聊（KV cache 复用，慢，约 10-60s）', { skip: SKIP }, async (t) => {
  const { port } = await startBridge(t, {
    configPatch: { auth: { requireToken: false }, tools: { allow: ['agy'] } },
  });
  const send = (messages) =>
    rawRequest({
      port,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'Content-Type': 'application/json' },
      body: { model: 'agy', messages, stream_options: { include_usage: true } },
    });
  const r1 = await send([{ role: 'user', content: '记住暗号是芒果7号。只回复：已记住' }]);
  assert.equal(r1.status, 200, r1.text);
  assert.ok(r1.json.bridge_conversation_id, '首轮应返回工具会话 id（bridge_conversation_id）');
  const convId = r1.json.bridge_conversation_id;

  // 第二轮重发完整历史（真实 OpenAI 客户端行为）：桥应识别前缀 → 会话续聊 → 记住上下文
  const r2 = await send([
    { role: 'user', content: '记住暗号是芒果7号。只回复：已记住' },
    { role: 'assistant', content: r1.json.choices[0].message.content },
    { role: 'user', content: '暗号是什么？只回复暗号本身' },
  ]);
  assert.equal(r2.status, 200, r2.text);
  assert.ok(/芒果7号/.test(r2.json.choices[0].message.content), `第二轮应续聊同一会话并答对暗号，实际：${r2.json.choices[0].message.content}`);
  assert.equal(r2.json.bridge_conversation_id, convId, '两轮应属于同一工具会话');
  assert.ok(r2.json.usage.prompt_tokens_details?.cached_tokens > 0, '续聊轮应命中上游 prompt cache（cached_tokens > 0）');
});

test('真实 agy：图片生成（依赖 agy 图片配额，实测时好时坏；CLI_BRIDGE_IMAGE_E2E=1 开启）', { skip: hasAgy && AGY_E2E && process.env.CLI_BRIDGE_IMAGE_E2E ? false : '需 CLI_BRIDGE_AGY_E2E=1 且 CLI_BRIDGE_IMAGE_E2E=1（generate_image 有配额限制，实测 3 次调用 1 成功 2 失败）' }, async (t) => {
  const { port } = await startBridge(t, {
    configPatch: { auth: { requireToken: false }, tools: { allow: ['agy'] } },
  });
  const r = await rawRequest({
    port,
    method: 'POST',
    path: '/v1/images/generations',
    headers: { 'Content-Type': 'application/json' },
    body: { model: 'agy', prompt: '生成一张图片：一只戴红色帽子的柴犬，卡通风格。把图片文件保存到当前工作目录，扩展名 png。' },
  });
  assert.equal(r.status, 200, r.text);
  assert.ok(r.json.data[0].b64_json.length > 10000, 'b64 应为真实图片数据');
});
