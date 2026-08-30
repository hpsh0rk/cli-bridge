import fs from 'node:fs';
import path from 'node:path';
import { BridgeError } from '../errors.js';
import { readJsonBody } from './body.js';
import { workspaceRoot } from '../core/config.js';

/**
 * OpenAI 兼容层（协议见 docs/PROTOCOL.md §7）：
 *   GET  /v1/models              工具 → model 列表
 *   POST /v1/chat/completions    同步 + SSE 流式（model = 工具 id）
 *   POST /v1/images/generations  图片生成（OpenAI Images 协议，b64_json / url）
 *   GET  /v1/files/:tool/:runId/:file  图片文件（url 模式取回用；需 token 头）
 *
 * 错误响应用 OpenAI 信封 {"error":{message,type,code,param}}，接入方按 OpenAI 语义处理。
 * 目标是"无缝接入"：openai 官方 SDK / 各类聊天前端把 base_url 指到本桥即可。
 */

const ERROR_TYPES = {
  E_AUTH: ['authentication_error', 401],
  E_ORIGIN: ['invalid_request_error', 403],
  E_TOOL_NOT_FOUND: ['invalid_request_error', 404],
  E_TOOL_DISABLED: ['invalid_request_error', 403],
  E_TOOL_UNAVAILABLE: ['api_error', 503],
  E_RATE_LIMIT: ['rate_limit_error', 429],
  E_BUSY: ['rate_limit_error', 503],
  E_TIMEOUT: ['api_error', 504],
  E_TOOL_FAILED: ['api_error', 502],
  E_BAD_REQUEST: ['invalid_request_error', 400],
  E_CANCELLED: ['api_error', 409],
  E_NOT_FOUND: ['invalid_request_error', 404],
  E_INTERNAL: ['api_error', 500],
};

export function openaiErrorPayload(be) {
  const [type, status] = ERROR_TYPES[be.code] || ['api_error', 500];
  return {
    status,
    body: { error: { message: be.message, type, param: null, code: be.code, ...(be.extra || {}) } },
  };
}

function sendOpenAiError(res, be) {
  const { status, body } = openaiErrorPayload(be);
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

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

/** OpenAI messages → 桥 input。多轮对话拍平成带角色标签的转写（CLI 是单次调用，无会话态）。 */
export function composeInput(messages) {
  const text = (c) => {
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.filter((p) => p && p.type === 'text' && p.text).map((p) => p.text).join('\n');
    return '';
  };
  const convo = messages.map((m) => ({ role: m.role, content: text(m.content) }));
  if (!convo.some((m) => m.role === 'assistant')) {
    // 单轮：system + user 原样拼接，不加标签噪音
    const system = convo.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    const users = convo.filter((m) => m.role === 'user').map((m) => m.content).join('\n\n');
    return [system, users].filter(Boolean).join('\n\n');
  }
  const label = { system: 'System', user: 'User', assistant: 'Assistant' };
  return convo.map((m) => `${label[m.role] || m.role}: ${m.content}`).join('\n\n');
}

function mapUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined;
  const input = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0);
  const output = Number(usage.output_tokens ?? usage.completion_tokens ?? 0);
  const total = Number(usage.total_tokens ?? input + output);
  return { prompt_tokens: input, completion_tokens: output, total_tokens: total };
}

