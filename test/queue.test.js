import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler } from '../src/core/queue.js';
import { BridgeError } from '../src/errors.js';

const LIMITS = { runsPerMinute: 2, queueDepth: 8, maxBodyBytes: 1024 };

test('per-token 固定窗口频控：超限抛 E_RATE_LIMIT 且附 retryAfterMs', () => {
  const s = new Scheduler(LIMITS);
  s.checkRateLimit('k');
  s.checkRateLimit('k');
  assert.throws(
    () => s.checkRateLimit('k'),
    (e) => e instanceof BridgeError && e.code === 'E_RATE_LIMIT' && e.extra.retryAfterMs > 0
  );
  // 不同 key 互不影响；null（UDS 通道）不限
  s.checkRateLimit('other');
  s.checkRateLimit(null);
  s.checkRateLimit(null);
  s.checkRateLimit(null);
});

test('per-tool 并发：concurrency=1 时串行，release 转交槽位', async () => {
  const s = new Scheduler(LIMITS);
  await s.acquire('tool', 1);
  let got = false;
  const p = s.acquire('tool', 1).then(() => {
    got = true;
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(got, false, '第二个请求应排队等待');
  s.release('tool');
  await p;
  assert.equal(got, true);
  s.release('tool');
});

test('全局队列深度：waiting 达到上限后抛 E_BUSY', async () => {
  const s = new Scheduler(LIMITS);
  s.waiting = LIMITS.queueDepth;
  await assert.rejects(
    () => s.acquire('tool', 1),
    (e) => e instanceof BridgeError && e.code === 'E_BUSY'
  );
  s.waiting = 0;
  await assert.doesNotReject(() => s.acquire('tool', 4));
});
