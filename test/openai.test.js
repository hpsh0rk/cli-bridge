import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startBridge, get, rawRequest } from './helpers.js';
import { createToken } from '../src/core/tokens.js';
import { composeInput } from '../src/server/openai.js';

const STREAM_CODE = `
setTimeout(() => console.log(JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: '你好，' } })), 50);
setTimeout(() => console.log(JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: '世界' } })), 120);
setTimeout(() => {
  console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: '你好，世界', usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } } }));
  process.exit(0);
}, 220);
`;

const IMAGE_CODE = `
const fs = require('fs'), path = require('path');
setTimeout(() => {
  fs.writeFileSync(path.join(process.cwd(), 'out.png'), Buffer.from('fake-png-bytes'));
  setInterval(() => {}, 1000); // 写完不退出：验证桥按"文件稳定即收割"处理（对应 agy 实测行为）
}, 600);
`;

const FAILFAST_CODE = `
const evt = { event: 'step_update', step_update: { state: 'ERROR', tool_name: 'generate_image', duration_seconds: 0.4, tool_info: { name: 'generate_image', error: { type: 'TOOL_ERROR', message: 'failed to generate content: 429 Too Many Requests, body: ' + JSON.stringify({ error: { code: 429, message: 'You have exhausted your capacity on this model. Your quota will reset after 23h26m2s.', status: 'RESOURCE_EXHAUSTED', details: [ { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'QUOTA_EXHAUSTED', metadata: { model: 'gemini-3.1-flash-image', quotaResetTimeStamp: '2026-08-31T14:50:39Z' } } ] } }) } } } };
setTimeout(() => console.log(JSON.stringify(evt)), 60);
setInterval(() => {}, 1000); // 不退出：验证桥快速失败而不是干等超时
`;

function streamSection() {
  return {
    args: ['-e', STREAM_CODE, '{input}'],
    deltas: { when: { event: 'step_update', 'step_update.step_type': 'agent_response' }, path: 'step_update.text_delta' },
    final: { when: { event: 'result' }, outputPath: 'result.response', statusPath: 'result.status', successValues: ['SUCCESS'], usagePath: 'result.usage' },
  };
}

function openaiConfig() {
  return {
    auth: { requireToken: false },
    tools: { allow: ['chat', 'img', 'imgfail'] },
    adapters: {
      chat: {
        displayName: 'Stream Tool',
        binary: process.execPath,
        run: { args: ['-e', 'console.log(JSON.stringify({response:"x",status:"SUCCESS"}))', '{input}'], output: 'json', jsonResponsePath: 'response', jsonStatusPath: 'status', jsonStatusSuccess: ['SUCCESS'] },
        stream: streamSection(),
        capabilities: { text: true, image: false, stream: true },
        limits: { timeoutMs: 30000, concurrency: 1, outputMaxBytes: 8388608 },
        options: [],
      },
      img: {
        displayName: 'Image Tool',
        binary: process.execPath,
        run: { args: ['-e', IMAGE_CODE, '{input}'], output: 'json', jsonResponsePath: 'response' },
        stream: { args: ['-e', IMAGE_CODE, '{input}'] },
        image: { extraArgs: [], extensions: ['.png'], fileStableMs: 500, toolName: 'generate_image' },
        capabilities: { text: true, image: true, stream: true },
        limits: { timeoutMs: 30000, concurrency: 1, outputMaxBytes: 8388608 },
        options: [],
      },
      imgfail: {
        displayName: 'Image Fail Tool',
        binary: process.execPath,
        run: { args: ['-e', 'console.log("{}")', '{input}'], output: 'json', jsonResponsePath: 'x' },
        image: { extraArgs: [], extensions: ['.png'], fileStableMs: 500, toolName: 'generate_image' },
        capabilities: { text: true, image: true, stream: false },
        limits: { timeoutMs: 30000, concurrency: 1, outputMaxBytes: 8388608 },
        options: [],
      },
    },
  };
}

function adapterPatch(overrides) {
  const cfg = openaiConfig();
  cfg.adapters.imgfail.run.args = ['-e', FAILFAST_CODE, '{input}'];
  return { ...cfg, ...overrides };
}

test('/v1/models：可用工具以 OpenAI model 形式列出', async (t) => {
  const { port } = await startBridge(t, { configPatch: adapterPatch() });
  const r = await get(port, '/v1/models');
  assert.equal(r.status, 200);
  assert.equal(r.json.object, 'list');
  assert.deepEqual(r.json.data.map((m) => m.id).sort(), ['chat', 'img', 'imgfail']);
  assert.equal(r.json.data[0].object, 'model');
});