function chunkLine(id, created, model, delta, finishReason, usage, bridgeRunId) {
  const chunk = {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  if (usage) chunk.usage = usage;
  if (bridgeRunId) chunk.bridge_run_id = bridgeRunId; // 桥扩展字段：OpenAI 客户端会忽略；网页端用于取消运行
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

const FILE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

export function createOpenAiHandlers({ config, engine }) {
  function models(res, cors) {
    const data = engine.listTools().filter((t) => t.available).map((t) => ({ id: t.id, object: 'model', created: 0, owned_by: 'cli-bridge' }));
    return sendJson(res, 200, { object: 'list', data }, cors);
  }

  async function chatCompletions(req, res, cors, { origin, tokenKey, tokenAudit }) {
    let body;
    try {
      body = await readJsonBody(req, config.limits.maxBodyBytes);
    } catch (e) {
      return sendOpenAiError(res, e);
    }
    if (typeof body.model !== 'string' || !body.model) {
      return sendOpenAiError(res, new BridgeError('E_BAD_REQUEST', 'model is required（填工具 id，如 "agy"）'));
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.some((m) => !m || typeof m !== 'object')) {
      return sendOpenAiError(res, new BridgeError('E_BAD_REQUEST', 'messages is required（OpenAI chat 格式数组）'));
    }
    const input = composeInput(body.messages);
    const id = `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const created = Math.floor(Date.now() / 1000);
    const runOpts = { toolId: body.model, input, origin, tokenKey, tokenAudit };

    if (body.stream === true) {
      res.writeHead(200, {
        ...cors,
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      const write = (s) => {
        try {
          res.write(s);
        } catch {
          /* 客户端已断开 */
        }
      };
      try {
        // chat/completions 恒走流式管线（与流式请求同一命令路径，同步/流式行为一致）。
        // engine.run 的同步段会先创建 run 并触发 onCreate——首块数据因此能带上 runId（供 /v1/runs/:id/cancel）。
        let bridgeRunId = null;
        const outP = engine.run({
          ...runOpts,
          mode: 'stream',
          onCreate: (r) => {
            bridgeRunId = r.runId;
          },
          onDelta: (t) => write(chunkLine(id, created, body.model, { content: t }, null, undefined, bridgeRunId)),
        });
        write(chunkLine(id, created, body.model, { role: 'assistant', content: '' }, null, undefined, bridgeRunId));
        const out = await outP;
        write(chunkLine(id, created, body.model, {}, 'stop', undefined, bridgeRunId));
        // OpenAI 规范：stream_options.include_usage 时，末尾追加 choices 为空的用量块
        if (body.stream_options?.include_usage) {
          const usage = mapUsage(out.data.meta?.usage);
          if (usage) {
            write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [], usage })}\n\n`);
          }
        }
        write('data: [DONE]\n\n');
      } catch (e) {
        write(`data: ${JSON.stringify({ error: openaiErrorPayload(e).body.error })}\n\n`);
        write('data: [DONE]\n\n');
      }
      return res.end();
    }

    try {
      const out = await engine.run({ ...runOpts, mode: 'stream' });
      return sendJson(res, 200, {
        id,
        object: 'chat.completion',
        created,
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: String(out.data.output ?? '') }, finish_reason: 'stop' }],
        usage: mapUsage(out.data.meta?.usage) ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }, cors);
    } catch (e) {
      return sendOpenAiError(res, e);
    }
  }

  async function imagesGenerations(req, res, cors, { origin, tokenKey, tokenAudit, localPort }) {
    let body;
    try {
      body = await readJsonBody(req, config.limits.maxBodyBytes);
    } catch (e) {
      return sendOpenAiError(res, e);
    }
    if (typeof body.model !== 'string' || !body.model) {
      return sendOpenAiError(res, new BridgeError('E_BAD_REQUEST', 'model is required（填图片工具 id，如 "agy"）'));
    }
    if (typeof body.prompt !== 'string' || !body.prompt.trim()) {
      return sendOpenAiError(res, new BridgeError('E_BAD_REQUEST', 'prompt is required'));
    }
    const n = body.n ?? 1;
    if (n !== 1) {
      return sendOpenAiError(res, new BridgeError('E_BAD_REQUEST', 'only n=1 is supported（本桥单次产出一张图）'));
    }
    const responseFormat = body.response_format ?? 'b64_json';
    if (!['b64_json', 'url'].includes(responseFormat)) {
      return sendOpenAiError(res, new BridgeError('E_BAD_REQUEST', 'response_format must be "b64_json" or "url"'));
    }
    // size / quality / style 等参数静默忽略：CLI 工具不保证按精确尺寸产出（协议文档已注明）

    let out;
    try {
      out = await engine.run({ toolId: body.model, input: body.prompt, mode: 'image', origin, tokenKey, tokenAudit });
    } catch (e) {
      return sendOpenAiError(res, e);
    }
    const runId = out.data.runId;
    const files = Array.isArray(out.data.output) ? out.data.output : [];
    const dir = path.join(workspaceRoot(), body.model, runId);
    const data = files.map((f) =>
      responseFormat === 'url'
        ? { url: `http://127.0.0.1:${localPort}/v1/files/${body.model}/${runId}/${encodeURIComponent(f)}` }
        : { b64_json: fs.readFileSync(path.join(dir, f)).toString('base64') }
    );
    return sendJson(res, 200, { created: Math.floor(Date.now() / 1000), data }, cors);
  }

  function serveFile(res, cors, toolId, runId, file) {
    const safe = (s) => typeof s === 'string' && s.length > 0 && !s.includes('..') && !s.includes('/') && !s.includes('\\');
    const full = safe(toolId) && safe(runId) && safe(file) ? path.join(workspaceRoot(), toolId, runId, file) : null;
    if (!full || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
      return sendOpenAiError(res, new BridgeError('E_NOT_FOUND', 'file not found or expired'));
    }
    const type = FILE_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const stat = fs.statSync(full);
    res.writeHead(200, { ...cors, 'Content-Type': type, 'Content-Length': stat.size, 'Cache-Control': 'private, max-age=600' });
    fs.createReadStream(full).pipe(res);
  }

  return { models, chatCompletions, imagesGenerations, serveFile };
}
