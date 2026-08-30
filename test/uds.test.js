import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startBridge, fakeAdapterDecl, post, get } from './helpers.js';
import { socketPath } from '../src/core/config.js';

function udsRequest({ method = 'GET', path: p, body }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        socketPath: socketPath(),
        method,
        path: p,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* 非 JSON */
          }
          resolve({ status: res.statusCode, json, text });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.end(payload);
    else req.end();
  });
}

function matrixConfig() {
  return {
    auth: { requireToken: true },
    tools: { allow: ['fake'] },
    adapters: { fake: fakeAdapterDecl() },
  };
}

test('UDS 通道：免 token（文件权限即信任边界），协议与 HTTP 一致', async (t) => {
  const { port } = await startBridge(t, { configPatch: matrixConfig(), uds: true });

  const health = await udsRequest({ path: '/v1/health' });
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);

  const tools = await udsRequest({ path: '/v1/tools' });
  assert.equal(tools.status, 200, 'UDS 上无需 token 即可访问 /v1/tools');
  assert.equal(tools.json.data[0].id, 'fake');

  const run = await udsRequest({ method: 'POST', path: '/v1/tools/fake/run', body: { input: 'via-uds' } });
  assert.equal(run.status, 200);
  assert.equal(run.json.data.output, 'echo:via-uds');
});

test('UDS 免 token，但同一请求走 HTTP 仍需 token（对照）', async (t) => {
  const { port } = await startBridge(t, { configPatch: matrixConfig(), uds: true });
  assert.equal((await udsRequest({ path: '/v1/tools' })).status, 200);
  assert.equal((await get(port, '/v1/tools')).status, 401);
  assert.equal((await post(port, '/v1/tools/fake/run', { input: 'x' })).status, 401);
});
