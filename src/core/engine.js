import { BridgeError } from '../errors.js';
import { isAvailable } from '../adapters/registry.js';
import { execAdapter, execAdapterLive, killProcessTree } from './runner.js';

export const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'timeout', 'cancelled']);

export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

/**
 * 核心编排：只认"运行请求"这一个概念，通道层（HTTP/UDS）只做鉴权与传输。
 * 四层白名单的①②在这里落地（③选项校验、④命令模板固化在 runner/registry 层）。
 */
export function createEngine({ config, registry, scheduler, runs, audit }) {
  /** 校验并解析一次运行请求；非法抛 BridgeError。返回适配器声明与有效超时。 */
  function validateRunRequest({ toolId, input, options, timeoutMs, mode }) {
    const decl = registry.get(toolId);
    if (!decl) throw new BridgeError('E_TOOL_NOT_FOUND', `工具不存在：${toolId}`);
    // 层①工具白名单（默认全关）
    if (!config.tools.allow.includes(toolId)) {
      throw new BridgeError('E_TOOL_DISABLED', `工具 ${toolId} 未启用：本机执行 cli-bridge tools allow ${toolId} 后可用`);
    }
    if (!isAvailable(decl)) {
      throw new BridgeError('E_TOOL_UNAVAILABLE', `工具 ${decl.binary} 未安装或不可执行`, { installHint: decl.installHint || '' });
    }
    if (mode === 'image' && !decl.image) {
      throw new BridgeError('E_BAD_REQUEST', `工具 ${toolId} 不支持图片生成`, { detail: [{ field: 'mode', problem: '该适配器未声明 image 能力' }] });
    }
    if (typeof input !== 'string' || input.length === 0) {
      throw new BridgeError('E_BAD_REQUEST', 'input 必须是非空字符串', {
        detail: [{ field: 'input', problem: '必填且为非空字符串' }],
      });
    }
    if (options !== undefined && (typeof options !== 'object' || options === null || Array.isArray(options))) {
      throw new BridgeError('E_BAD_REQUEST', 'options 必须是对象', { detail: [{ field: 'options', problem: '必须是对象' }] });
    }
    // 层③选项白名单：白名单外的任何选项直接拒绝
    const known = new Map(decl.options.map((o) => [o.name, o]));
    for (const [name, value] of Object.entries(options || {})) {
      const opt = known.get(name);
      if (!opt) {
        throw new BridgeError('E_BAD_REQUEST', `选项 ${name} 不在白名单`, {
          detail: [{ field: `options.${name}`, problem: '不在该工具的选项白名单中' }],
        });
      }
      const bad = (problem) => new BridgeError('E_BAD_REQUEST', `选项 ${name} 非法：${problem}`, { detail: [{ field: `options.${name}`, problem }] });
      if (opt.type === 'boolean' && typeof value !== 'boolean') throw bad('必须是 boolean');
      if (opt.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) throw bad('必须是数字');
      if (opt.type === 'string' && typeof value !== 'string') throw bad('必须是字符串');
      if (opt.type === 'enum' && !opt.values.map(String).includes(String(value))) throw bad(`必须是 ${opt.values.map(String).join(' / ')} 之一`);
    }
    let effectiveTimeoutMs = decl.limits.timeoutMs;
    if (timeoutMs !== undefined) {
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > decl.limits.timeoutMs) {
        throw new BridgeError('E_BAD_REQUEST', `timeoutMs 必须是 1-${decl.limits.timeoutMs} 的整数（不超过适配器上限）`, {
          detail: [{ field: 'timeoutMs', problem: `上限 ${decl.limits.timeoutMs}` }],
        });
      }
      effectiveTimeoutMs = timeoutMs;
    }
    return { decl, effectiveTimeoutMs };
  }

  /** 后台执行一次运行：排队 → running → 终态。结果写入 run.result / run.failure。exec 由 engine.run 按 mode 注入。 */
  async function runOne(run, { input, options, timeoutMs, tokenAudit, exec }) {
    const startedAt = Date.now();
    const decl = registry.get(run.toolId);
    try {
      await scheduler.acquire(run.toolId, decl.limits.concurrency);
      try {
        if (run.status === 'cancelled') return; // 排队期间被取消
        run.status = 'running'; // 轮询方需要看到 running 态，不只靠事件流
        runs.emit(run, 'running');
        const outcome = await exec(decl);
        runs.finish(run, { status: 'succeeded', output: outcome.output, meta: outcome.meta });
      } finally {
        run.child = null;
        scheduler.release(run.toolId);
      }
    } catch (e) {
      const be = e instanceof BridgeError ? e : new BridgeError('E_TOOL_FAILED', `工具执行失败：${e?.message || e}`);
      run.failure = be;
      const status = be.code === 'E_TIMEOUT' ? 'timeout' : be.code === 'E_CANCELLED' ? 'cancelled' : 'failed';
      runs.finish(run, { status, error: be.toEnvelope().error });
    } finally {
      audit.log({
        event: 'run',
        runId: run.runId,
        tool: run.toolId,
        origin: run.origin || '(local-channel)',
        token: tokenAudit,
        status: run.status,
        durationMs: Date.now() - startedAt,
        ...(run.mode ? { mode: run.mode } : {}),
        ...(config.log.redactPrompts ? {} : { input }),
      });
    }
  }

  return {
    /** 已启用（白名单内）的适配器能力列表。 */
    listTools() {
      const allow = new Set(config.tools.allow);
      const out = [];
      for (const [id, decl] of registry) {
        if (!allow.has(id)) continue;
        const available = isAvailable(decl);
        out.push({
          id,
          displayName: decl.displayName,
          capabilities: decl.capabilities,
          optionsSchema: decl.options,
          available,
          ...(decl.untested ? { untested: true } : {}),
          ...(available ? {} : { installHint: decl.installHint || '' }),
        });
      }
      return out;
    },

    /**
     * 发起一次运行。
     * wait=true  → 同步等待，resolve { async:false, data:{runId,status,output,meta} } 或 reject BridgeError
     * wait=false → 立即返回   { async:true,  data:{runId,status:'queued'} }，结果走 /v1/runs/:id 轮询
     * mode='stream'：走流式执行器，每个增量文本经 onDelta(text) 回调（OpenAI 兼容层用）；
     * mode='image' ：走图片执行器（文件收割），终态 output 为图片文件名数组。
     */
    async run({ toolId, input, options, wait = true, timeoutMs, origin, tokenKey, tokenAudit, mode, onDelta, onCreate }) {
      // 频控先于其余校验：让扫描/滥用烧掉自己的预算
      scheduler.checkRateLimit(tokenKey ?? null);
      // 队列容量同步预检：保证 wait:false 的提交方也能拿到 E_BUSY（而非 202 后无声失败）
      if (scheduler.waiting >= scheduler.queueDepth) {
        throw new BridgeError('E_BUSY', `任务队列已满（${scheduler.queueDepth}），请稍后重试`, { retryAfterMs: 2000 });
      }
      const { decl, effectiveTimeoutMs } = validateRunRequest({ toolId, input, options, timeoutMs, mode });
      const run = runs.create({ toolId, origin });
      run.mode = mode || null;
      if (onCreate) {
        try {
          onCreate(run); // 首个 await 之前同步调用：调用方此刻即可拿到 runId（SSE 首块带出，供取消用）
        } catch {
          /* 回调异常不影响执行 */
        }
      }
      const isCancelled = () => run.cancelRequested === true;
      const onSpawn = (child) => {
        run.child = child;
      };
      const exec =
        mode === 'image'
          ? (d) => execAdapterLive({ decl: d, input, options, timeoutMs: effectiveTimeoutMs, runId: run.runId, image: d.image, isCancelled, onSpawn })
          : mode === 'stream'
            ? (d) => execAdapterLive({ decl: d, input, options, timeoutMs: effectiveTimeoutMs, runId: run.runId, onDelta, isCancelled, onSpawn })
            : (d) => execAdapter({ decl: d, input, options, timeoutMs: effectiveTimeoutMs, runId: run.runId, isCancelled, onSpawn });
      run.done = runOne(run, { input, options, timeoutMs: effectiveTimeoutMs, tokenAudit, exec });
      run.done.catch(() => {}); // 结果经 run.failure / run.result 读取，防 unhandled rejection
      if (!wait) return { async: true, data: { runId: run.runId, status: run.status } };
      await run.done;
      if (run.failure) throw run.failure;
      if (run.status === 'succeeded') {
        return { async: false, data: { runId: run.runId, status: 'succeeded', output: run.result.output, meta: run.result.meta } };
      }
      throw new BridgeError('E_TOOL_FAILED', `运行以 ${run.status} 结束但缺少错误详情`);
    },

    getRun(runId) {
      const run = runs.get(runId);
      if (!run) throw new BridgeError('E_NOT_FOUND', `运行不存在：${runId}`);
      const data = {
        runId: run.runId,
        tool: run.toolId,
        status: run.status,
        createdAt: run.createdAt,
        events: run.events,
      };
      if (run.result) {
        if (run.result.output !== undefined) data.output = run.result.output;
        if (run.result.meta) data.meta = run.result.meta;
        if (run.result.error) data.error = run.result.error;
      }
      return data;
    },

    subscribeRun(runId, fn) {
      const run = runs.get(runId);
      if (!run) throw new BridgeError('E_NOT_FOUND', `运行不存在：${runId}`);
      return runs.subscribe(run, fn);
    },

    /** 取消运行：杀进程组；排队中的直接标记取消。 */
    cancel(runId) {
      const run = runs.get(runId);
      if (!run) throw new BridgeError('E_NOT_FOUND', `运行不存在：${runId}`);
      if (isTerminalStatus(run.status)) return { runId, status: run.status };
      run.cancelRequested = true;
      if (run.child) {
        killProcessTree(run.child); // close 事件 → E_CANCELLED → finish
        return { runId, status: 'cancelling' };
      }
      run.failure = new BridgeError('E_CANCELLED', '运行已被取消');
      runs.finish(run, { status: 'cancelled', error: run.failure.toEnvelope().error });
      return { runId, status: 'cancelled' };
    },
  };
}