test('chat/completions 同步：OpenAI 响应形状 + usage 映射', async (t) => {
  const { port } = await startBridge(t, { configPatch: adapterPatch() });
  const r = await rawRequest({
    port,
    method: 'POST',
    path: '/v1/chat/completions',
    headers: { 'Content-Type': 'application/json' },
    body: { model: 'chat', messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.object, 'chat.completion');
  assert.ok(r.json.id.startsWith('chatcmpl-'));
  assert.equal(r.json.model, 'chat');
  assert.equal(r.json.choices[0].message.role, 'assistant');
  assert.equal(r.json.choices[0].message.content, '你好，世界');
  assert.equal(r.json.choices[0].finish_reason, 'stop');
  assert.deepEqual(r.json.usage, { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
});

test('chat/completions 流式：SSE 增量 + finish_reason + include_usage + [DONE]', async (t) => {
  const { port } = await startBridge(t, { configPatch: adapterPatch() });
  const r = await rawRequest({
    port,
    method: 'POST',
    path: '/v1/chat/completions',
    headers: { 'Content-Type': 'application/json' },
    body: { model: 'chat', messages: [{ role: 'user', content: 'hi' }], stream: true, stream_options: { include_usage: true } },
  });
  assert.equal(r.status, 200);
  assert.ok(r.headers['content-type'].includes('text/event-stream'));

  const events = r.text.split('\n\n').filter((s) => s.startsWith('data: ')).map((s) => s.slice(6));
  assert.equal(events[events.length - 1], '[DONE]');
  const chunks = events.slice(0, -1).map((s) => JSON.parse(s));
  assert.equal(chunks[0].choices[0].delta.role, 'assistant');
  assert.ok(chunks[0].bridge_run_id && chunks[0].bridge_run_id.startsWith('r_'), '首块应带 bridge_run_id 桥扩展字段');
  const content = chunks.filter((c) => c.choices[0]?.delta?.content).map((c) => c.choices[0].delta.content).join('');
  assert.equal(content, '你好，世界');
  const stop = chunks.find((c) => c.choices[0]?.finish_reason === 'stop');
  assert.ok(stop, '应有 finish_reason=stop 的收尾块');
  const usageChunk = chunks.find((c) => c.choices.length === 0 && c.usage);
  assert.deepEqual(usageChunk.usage, { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
});

test('chat/completions 错误走 OpenAI 错误信封', async (t) => {
  const { port } = await startBridge(t, { configPatch: adapterPatch() });
  let r = await rawRequest({ port, method: 'POST', path: '/v1/chat/completions', headers: { 'Content-Type': 'application/json' }, body: { model: 'nope', messages: [{ role: 'user', content: 'x' }] } });
  assert.equal(r.status, 404);
  assert.equal(r.json.error.code, 'E_TOOL_NOT_FOUND');
  assert.equal(r.json.error.type, 'invalid_request_error');

  r = await rawRequest({ port, method: 'POST', path: '/v1/chat/completions', headers: { 'Content-Type': 'application/json' }, body: { model: 'chat' } });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.type, 'invalid_request_error');
});

test('images/generations：b64_json 默认；url 模式经 /v1/files 取回', async (t) => {
  const { port } = await startBridge(t, { configPatch: adapterPatch() });
  let r = await rawRequest({ port, method: 'POST', path: '/v1/images/generations', headers: { 'Content-Type': 'application/json' }, body: { model: 'img', prompt: '画一只猫' } });
  assert.equal(r.status, 200, r.text);
  assert.ok(r.json.created > 0);
  assert.equal(Buffer.from(r.json.data[0].b64_json, 'base64').toString(), 'fake-png-bytes');

  r = await rawRequest({ port, method: 'POST', path: '/v1/images/generations', headers: { 'Content-Type': 'application/json' }, body: { model: 'img', prompt: '画一只狗', response_format: 'url' } });
  assert.equal(r.status, 200);
  const url = new URL(r.json.data[0].url);
  assert.equal(url.pathname.split('/').pop(), 'out.png');
  const file = await rawRequest({ port, path: url.pathname, headers: { 'x-bridge-token': 'unused' } });
  assert.equal(file.status, 200);
  assert.equal(file.text, 'fake-png-bytes');
});

test('images/generations：n>1 / 非图片工具 被拒绝；generate_image 失败快速返回', async (t) => {
  const { port } = await startBridge(t, { configPatch: adapterPatch() });
  let r = await rawRequest({ port, method: 'POST', path: '/v1/images/generations', headers: { 'Content-Type': 'application/json' }, body: { model: 'img', prompt: 'x', n: 2 } });
  assert.equal(r.status, 400);
  assert.ok(/n=1/.test(r.json.error.message));

  r = await rawRequest({ port, method: 'POST', path: '/v1/images/generations', headers: { 'Content-Type': 'application/json' }, body: { model: 'chat', prompt: 'x' } });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, 'E_BAD_REQUEST');

  const started = Date.now();
  r = await rawRequest({ port, method: 'POST', path: '/v1/images/generations', headers: { 'Content-Type': 'application/json' }, body: { model: 'imgfail', prompt: 'x' } });
  assert.equal(r.status, 502);
  assert.equal(r.json.error.code, 'E_TOOL_FAILED');
  assert.ok(/generate_image/.test(r.json.error.message));
  // 真实原因透传（429 配额耗尽 → 人话摘要 + 原始详情）
  assert.ok(/配额已用尽/.test(r.json.error.message), r.json.error.message);
  assert.ok(/gemini-3\.1-flash-image/.test(r.json.error.message));
  assert.ok(/2026-08-31T14:50:39Z/.test(r.json.error.message));
  assert.ok(/QUOTA_EXHAUSTED/.test(r.json.error.detail));
  assert.ok(Date.now() - started < 5000, '应在工具报错后快速失败，而不是等超时');
});

// 回归：OpenAI 兼容层的错误响应必须带 CORS 头，否则白名单页面跨域时浏览器拦截响应，
// fetch 抛 TypeError，在线调试台只能看到 HTTP 0 而非真实错误（如 429 配额耗尽）。
test('错误响应带 CORS 头：白名单 Origin 可读信封，非白名单不带', async (t) => {
  const cfg = { ...adapterPatch(), origins: ['https://sh0rk.cn'] };
  const { port } = await startBridge(t, { configPatch: cfg });
  const headers = { 'Content-Type': 'application/json', Origin: 'https://sh0rk.cn' };

  // images/generations：参数校验错误（400）
  let r = await rawRequest({ port, method: 'POST', path: '/v1/images/generations', headers, body: { model: 'img', prompt: 'x', n: 2 } });
  assert.equal(r.status, 400);
  assert.equal(r.headers['access-control-allow-origin'], 'https://sh0rk.cn');
  assert.equal(r.json.error.code, 'E_BAD_REQUEST');

  // images/generations：工具失败透传（502，真实场景即 429 配额耗尽）
  r = await rawRequest({ port, method: 'POST', path: '/v1/images/generations', headers, body: { model: 'imgfail', prompt: 'x' } });
  assert.equal(r.status, 502);
  assert.equal(r.headers['access-control-allow-origin'], 'https://sh0rk.cn');
  assert.equal(r.json.error.code, 'E_TOOL_FAILED');

  // chat/completions：错误信封同样带 CORS
  r = await rawRequest({ port, method: 'POST', path: '/v1/chat/completions', headers, body: { model: 'nope', messages: [{ role: 'user', content: 'x' }] } });
  assert.equal(r.status, 404);
  assert.equal(r.headers['access-control-allow-origin'], 'https://sh0rk.cn');

  // 非白名单 Origin：维持原行为，不给 ACAO（浏览器侧本就该拦）
  r = await rawRequest({
    port,
    method: 'POST',
    path: '/v1/images/generations',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: { model: 'img', prompt: 'x', n: 2 },
  });
  assert.equal(r.status, 403);
  assert.equal(r.headers['access-control-allow-origin'], undefined);
});

test('composeInput：单轮直传 / system 前置 / 多轮转写', () => {
  assert.equal(composeInput([{ role: 'user', content: '你好' }]), '你好');
  assert.equal(
    composeInput([
      { role: 'system', content: '你是猫娘' },
      { role: 'user', content: '你好' },
    ]),
    '你是猫娘\n\n你好'
  );
  const multi = composeInput([
    { role: 'system', content: 'S' },
    { role: 'user', content: 'U1' },
    { role: 'assistant', content: 'A1' },
    { role: 'user', content: [{ type: 'text', text: 'U2' }] },
  ]);
  assert.equal(multi, 'System: S\n\nUser: U1\n\nAssistant: A1\n\nUser: U2');
});
