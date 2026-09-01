import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionStore, sessionKey } from '../src/core/sessions.js';

test('sessionKey：同前缀稳定，跨工具/跨前缀不同', () => {
  assert.equal(sessionKey('agy', 'abc'), sessionKey('agy', 'abc'));
  assert.notEqual(sessionKey('agy', 'abc'), sessionKey('codex', 'abc'));
  assert.notEqual(sessionKey('agy', 'abc'), sessionKey('agy', 'abd'));
});

test('会话映射：save → find 命中；未保存 miss；空 id 不保存', () => {
  const s = createSessionStore();
  const k = sessionKey('agy', 'prefix');
  assert.equal(s.find(k), null);
  s.save(k, '');
  assert.equal(s.find(k), null, '空 conversationId 不应产生映射');
  s.save(k, 'conv-1');
  assert.equal(s.find(k), 'conv-1');
});

test('TTL 过期后 miss', async () => {
  const s = createSessionStore({ ttlMs: 10 });
  const k = sessionKey('agy', 'p');
  s.save(k, 'conv-1');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(s.find(k), null);
});

test('LRU：容量逐出最旧者，命中刷新位置', () => {
  const s = createSessionStore({ maxEntries: 2 });
  const k1 = sessionKey('agy', 'p1');
  const k2 = sessionKey('agy', 'p2');
  const k3 = sessionKey('agy', 'p3');
  s.save(k1, 'c1');
  s.save(k2, 'c2');
  s.find(k1); // 访问 k1 → k2 成为最旧
  s.save(k3, 'c3');
  assert.equal(s.find(k1), 'c1', '刚命中的不应被逐出');
  assert.equal(s.find(k2), null, '最旧的应被逐出');
  assert.equal(s.find(k3), 'c3');
});

test('save 已存在的 key：覆盖并刷新位置', () => {
  const s = createSessionStore({ maxEntries: 2 });
  const k1 = sessionKey('agy', 'p1');
  const k2 = sessionKey('agy', 'p2');
  const k3 = sessionKey('agy', 'p3');
  s.save(k1, 'c1');
  s.save(k2, 'c2');
  s.save(k1, 'c1-new'); // 重存 k1
  s.save(k3, 'c3');
  assert.equal(s.find(k1), 'c1-new');
  assert.equal(s.find(k2), null);
  assert.equal(s.find(k3), 'c3');
});
