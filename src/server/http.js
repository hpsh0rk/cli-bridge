import http from 'node:http';
import fs from 'node:fs';
import { BridgeError } from '../errors.js';
import { verifyToken } from '../core/tokens.js';
import { isTerminalStatus } from '../core/engine.js';
import { readJsonBody } from './body.js';
import { createOpenAiHandlers } from './openai.js';

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

function sendOk(res, data, status = 200, extraHeaders = {}) {
  sendJson(res, status, { ok: true, data }, extraHeaders);
}

function corsHeadersFor(origin, config) {
  if (!origin || !config.origins.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-bridge-token, Authorization',
    'Access-Control-Max-Age': '600',
  };
}

/** 防 DNS rebinding：Host 只接受回环地址/主机名，端口须与本服务实际端口一致（或缺省）。 */
function isAllowedHost(host, localPort) {
  const m = /^(127\.0\.0\.1|localhost|\[::1\])(?::(\d+))?$/.exec(host || '');
  if (!m) return false;
  if (m[2] !== undefined && Number(m[2]) !== localPort) return false;
  return true;
}

/**
 * 桥自带演示页（GET /）的同源豁免：Origin 为桥自身（回环 + 本端口）时视为本机上下文——
 * 跳过来源白名单（同源请求本就不受 CORS 约束），token 仍必填且按 local 规则校验。
 */
function isOwnOrigin(origin, localPort) {
  return origin === `http://127.0.0.1:${localPort}` || origin === `http://localhost:${localPort}`;
}

/** token 只经请求头传递，永不出现在 URL。同时兼容 Authorization: Bearer。 */
function presentedToken(req) {
  const direct = req.headers['x-bridge-token'];
  if (typeof direct === 'string' && direct) return direct;
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && /^Bearer\s+\S+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return null;
}

function startSse(res, engine, runId, cors) {
  const snap0 = engine.getRun(runId); // 不存在时抛 E_NOT_FOUND（发生在写头之前，走统一错误响应）
  res.writeHead(200, {
    ...cors,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  const send = (ev) => {
    try {
      res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    } catch {
      /* 客户端已断开 */
    }
  };
  let seen = snap0.events.length;
  for (const ev of snap0.events) send(ev);
  if (isTerminalStatus(snap0.status)) return res.end();

  let finished = false;
  const cleanup = () => {
    if (finished) return;
    finished = true;
    clearInterval(heartbeat);
    unsub();
  };
  const onEvent = (ev) => {
    send(ev);
    if (isTerminalStatus(ev.type)) {
      cleanup();
      res.end();
    }
  };
  const unsub = engine.subscribeRun(runId, onEvent);
  // 补订阅间隙的事件（同步快照，无并发窗口）
  const snap1 = engine.getRun(runId);
  for (; seen < snap1.events.length; seen++) onEvent(snap1.events[seen]);
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      cleanup();
    }
  }, 15000);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();
  res.on('close', cleanup);
}

