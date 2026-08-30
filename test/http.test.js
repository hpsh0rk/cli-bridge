import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { startBridge, post, get, rawRequest, pollRun, fakeAdapterDecl } from './helpers.js';
import { createToken } from '../src/core/tokens.js';

const ORIGIN = 'https://example.com';

function matrixConfig() {
  return {
    auth: { requireToken: true },
    origins: [ORIGIN],
    tools: { allow: ['fake', 'ghost'] },
    adapters: {
      fake: fakeAdapterDecl(),
      ghost: {
        displayName: 'Ghost Tool',
        binary: 'definitely-missing-bin-xyz',
        installHint: 'npm i -g ghost-cli',
        run: { args: ['{input}'], output: 'text' },
        capabilities: { text: true, image: false, stream: false },
        limits: { timeoutMs: 60000, concurrency: 1, outputMaxBytes: 1024 },
        options: [],
      },
    },
  };
}

test('health：无需鉴权、任意来源可探测，且不泄露工具列表', async (t) => {
  const { port } = await startBridge(t, { configPatch: matrixConfig() });
  const r = await get(port, '/v1/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.tokenRequired, true);
  assert.ok(!/fake|agy|codex/i.test(r.text), 'health 不得泄露工具信息');
});

test('防 DNS rebinding：非法 Host 一律 403', async (t) => {
  const { port } = await startBridge(t, { configPatch: matrixConfig() });
  const r = await rawRequest({ port, path: '/v1/health', headers: { Host: 'evil.com' } });
  assert.equal(r.status, 403);
  assert.equal(r.json.error.code, 'E_ORIGIN');
  const r2 = await rawRequest({ port, path: '/v1/health', headers: { Host: `127.0.0.1:${port + 1}` } });
  assert.equal(r2.status, 403);
});

test('CORS 预检：白名单 Origin 放行并回显头；白名单外 403', async (t) => {
  const { port } = await startBridge(t, { configPatch: matrixConfig() });
  const ok = await rawRequest({ port, method: 'OPTIONS', path: '/v1/tools/fake/run', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' } });
  assert.equal(ok.status, 204);
  assert.equal(ok.headers['access-control-allow-origin'], ORIGIN);
  assert.ok(ok.headers['access-control-allow-headers'].includes('x-bridge-token'));

  const bad = await rawRequest({ port, method: 'OPTIONS', path: '/v1/tools/fake/run', headers: { Origin: 'https://evil.com' } });
  assert.equal(bad.status, 403);
  assert.equal(bad.json.error.code, 'E_ORIGIN');
});

test('鉴权矩阵：per-origin token 规则', async (t) => {
  const { port } = await startBridge(t, { configPatch: matrixConfig() });
  const siteToken = createToken({ origin: ORIGIN }).token;
  const otherToken = createToken({ origin: 'https://other.com' }).token;
  const localToken = createToken({ origin: 'local' }).token;

  let r = await get(port, '/v1/tools');
  assert.equal(r.status, 401, '无 token → 401');
  assert.equal(r.json.error.code, 'E_AUTH');

  r = await get(port, '/v1/tools', { Origin: ORIGIN });
  assert.equal(r.status, 401, '白名单 Origin 但缺 token → 401');

  r = await get(port, '/v1/tools', { Origin: 'https://evil.com' });
  assert.equal(r.status, 403, '白名单外 Origin 先于鉴权被拒');
  assert.equal(r.json.error.code, 'E_ORIGIN');

  r = await get(port, '/v1/tools', { 'x-bridge-token': siteToken, Origin: ORIGIN });
  assert.equal(r.status, 200, 'token 与 Origin 匹配 → 200');

  r = await get(port, '/v1/tools', { 'x-bridge-token': otherToken, Origin: ORIGIN });
  assert.equal(r.status, 401, 'token 属于其他 origin → 401');

  r = await get(port, '/v1/tools', { 'x-bridge-token': siteToken });
  assert.equal(r.status, 401, 'https token 不能用于无 Origin 的本机调用');

  r = await get(port, '/v1/tools', { 'x-bridge-token': localToken });
  assert.equal(r.status, 200, 'local token 用于本机无 Origin 调用 → 200');

  r = await get(port, '/v1/tools', { Authorization: `Bearer ${localToken}` });
  assert.equal(r.status, 200, '兼容 Authorization: Bearer');
});

test('/v1/tools：只列白名单内工具，含 available 与 installHint', async (t) => {
  const { port } = await startBridge(t, { configPatch: matrixConfig() });
  const token = createToken({ origin: 'local' }).token;
  const r = await get(port, '/v1/tools', { 'x-bridge-token': token });
  assert.equal(r.status, 200);
  const ids = r.json.data.map((x) => x.id);
  assert.deepEqual(ids.sort(), ['fake', 'ghost']);
  const fake = r.json.data.find((x) => x.id === 'fake');
  assert.equal(fake.available, true);
  assert.deepEqual(Object.keys(fake.capabilities), ['text', 'image', 'stream']);
  const ghost = r.json.data.find((x) => x.id === 'ghost');
  assert.equal(ghost.available, false);
  assert.equal(ghost.installHint, 'npm i -g ghost-cli');
});

test('同步运行：happy path 返回 output 与 meta.usage', async (t) => {
  const { port, home } = await startBridge(t, { configPatch: matrixConfig() });
  const token = createToken({ origin: 'local' }).token;
  const r = await post(port, '/v1/tools/fake/run', { input: 'hello' }, { 'x-bridge-token': token });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.data.status, 'succeeded');
  assert.equal(r.json.data.output, 'echo:hello');
  assert.equal(r.json.data.meta.usage.total_tokens, 7);
  assert.ok(r.json.data.meta.durationMs >= 0);
  assert.ok(r.json.data.runId.startsWith('r_'));

  // 审计：默认记录运行但绝不记录 prompt
  const audit = fs.readFileSync(path.join(home, '.cli-bridge', 'audit.log'), 'utf8');
  assert.ok(audit.includes('"tool":"fake"'));
  assert.ok(audit.includes('"origin":"(local-channel)"'));
  assert.ok(!audit.includes('hello'), 'redactPrompts 下不得落盘 prompt');
});

test('错误码矩阵：404 / 403 / 503 / 400', async (t) => {
  const { port } = await startBridge(t, { configPatch: matrixConfig() });
  const token = createToken({ origin: 'local' }).token;
  const h = { 'x-bridge-token': token };
  const run = (toolId, body) => post(port, `/v1/tools/${toolId}/run`, body, h);

  let r = await run('unknown-tool', { input: 'x' });
  assert.equal(r.status, 404);
  assert.equal(r.json.error.code, 'E_TOOL_NOT_FOUND');

  r = await run('agy', { input: 'x' });
  assert.equal(r.status, 403, '未加白名单的已声明工具 → E_TOOL_DISABLED');
  assert.equal(r.json.error.code, 'E_TOOL_DISABLED');

  r = await run('ghost', { input: 'x' });
  assert.equal(r.status, 503);
  assert.equal(r.json.error.code, 'E_TOOL_UNAVAILABLE');
  assert.equal(r.json.error.installHint, 'npm i -g ghost-cli');

  r = await run('fake', { input: '' });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, 'E_BAD_REQUEST');
  assert.equal(r.json.error.detail[0].field, 'input');

  r = await run('fake', { input: 'x', timeoutMs: 999999 });
  assert.equal(r.status, 400, 'timeoutMs 超过适配器上限 → 400');

  r = await rawRequest({ port, method: 'POST', path: '/v1/tools/fake/run', headers: { 'x-bridge-token': token }, body: 'not-json' });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, 'E_BAD_REQUEST');
});

