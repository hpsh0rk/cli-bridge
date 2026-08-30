import crypto from 'node:crypto';

export function sha256hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export function constantTimeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    // 长度不等时也执行一次同长度比较，避免用时序探测长度
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

export function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('base64url')}`;
}

export function newTokenSecret() {
  return `cb_${crypto.randomBytes(32).toString('base64url')}`;
}

/** 点路径取值：getPath(obj, 'a.b.0.c') */
export function getPath(obj, dotted) {
  let cur = obj;
  for (const key of String(dotted).split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}

/** 点路径赋值：setPath(obj, 'a.b', 1)（中间层自动创建） */
export function setPath(obj, dotted, value) {
  const keys = String(dotted).split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof cur[keys[i]] !== 'object' || cur[keys[i]] === null) cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 深合并：src 覆盖 dst；对象递归合并，数组与标量整体替换。返回新对象。 */
export function deepMerge(dst, src) {
  if (!isPlainObject(dst) || !isPlainObject(src)) return src;
  const out = { ...dst };
  for (const [k, v] of Object.entries(src)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

export function deepClone(v) {
  return JSON.parse(JSON.stringify(v));
}
