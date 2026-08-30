import fs from 'node:fs';
import { bridgeDir, tokensPath } from './config.js';
import { sha256hex, constantTimeEqual, randomId, newTokenSecret } from '../util.js';

/**
 * token 作用域：https 站点 origin，或 'local'。
 * 'local' 供 curl / 本机程序 / Agent 等不带 Origin 头的 HTTP 客户端使用；
 * 浏览器跨域请求恒带 Origin，只能匹配签发给该 origin 的 token（per-origin 绑定）。
 */
export function isValidTokenOrigin(origin) {
  return (
    origin === 'local' ||
    (typeof origin === 'string' && origin.startsWith('https://') && !/\s/.test(origin) && origin.length > 8)
  );
}

export function loadTokens() {
  try {
    const list = JSON.parse(fs.readFileSync(tokensPath(), 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

function saveTokens(list) {
  fs.mkdirSync(bridgeDir(), { recursive: true });
  fs.chmodSync(bridgeDir(), 0o700);
  const tmp = `${tokensPath()}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, tokensPath());
  fs.chmodSync(tokensPath(), 0o600);
}

/** 生成并持久化 token；明文只在返回值里出现一次，磁盘只存 SHA-256。 */
export function createToken({ origin, label = '' }) {
  if (!isValidTokenOrigin(origin)) throw new Error(`token origin 非法："${origin}"（须为 https://… 或 local）`);
  const secret = newTokenSecret();
  const record = {
    id: randomId('t'),
    origin,
    label,
    hash: sha256hex(secret),
    createdAt: new Date().toISOString(),
  };
  const list = loadTokens();
  list.push(record);
  saveTokens(list);
  return { token: secret, record: { id: record.id, origin, label, createdAt: record.createdAt } };
}

/**
 * 校验请求携带的 token（恒定时间比较）。
 * - 浏览器请求（带 Origin）：token 必须签发给该 origin；
 * - 无 Origin 的本机 HTTP 客户端：只能使用 origin='local' 的 token。
 */
export function verifyToken(secret, originHeader) {
  if (!secret || typeof secret !== 'string') return null;
  const hash = sha256hex(secret);
  for (const record of loadTokens()) {
    if (typeof record.hash !== 'string') continue;
    if (record.hash.length === hash.length && constantTimeEqual(record.hash, hash)) {
      if (originHeader === null || originHeader === undefined) {
        return record.origin === 'local' ? record : null;
      }
      return record.origin === originHeader ? record : null;
    }
  }
  return null;
}

export function revokeToken(idOrPrefix) {
  const list = loadTokens();
  const matches = list.filter((r) => r.id === idOrPrefix || r.id.startsWith(idOrPrefix));
  if (matches.length !== 1) return { revoked: false, matchCount: matches.length };
  saveTokens(list.filter((r) => r !== matches[0]));
  return { revoked: true, record: { id: matches[0].id, origin: matches[0].origin } };
}
