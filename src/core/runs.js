import { randomId } from '../util.js';

const RETENTION_MS = 10 * 60 * 1000; // 终态运行记录保留 10 分钟供轮询查询

/**
 * 运行注册表（进程内内存态）：
 * status: queued → running → succeeded | failed | timeout | cancelled
 * 每次状态迁移都会产生一条事件（供 SSE 与轮询）。
 */
export class RunStore {
  #runs = new Map();

  create({ toolId, origin }) {
    const run = {
      runId: randomId('r'),
      toolId,
      origin: origin || null,
      status: 'queued',
      createdAt: new Date().toISOString(),
      events: [{ type: 'queued', ts: Date.now() }],
      listeners: new Set(),
      cancelRequested: false,
      child: null,
      result: null, // 终态结果：{ status, output?, meta?, error? }
      failure: null, // 终态对应的 BridgeError（同步等待方重新抛出用）
      done: null, // 执行完成 promise
    };
    this.#runs.set(run.runId, run);
    return run;
  }

  get(runId) {
    return this.#runs.get(runId) || null;
  }

  emit(run, type, payload = {}) {
    const ev = { type, ts: Date.now(), ...payload };
    run.events.push(ev);
    for (const fn of run.listeners) {
      try {
        fn(ev);
      } catch {
        /* 订阅方异常不影响执行 */
      }
    }
    return ev;
  }

  finish(run, result) {
    run.result = result;
    run.status = result.status;
    this.emit(run, result.status, result.error ? { error: result.error } : {});
    const t = setTimeout(() => this.#runs.delete(run.runId), RETENTION_MS);
    if (typeof t.unref === 'function') t.unref();
  }

  subscribe(run, fn) {
    run.listeners.add(fn);
    return () => run.listeners.delete(fn);
  }
}