test('请求体上限：超过 maxBodyBytes → 400', async (t) => {
  const { port } = await startBridge(t, { configPatch: { ...matrixConfig(), limits: { runsPerMinute: 10, queueDepth: 8, maxBodyBytes: 100 } } });
  const token = createToken({ origin: 'local' }).token;
  const r = await post(port, '/v1/tools/fake/run', { input: 'x'.repeat(300) }, { 'x-bridge-token': token });
  assert.equal(r.status, 400);
  assert.ok(/上限/.test(r.json.error.message));
});

test('频控：每分钟 N 次，超出 429 + retryAfterMs', async (t) => {
  const { port } = await startBridge(t, { configPatch: { ...matrixConfig(), auth: { requireToken: false }, limits: { runsPerMinute: 2, queueDepth: 8, maxBodyBytes: 1048576 } } });
  assert.equal((await post(port, '/v1/tools/fake/run', { input: '1' })).status, 200);
  assert.equal((await post(port, '/v1/tools/fake/run', { input: '2' })).status, 200);
  const third = await post(port, '/v1/tools/fake/run', { input: '3' });
  assert.equal(third.status, 429);
  assert.equal(third.json.error.code, 'E_RATE_LIMIT');
  assert.ok(third.json.error.retryAfterMs > 0);
});

