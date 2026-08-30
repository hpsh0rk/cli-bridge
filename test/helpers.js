import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, writeConfig, defaultConfig, socketPath } from '../src/core/config.js';
import { buildRegistry } from '../src/adapters/registry.js';
import { Scheduler } from '../src/core/queue.js';
import { RunStore } from '../src/core/runs.js';
import { Audit } from '../src/core/audit.js';
import { createEngine } from '../src/core/engine.js';
import { createHttpServer, createRequestHandler } from '../src/server/http.js';
import { startUdsChannel } from '../src/server/uds.js';
import { deepMerge } from '../src/util.js';

/** 模块加载时捕获真实用户 HOME（此刻 HOME 尚未被测试沙箱覆盖）。 */
export const REAL_HOME = os.homedir();

/**
 * agy 的 OAuth 令牌在 $HOME/.gemini/antigravity-cli/antigravity-oauth-token。
 * 沙箱 HOME 不含它时 agy 会认为未登录、向用户浏览器弹 Google 授权页（测试跑几轮弹几次）。
 * 因此凡启用 agy 的测试桥，一律把真实 .gemini/.antigravity 软链进沙箱 HOME。
 */
function linkAgyCredentials(home, config) {
  if (!config.tools.allow.includes('agy')) return;
  for (const dir of ['.gemini', '.antigravity']) {
    const real = path.join(REAL_HOME, dir);
    const link = path.join(home, dir);
    try {
      if (fs.existsSync(real) && !fs.existsSync(link)) fs.symlinkSync(real, link);
    } catch {
      /* 已存在等 */
    }
  }
}

/** 沙箱 HOME：配置/token/workspace 全部落进临时目录（os.homedir() 读 HOME env）。 */
export function useTempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-bridge-test-'));
  const prev = process.env.HOME;
  process.env.HOME = dir;
  t.after(() => {
    process.env.HOME = prev;
  });
  return dir;
}

/** 直接写一份配置文件（绕过 CLI），供 loadConfig 读取。 */
export function writeTestConfig(home, patch) {
  const dir = path.join(home, '.cli-bridge');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(deepMerge(defaultConfig(), patch), null, 2));
}

/** 测试用 fake 工具：node -e 直接执行；{input} 槽位经 argv 传入。 */
export const FAKE_CODE = `
const s = process.argv[1] || '';
if (s === '__slow__') { console.log(JSON.stringify({ response: 'late', status: 'SUCCESS' })); setInterval(() => {}, 1000); }
else if (s === '__fail__') { require('fs').writeSync(2, 'boom\\n'); process.exit(3); }
else { console.log(JSON.stringify({ response: 'echo:' + s, status: 'SUCCESS', usage: { total_tokens: 7 } })); }
`;

export function fakeAdapterDecl() {
  return {
    displayName: 'Fake Tool',
    binary: process.execPath,
    probe: { args: ['-e', 'process.exit(0)'], expectExit: [0] },
    run: {
      args: ['-e', FAKE_CODE, '{input}'],
      output: 'json',
      jsonResponsePath: 'response',
      jsonStatusPath: 'status',
      jsonStatusSuccess: ['SUCCESS'],
      usagePath: 'usage',
    },
    capabilities: { text: true, image: false, stream: false },
    limits: { timeoutMs: 300000, concurrency: 1, outputMaxBytes: 8388608 },
    options: [],
  };
}

/** 在临时 HOME 下组装引擎并启动 HTTP（临时端口）；uds:true 时同时启动 UDS 通道。 */
export async function startBridge(t, { configPatch = {}, adapters, uds = false } = {}) {
  const home = useTempHome(t);
  let full = deepMerge(defaultConfig(), configPatch);
  if (adapters) full = deepMerge(full, { adapters });
  writeConfig(full);
  const { config } = loadConfig();
  const registry = buildRegistry(config);
  linkAgyCredentials(home, config); // 必须在构造引擎/发起任何 agy 调用之前
  const engine = createEngine({
    config,
    registry,
    scheduler: new Scheduler(config.limits),
    runs: new RunStore(),
    audit: new Audit(config),
  });
  const handler = createRequestHandler({ config, engine, version: 'test' });
  const server = createHttpServer({ handler });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));

  let udsStarted = null;
  if (uds) {
    udsStarted = await startUdsChannel(handler);
    t.after(() => {
      void new Promise((r) => udsStarted.close(r));
      if (process.platform !== 'win32') {
        try {
          fs.unlinkSync(socketPath());
        } catch {
          /* 已清理 */
        }
      }
    });
  }

  return {
    home,
    config,
    engine,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    port: server.address().port,
    udsStarted,
  };
}

/** node:http 直连请求：可任意设置 Origin/Host 头（fetch 会吞掉这些受限头）。 */
export function rawRequest({ port, method = 'GET', path: p, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
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
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.end(typeof body === 'string' ? body : JSON.stringify(body));
    else req.end();
  });
}

export function post(port, pathname, body, headers = {}) {
  return rawRequest({ port, method: 'POST', path: pathname, body, headers });
}

export function get(port, pathname, headers = {}) {
  return rawRequest({ port, method: 'GET', path: pathname, headers });
}

const TERMINAL = ['succeeded', 'failed', 'timeout', 'cancelled'];

/** 轮询运行直到终态。 */
export async function pollRun(port, runId, { timeoutMs = 8000, headers = {} } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await get(port, `/v1/runs/${runId}`, headers);
    if (r.json?.data && TERMINAL.includes(r.json.data.status)) return r;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error('轮询超时：运行未在时限内到达终态');
}
