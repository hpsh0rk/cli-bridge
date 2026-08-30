import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempHome } from './helpers.js';
import { createToken, verifyToken, revokeToken, loadTokens } from '../src/core/tokens.js';

test('per-origin 绑定：token 只对签发的 origin 有效', (t) => {
  useTempHome(t);
  const { token } = createToken({ origin: 'https://site.com' });
  assert.ok(verifyToken(token, 'https://site.com'));
  assert.equal(verifyToken(token, 'https://other.com'), null);
  // 浏览器跨域请求恒带 Origin：无 Origin 时 https token 不生效
  assert.equal(verifyToken(token, null), null);
});

test("local 作用域：无 Origin 的本机 HTTP 客户端（curl/Agent）专用", (t) => {
  useTempHome(t);
  const { token } = createToken({ origin: 'local' });
  assert.ok(verifyToken(token, null));
  assert.equal(verifyToken(token, 'https://site.com'), null);
});

test('篡改/缺失的 token 一律拒绝；服务端只存哈希', (t) => {
  const home = useTempHome(t);
  const { token } = createToken({ origin: 'local' });
  assert.equal(verifyToken('cb_forged', null), null);
  assert.equal(verifyToken('', null), null);
  assert.equal(verifyToken(token.slice(0, -2) + 'xx', null), null);
  const raw = fs.readFileSync(path.join(home, '.cli-bridge', 'tokens.json'), 'utf8');
  assert.ok(!raw.includes(token), 'tokens.json 不得包含明文 token');
});

test('吊销后立即失效；id 前缀歧义时拒绝执行', (t) => {
  useTempHome(t);
  const a = createToken({ origin: 'local', label: 'a' });
  const b = createToken({ origin: 'local', label: 'b' });
  assert.equal(revokeToken('t_').revoked, false, '前缀匹配到多个时拒绝');
  assert.equal(revokeToken(a.record.id).revoked, true);
  assert.equal(verifyToken(a.token, null), null);
  assert.ok(verifyToken(b.token, null));
  assert.equal(loadTokens().length, 1);
});

test('非法 origin 拒绝签发', (t) => {
  useTempHome(t);
  assert.throws(() => createToken({ origin: 'http://site.com' }), /origin/);
  assert.throws(() => createToken({ origin: 'https://has space.com' }), /origin/);
  assert.throws(() => createToken({ origin: '' }), /origin/);
});

test('tokens 文件权限 0600', (t) => {
  const home = useTempHome(t);
  createToken({ origin: 'local' });
  const p = path.join(home, '.cli-bridge', 'tokens.json');
  assert.equal(fs.statSync(p).mode & 0o777, 0o600);
});