test('异步运行：202 + runId → 轮询到 succeeded', async (t) => {
  const { port } = await startBridge(t, { configPatch: { ...matrixConfig(), auth: { requireToken: false } } });
  const start = await post(port, '/v1/tools/fake/run', { input: 'async-1', wait: false });
  assert.equal(start.status, 202);
  assert.ok(start.json.data.runId);
  const done = await pollRun(port, start.json.data.runId);
  assert.equal(done.json.data.status, 'succeeded');
  assert.equal(done.json.data.output, 'echo:async-1');
});

test('运行中状态可见：轮询能看到 running（而非一直 queued）', async (t) => {
  const { port } = await startBridge(t, { configPatch: { ...matrixConfig(), auth: { requireToken: false } } });
  const start = await post(port, '/v1/tools/fake/run', { input: '__slow__', wait: false });
  const runId = start.json.data.runId;
  await new Promise((r) => setTimeout(r, 300));
  const mid = await get(port, `/v1/runs/${runId}`);
  assert.equal(mid.json.data.status, 'running');
  const cancel = await post(port, `/v1/runs/${runId}/cancel`, {});
  assert.equal(cancel.status, 200);
  const done = await pollRun(port, runId);
  assert.equal(done.json.data.status, 'cancelled');
});

test('超时：同步等待返回 504 E_TIMEOUT（retryable）', async (t) => {
  const { port } = await startBridge(t, { configPatch: { ...matrixConfig(), auth: { requireToken: false } } });
  const r = await post(port, '/v1/tools/fake/run', { input: '__slow__', timeoutMs: 300 });
  assert.equal(r.status, 504);
  assert.equal(r.json.error.code, 'E_TIMEOUT');
  assert.equal(r.json.error.retryable, true);
});

test('取消：异步运行可取消，终态 cancelled；重复取消幂等', async (t) => {
  const { port } = await startBridge(t, { configPatch: { ...matrixConfig(), auth: { requireToken: false } } });
  const start = await post(port, '/v1/tools/fake/run', { input: '__slow__', wait: false });
  const runId = start.json.data.runId;
  await new Promise((r) => setTimeout(r, 200)); // 让它进入 running
  const c = await post(port, `/v1/runs/${runId}/cancel`, {});
  assert.equal(c.status, 200);
  const done = await pollRun(port, runId);
  assert.equal(done.json.data.status, 'cancelled');
  const again = await post(port, `/v1/runs/${runId}/cancel`, {});
  assert.equal(again.status, 200);
  assert.equal(again.json.data.status, 'cancelled');
  const missing = await post(port, '/v1/runs/r_nonexistent/cancel', {});
  assert.equal(missing.status, 404);
});

test('队列深度：占满后新提交 503 E_BUSY', async (t) => {
  const { port } = await startBridge(t, {
    configPatch: { ...matrixConfig(), auth: { requireToken: false }, limits: { runsPerMinute: 100, queueDepth: 1, maxBodyBytes: 1048576 } },
  });
  const r1 = await post(port, '/v1/tools/fake/run', { input: '__slow__', wait: false });
  const r2 = await post(port, '/v1/tools/fake/run', { input: '__slow__', wait: false });
  await new Promise((r) => setTimeout(r, 300)); // r1 running、r2 排队
  const r3 = await post(port, '/v1/tools/fake/run', { input: 'x', wait: false });
  assert.equal(r3.status, 503);
  assert.equal(r3.json.error.code, 'E_BUSY');
  await post(port, `/v1/runs/${r1.json.data.runId}/cancel`, {});
  await post(port, `/v1/runs/${r2.json.data.runId}/cancel`, {});
});

