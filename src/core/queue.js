import { BridgeError } from '../errors.js';

/**
 * 执行准入控制（DESIGN §7）：
 * - per-token 固定窗口频控（key 为 null 时跳过——UDS 通道是本机可信通道）；
 * - per-tool 并发上限 + 全局队列深度，超出分别抛 E_RATE_LIMIT / E_BUSY。
 */
export class Scheduler {
  constructor(limits) {
    this.runsPerMinute = limits.runsPerMinute;
    this.queueDepth = limits.queueDepth;
    this.waiting = 0; // 全局排队中的任务数
    this.#hits = new Map(); // key → 60s 窗口内的时间戳
    this.#lanes = new Map(); // toolId → { running, waiters }
  }

  #hits;
  #lanes;

  #lane(toolId) {
    let lane = this.#lanes.get(toolId);
    if (!lane) {
      lane = { running: 0, waiters: [] };
      this.#lanes.set(toolId, lane);
    }
    return lane;
  }

  /** 超限抛 E_RATE_LIMIT（附 retryAfterMs）；通过则记一次命中。 */
  checkRateLimit(key) {
    if (key == null) return;
    const now = Date.now();
    const hits = (this.#hits.get(key) || []).filter((t) => now - t < 60_000);
    if (hits.length >= this.runsPerMinute) {
      throw new BridgeError('E_RATE_LIMIT', `超过频控上限：每分钟 ${this.runsPerMinute} 次`, {
        retryAfterMs: 60_000 - (now - hits[0]) + 1,
      });
    }
    hits.push(now);
    this.#hits.set(key, hits);
  }

  /** 取得 per-tool 执行槽位；队列满抛 E_BUSY。FIFO。 */
  async acquire(toolId, concurrency) {
    if (this.waiting >= this.queueDepth) {
      throw new BridgeError('E_BUSY', `任务队列已满（${this.queueDepth}），请稍后重试`, { retryAfterMs: 2000 });
    }
    this.waiting += 1;
    try {
      const lane = this.#lane(toolId);
      if (lane.running < concurrency) {
        lane.running += 1;
        return;
      }
      await new Promise((resolve) => lane.waiters.push(resolve)); // release 转交槽位时唤醒
    } finally {
      this.waiting -= 1;
    }
  }

  release(toolId) {
    const lane = this.#lane(toolId);
    const next = lane.waiters.shift();
    if (next) next(); // 槽位直接转交，running 不变
    else lane.running = Math.max(0, lane.running - 1);
  }
}
