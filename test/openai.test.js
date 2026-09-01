import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

// 回归（2026-08-31 实测）：新版 agy 的 generate_image 把产物写进会话 brain 目录而非 cwd，
// 桥须按 image.searchDirs 扫描额外语境目录收割，且只认 mtime 晚于 run 开始的文件。
test('images/generations：searchDirs 外部目录收割 + 旧图防误收', async (t) => {
  const sideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-brain-'));
  t.after(() => fs.rmSync(sideDir, { recursive: true, force: true }));

  // 写进 searchDir 子目录（模拟 agy brain/<会话>/ 布局）或根目录，两条扫描路径都要覆盖
  const writeSide = (rel, bytes, mode) => `
const fs = require('fs'), path = require('path');
setTimeout(() => {
  const p = path.join(${JSON.stringify(sideDir)}, ${JSON.stringify(rel)});
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.from(${JSON.stringify(bytes)}));
  ${mode === 'hang' ? 'setInterval(() => {}, 1000);' : 'process.exit(0);'}
}, 400);
`;
  const sideAdapter = (code) => ({
    displayName: 'Side Image Tool',
    binary: process.execPath,
    run: { args: ['-e', 'console.log("{}")', '{input}'], output: 'json', jsonResponsePath: 'x' },
    stream: { args: ['-e', code, '{input}'] },
    image: { extensions: ['.png'], fileStableMs: 300, toolName: 'generate_image', searchDirs: [sideDir] },
    capabilities: { text: true, image: true, stream: true },
    limits: { timeoutMs: 15000, concurrency: 1, outputMaxBytes: 8388608 },
    options: [],
  });
  const cfg = {
    auth: { requireToken: false },
    tools: { allow: ['imgside-hang', 'imgside-exit', 'imgstale'] },
    adapters: {
      'imgside-hang': sideAdapter(writeSide('sess-hang/hang.png', 'side-hang-bytes', 'hang')),
      'imgside-exit': sideAdapter(writeSide('exit.png', 'side-exit-bytes', 'exit')),
      imgstale: sideAdapter(writeSide('nothing.png', '', 'exit')),
    },
  };
  const { port } = await startBridge(t, { configPatch: cfg });

  // 出图后挂住不退出：轮询从外部目录收割（成功后响应的 b64 来自 run 工作目录——证明外部文件已复制回 cwd）
  let r = await rawRequest({ port, method: 'POST', path: '/v1/images/generations', headers: { 'Content-Type': 'application/json' }, body: { model: 'imgside-hang', prompt: 'x' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(Buffer.from(r.json.data[0].b64_json, 'base64').toString(), 'side-hang-bytes');

  // 写完立即退出：轮询未必赶上，close 兜底收割
  r = await rawRequest({ port, method: 'POST', path: '/v1/images/generations', headers: { 'Content-Type': 'application/json' }, body: { model: 'imgside-exit', prompt: 'x' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(Buffer.from(r.json.data[0].b64_json, 'base64').toString(), 'side-exit-bytes');

  // 外部目录只有旧图（mtime 早于 run 开始）：不得收割，应报失败
  const stale = path.join(sideDir, 'stale.png');
  fs.writeFileSync(stale, Buffer.from('stale-bytes'));
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(stale, old, old);
  r = await rawRequest({ port, method: 'POST', path: '/v1/images/generations', headers: { 'Content-Type': 'application/json' }, body: { model: 'imgstale', prompt: 'x' } });
  assert.equal(r.status, 502);
  assert.equal(r.json.error.code, 'E_TOOL_FAILED');
  assert.equal(r.json.data, undefined);
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

// ─── 多轮会话续聊（KV cache 复用）───
// fake CLI 模拟 agy 实测行为：收到 --conversation 时回显「续聊 + 增量输入」，
// 固定返回 conversation_id，并上报带 cache_read_tokens 的用量（input 与 cache 不重叠）。
const CONV_CODE = `
const args = process.argv.slice(1);
const input = args[0] || '';
const ci = args.indexOf('--conversation');
const conv = ci !== -1 ? args[ci + 1] : '';
const text = (conv ? 'resumed:' + conv + '|' : 'fresh:') + input;
setTimeout(() => console.log(JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: text } })), 30);
setTimeout(() => {
  console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', conversation_id: 'conv-fixed-1', response: text, usage: { input_tokens: conv ? 5 : 100, output_tokens: 2, cache_read_tokens: conv ? 20 : 0, total_tokens: conv ? 7 : 102 } } }));
  process.exit(0);
}, 90);
`;

function convConfig() {
  return {
    auth: { requireToken: false },
    tools: { allow: ['conv'] },
    adapters: {
      conv: {
        displayName: 'Conv Tool',
        binary: process.execPath,
        run: {
          args: ['-e', CONV_CODE, '{input}'],
          output: 'json',
          jsonResponsePath: 'response',
          jsonStatusPath: 'status',
          jsonStatusSuccess: ['SUCCESS'],
          jsonConversationIdPath: 'conversation_id',
          usagePath: 'usage',
        },
        stream: {
          args: ['-e', CONV_CODE, '{input}'],
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
        capabilities: { text: true, image: false, stream: true, conversation: true },
        limits: { timeoutMs: 30000, concurrency: 1, outputMaxBytes: 8388608 },
        options: [{ name: 'conversationId', flag: '--conversation', type: 'string' }],
      },
    },
  };
}

test('多轮会话续聊：首轮转写开新会话，第二轮前缀命中只发增量', async (t) => {
  const { port } = await startBridge(t, { configPatch: convConfig() });
  const send = (messages) =>
    rawRequest({ port, method: 'POST', path: '/v1/chat/completions', headers: { 'Content-Type': 'application/json' }, body: { model: 'conv', messages } });

  // 首轮（单轮直传）：开新会话，响应带桥扩展 bridge_conversation_id
  let r = await send([{ role: 'user', content: 'U1' }]);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.choices[0].message.content, 'fresh:U1');
  assert.equal(r.json.bridge_conversation_id, 'conv-fixed-1');
  assert.deepEqual(r.json.usage, { prompt_tokens: 100, completion_tokens: 2, total_tokens: 102 });

  // 第二轮（真实客户端行为：重发完整历史）→ 前缀命中 → 只发 U2 + --conversation 续聊
  r = await send([
    { role: 'user', content: 'U1' },
    { role: 'assistant', content: 'fresh:U1' },
    { role: 'user', content: 'U2' },
  ]);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.choices[0].message.content, 'resumed:conv-fixed-1|U2');
  assert.equal(r.json.bridge_conversation_id, 'conv-fixed-1');
  // 缓存命中用量映射（OpenAI 语义 prompt 含缓存部分）：input 5 + cached 20 = prompt 25
  assert.deepEqual(r.json.usage, { prompt_tokens: 25, completion_tokens: 2, total_tokens: 27, prompt_tokens_details: { cached_tokens: 20 } });

  // 历史对不上（分支/编辑过）：miss → 回退整段转写，行为退化为 v1 基线
  r = await send([
    { role: 'user', content: 'OTHER' },
    { role: 'assistant', content: 'X' },
    { role: 'user', content: 'U2' },
  ]);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.choices[0].message.content, 'fresh:User: OTHER\n\nAssistant: X\n\nUser: U2');
});

test('多轮会话续聊（SSE）：stop/usage 块带 bridge_conversation_id 与缓存用量', async (t) => {
  const { port } = await startBridge(t, { configPatch: convConfig() });
  const send = (messages) =>
    rawRequest({
      port,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'Content-Type': 'application/json' },
      body: { model: 'conv', messages, stream: true, stream_options: { include_usage: true } },
    });
  let r = await send([{ role: 'user', content: 'U1' }]);
  assert.equal(r.status, 200);
  r = await send([
    { role: 'user', content: 'U1' },
    { role: 'assistant', content: 'fresh:U1' },
    { role: 'user', content: 'U2' },
  ]);
  assert.equal(r.status, 200);
  const events = r.text.split('\n\n').filter((s) => s.startsWith('data: ')).map((s) => s.slice(6));
  const chunks = events.slice(0, -1).map((s) => JSON.parse(s));
  const content = chunks.filter((c) => c.choices[0]?.delta?.content).map((c) => c.choices[0].delta.content).join('');
  assert.equal(content, 'resumed:conv-fixed-1|U2');
  const stop = chunks.find((c) => c.choices[0]?.finish_reason === 'stop');
  assert.equal(stop.bridge_conversation_id, 'conv-fixed-1');
  const usageChunk = chunks.find((c) => c.choices.length === 0 && c.usage);
  assert.equal(usageChunk.bridge_conversation_id, 'conv-fixed-1');
  assert.equal(usageChunk.usage.prompt_tokens_details.cached_tokens, 20);
});