test('SSE：补发历史事件并实时推送直到终态', async (t) => {
  const { port } = await startBridge(t, { configPatch: { ...matrixConfig(), auth: { requireToken: false } } });
  const start = await post(port, '/v1/tools/fake/run', { input: '__slow__', wait: false });
  const runId = start.json.data.runId;

  const streamPromise = new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: `/v1/events?runId=${runId}` }, (res) => {
      assert.equal(res.headers['content-type'].includes('text/event-stream'), true);
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.end();
  });

  await new Promise((r) => setTimeout(r, 300));
  await post(port, `/v1/runs/${runId}/cancel`, {});
  const stream = await Promise.race([streamPromise, new Promise((_, rej) => setTimeout(() => rej(new Error('SSE 未按时结束')), 5000))]);
  const events = [...stream.matchAll(/event: (\w+)/g)].map((m) => m[1]);
  assert.ok(events.includes('queued'), '应补发 queued 历史事件');
  assert.ok(events.includes('cancelled'), '应实时推送 cancelled 终态');
  const last = [...stream.matchAll(/data: (.+)\n/g)].map((m) => JSON.parse(m[1])).pop();
  assert.equal(last.type, 'cancelled');
});

test('桥自带演示页：同源请求豁免来源白名单，但仍需 token', async (t) => {
  const { port } = await startBridge(t, { configPatch: matrixConfig() });
  const token = createToken({ origin: 'local' }).token;

  const page = await get(port, '/');
  assert.equal(page.status, 200);
  assert.ok(page.headers['content-type'].includes('text/html'));

  // 浏览器同源 POST 会带 Origin：桥自身 origin 豁免白名单，local token 有效
  let r = await post(port, '/v1/tools/fake/run', { input: 'demo' }, { Origin: `http://127.0.0.1:${port}`, 'x-bridge-token': token });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.data.output, 'echo:demo');

  r = await post(port, '/v1/tools/fake/run', { input: 'demo' }, { Origin: `http://localhost:${port}`, 'x-bridge-token': token });
  assert.equal(r.status, 200);

  // 同源但无 token 仍 401
  r = await post(port, '/v1/tools/fake/run', { input: 'demo' }, { Origin: `http://127.0.0.1:${port}` });
  assert.equal(r.status, 401);

  // 同源页面上 https-token 不适用（按 local 规则校验）
  const siteToken = createToken({ origin: ORIGIN }).token;
  r = await post(port, '/v1/tools/fake/run', { input: 'demo' }, { Origin: `http://127.0.0.1:${port}`, 'x-bridge-token': siteToken });
  assert.equal(r.status, 401);

  // 其他 http 来源不享受豁免 → 403
  r = await get(port, '/v1/tools', { Origin: 'http://localhost:5500', 'x-bridge-token': token });
  assert.equal(r.status, 403);
  assert.equal(r.json.error.code, 'E_ORIGIN');
});

test('选项白名单：白名单外拒绝，枚举值校验，合法值映射为 argv', async (t) => {
  const { port } = await startBridge(t, {
    configPatch: { ...matrixConfig(), auth: { requireToken: false }, tools: { allow: ['fake', 'opts', 'ghost'] } },
    adapters: {
      fake: fakeAdapterDecl(),
      opts: {
        ...fakeAdapterDecl(),
        id: 'opts',
        displayName: 'Opts Tool',
        options: [
          { name: 'model', flag: '--model', type: 'enum', values: ['a', 'b'] },
          { name: 'verbose', flag: '--verbose', type: 'boolean' },
        ],
      },
    },
    tools: { allow: ['fake', 'opts', 'ghost'] },
  });
  let r = await post(port, '/v1/tools/opts/run', { input: 'x', options: { nope: 1 } });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.detail[0].field, 'options.nope');

  r = await post(port, '/v1/tools/opts/run', { input: 'x', options: { model: 'c' } });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.detail[0].field, 'options.model');

  r = await post(port, '/v1/tools/opts/run', { input: 'x', options: { model: 'a', verbose: true } });
  assert.equal(r.status, 200);
  assert.equal(r.json.data.output, 'echo:x');
});