export function createRequestHandler({ config, engine, version, verbose = false }) {
  const openai = createOpenAiHandlers({ config, engine });
  return async function handle(req, res) {
    res.on('error', () => {});
    const trusted = req.socket.trustedLocal === true; // UDS/命名管道通道：文件权限即信任边界
    const originHeader = req.headers.origin || null;
    const sameOrigin = !trusted && isOwnOrigin(originHeader, req.socket.localPort);
    const cors = trusted || sameOrigin ? {} : corsHeadersFor(originHeader, config);
    if (verbose) console.error(`[cli-bridge] ${req.method} ${req.url}${trusted ? ' (uds)' : ''}`);
    try {
      if (!trusted && !isAllowedHost(req.headers.host, req.socket.localPort)) {
        return sendJson(res, 403, {
          ok: false,
          error: { code: 'E_ORIGIN', message: `非法 Host：${req.headers.host || '(缺失)'}（防 DNS rebinding）`, retryable: false },
        });
      }

      if (req.method === 'OPTIONS') {
        if (!cors['Access-Control-Allow-Origin'] && !sameOrigin) {
          return sendJson(res, 403, { ok: false, error: { code: 'E_ORIGIN', message: 'Origin 不在白名单', retryable: false } });
        }
        res.writeHead(204, cors);
        return res.end();
      }

      const url = new URL(req.url, 'http://internal');

      // 桥自带演示页（同源，无跨域问题）
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const html = fs.readFileSync(new URL('../../public/index.html', import.meta.url));
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': html.length,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        return res.end(html);
      }

      // health 对任意来源开放（只暴露版本与 token 策略，不泄露工具列表）
      if (req.method === 'GET' && url.pathname === '/v1/health') {
        return sendJson(res, 200, { ok: true, version, tokenRequired: config.auth.requireToken }, cors);
      }

      let tokenRecord = null;
      if (!trusted) {
        if (originHeader && !sameOrigin && !config.origins.includes(originHeader)) {
          return sendJson(res, 403, { ok: false, error: { code: 'E_ORIGIN', message: 'Origin 不在白名单', retryable: false } }, cors);
        }
        if (config.auth.requireToken) {
          const presented = presentedToken(req);
          // 同源演示页按 local 规则校验（本机信任上下文）
          tokenRecord = verifyToken(presented, sameOrigin ? null : originHeader);
          if (!tokenRecord) {
            return sendJson(
              res,
              401,
              {
                ok: false,
                error: {
                  code: 'E_AUTH',
                  message: presented ? 'token 无效或与请求来源不匹配' : '缺少 x-bridge-token（或 Authorization: Bearer）请求头',
                  retryable: false,
                },
              },
              cors
            );
          }
        }
      }
      const tokenKey = trusted ? null : tokenRecord ? tokenRecord.id : 'anon';
      const tokenAudit = trusted ? 'uds' : tokenRecord ? tokenRecord.hash.slice(0, 8) : 'anon';

      if (req.method === 'GET' && url.pathname === '/v1/tools') {
        return sendOk(res, engine.listTools(), 200, cors);
      }

      let m;
      if ((m = url.pathname.match(/^\/v1\/tools\/([^/]+)\/run$/)) && req.method === 'POST') {
        const body = await readJsonBody(req, config.limits.maxBodyBytes);
        const out = await engine.run({
          toolId: decodeURIComponent(m[1]),
          input: body.input,
          options: body.options,
          wait: body.wait !== false,
          timeoutMs: body.timeoutMs,
          origin: originHeader,
          tokenKey,
          tokenAudit,
        });
        return sendOk(res, out.data, out.async ? 202 : 200, cors);
      }

      if ((m = url.pathname.match(/^\/v1\/runs\/([^/]+)$/)) && req.method === 'GET') {
        return sendOk(res, engine.getRun(decodeURIComponent(m[1])), 200, cors);
      }

      if ((m = url.pathname.match(/^\/v1\/runs\/([^/]+)\/cancel$/)) && req.method === 'POST') {
        return sendOk(res, engine.cancel(decodeURIComponent(m[1])), 200, cors);
      }

      // —— OpenAI 兼容层（协议见 docs/PROTOCOL.md §7；鉴权/白名单/频控与原生端点完全一致）——
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        return openai.models(res, cors);
      }
      if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
        return openai.chatCompletions(req, res, cors, { origin: originHeader, tokenKey, tokenAudit });
      }
      if (url.pathname === '/v1/images/generations' && req.method === 'POST') {
        return openai.imagesGenerations(req, res, cors, { origin: originHeader, tokenKey, tokenAudit, localPort: req.socket.localPort });
      }
      let f;
      if ((f = url.pathname.match(/^\/v1\/files\/([^/]+)\/([^/]+)\/([^/]+)$/)) && req.method === 'GET') {
        return openai.serveFile(res, cors, ...f.slice(1).map(decodeURIComponent));
      }

      if (url.pathname === '/v1/events' && req.method === 'GET') {
        const runId = url.searchParams.get('runId');
        if (!runId) throw new BridgeError('E_BAD_REQUEST', '缺少 runId 查询参数');
        return startSse(res, engine, runId, cors);
      }

      throw new BridgeError('E_NOT_FOUND', `未知端点：${req.method} ${url.pathname}`);
    } catch (e) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (e instanceof BridgeError) {
        sendJson(res, e.httpStatus, e.toEnvelope(), cors);
        // 请求体尚未读完时（如超大 body），响应发出后再断开，保证客户端能收到错误
        if (!req.readableEnded) res.once('finish', () => req.destroy());
        return;
      }
      sendJson(res, 500, { ok: false, error: { code: 'E_INTERNAL', message: '服务内部错误', retryable: false } });
    }
  };
}

export function createHttpServer(deps) {
  // 允许传入已构建的 handler，供 HTTP 与 UDS 两个 server 共享同一个处理函数
  const server = http.createServer(deps.handler || createRequestHandler(deps));
  server.requestTimeout = 0; // 同步等待长任务；Node 默认 300s 会掐断 5 分钟超时的 run
  return server;
}
