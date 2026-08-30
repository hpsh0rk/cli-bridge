import fs from 'node:fs';
import path from 'node:path';
import { deepClone, deepMerge, isPlainObject } from '../util.js';
import agyDeclaration from './agy.js';
import codexDeclaration from './codex.js';

export const BUILT_INS = new Map([
  [agyDeclaration.id, agyDeclaration],
  [codexDeclaration.id, codexDeclaration],
]);

const OUTPUT_MODES = new Set(['json', 'text', 'ndjson']);
const OPTION_TYPES = new Set(['string', 'number', 'boolean', 'enum']);

/** 校验单条适配器声明；非法抛错（错误信息含工具 id，便于定位配置问题）。 */
export function validateDeclaration(decl, context = '') {
  const where = context || decl?.id || '(unknown)';
  const fail = (msg) => {
    throw new Error(`适配器声明无效 [${where}]：${msg}`);
  };
  if (!isPlainObject(decl)) fail('必须是对象');
  if (typeof decl.id !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(decl.id)) fail('id 须为小写标识符');
  if (typeof decl.displayName !== 'string' || !decl.displayName) fail('displayName 缺失');
  if (typeof decl.binary !== 'string' || !decl.binary) fail('binary 缺失');
  if (decl.installHint !== undefined && typeof decl.installHint !== 'string') fail('installHint 须为字符串');

  if (!isPlainObject(decl.run)) fail('run 缺失');
  if (!Array.isArray(decl.run.args) || decl.run.args.length === 0 || decl.run.args.some((a) => typeof a !== 'string')) {
    fail('run.args 须为非空字符串数组');
  }
  // 命令模板固化（DESIGN §4.2 层④）：{input} 是唯一允许的模板变量，且必须恰好出现一次
  const inputSlots = decl.run.args.filter((a) => a.includes('{input}')).length;
  if (inputSlots !== 1) fail('run.args 必须恰好包含一个 {input} 槽位');
  for (const a of decl.run.args) {
    if (a !== '{input}' && /\{\w+\}/.test(a)) fail(`run.args 出现未知模板变量（只允许整段 {input}）：${a}`);
  }
  if (!OUTPUT_MODES.has(decl.run.output)) fail(`run.output 须为 ${[...OUTPUT_MODES].join(' / ')}`);
  if (decl.run.output === 'json' && (typeof decl.run.jsonResponsePath !== 'string' || !decl.run.jsonResponsePath)) {
    fail('json 输出须声明 jsonResponsePath');
  }
  if (decl.run.output === 'ndjson') {
    if (typeof decl.run.ndjsonTextPath !== 'string' || !decl.run.ndjsonTextPath) fail('ndjson 输出须声明 ndjsonTextPath');
    if (decl.run.ndjsonPick !== undefined && !isPlainObject(decl.run.ndjsonPick)) fail('ndjsonPick 须为"点路径 → 期望值"对象');
  }

  if (!isPlainObject(decl.capabilities)) fail('capabilities 缺失');
  for (const k of ['text', 'image', 'stream']) {
    if (typeof decl.capabilities[k] !== 'boolean') fail(`capabilities.${k} 须为 boolean`);
  }
  if (!isPlainObject(decl.limits)) fail('limits 缺失');
  for (const k of ['timeoutMs', 'concurrency', 'outputMaxBytes']) {
    if (!Number.isInteger(decl.limits[k]) || decl.limits[k] < 1) fail(`limits.${k} 须为正整数`);
  }

  if (!Array.isArray(decl.options)) fail('options 须为数组（页面可覆盖的选项白名单，默认空）');
  for (const opt of decl.options) {
    if (!isPlainObject(opt) || typeof opt.name !== 'string' || typeof opt.flag !== 'string' || !OPTION_TYPES.has(opt.type)) {
      fail(`options 项须含 name / flag / type（${[...OPTION_TYPES].join(',')}）`);
    }
    if (opt.type === 'enum' && (!Array.isArray(opt.values) || opt.values.length === 0)) {
      fail(`enum 选项 ${opt.name} 须提供 values`);
    }
  }

  if (decl.probe !== undefined) {
    if (!isPlainObject(decl.probe) || !Array.isArray(decl.probe.args) || decl.probe.args.some((a) => typeof a !== 'string')) {
      fail('probe.args 须为字符串数组');
    }
  }

  if (decl.stream !== undefined) {
    const st = decl.stream;
    if (!isPlainObject(st)) fail('stream 须为对象');
    if (!Array.isArray(st.args) || st.args.length === 0 || st.args.some((a) => typeof a !== 'string')) {
      fail('stream.args 须为非空字符串数组');
    }
    if (st.args.filter((a) => a.includes('{input}')).length !== 1) fail('stream.args 必须恰好包含一个 {input} 槽位');
    for (const a of st.args) {
      if (a !== '{input}' && /\{\w+\}/.test(a)) fail(`stream.args 出现未知模板变量：${a}`);
    }
    if (st.deltas !== undefined && (!isPlainObject(st.deltas) || !isPlainObject(st.deltas.when) || typeof st.deltas.path !== 'string' || !st.deltas.path)) {
      fail('stream.deltas 须为 { when, path }（when 为点路径匹配，path 为增量文本字段）');
    }
    // final 可选：图片类适配器靠文件收割结算，不需要从事件流提取最终文本
    if (
      st.final !== undefined &&
      (!isPlainObject(st.final) || !isPlainObject(st.final.when) || typeof st.final.outputPath !== 'string' || !st.final.outputPath)
    ) {
      fail('stream.final 须为 { when, outputPath[, statusPath, successValues, usagePath] }');
    }
    if (st.final?.statusPath && (!Array.isArray(st.final.successValues) || st.final.successValues.length === 0)) {
      fail('stream.final 声明 statusPath 时必须提供 successValues');
    }
  }

  if (decl.image !== undefined) {
    const im = decl.image;
    if (!isPlainObject(im)) fail('image 须为对象');
    if (im.extraArgs !== undefined && (!Array.isArray(im.extraArgs) || im.extraArgs.some((a) => typeof a !== 'string'))) {
      fail('image.extraArgs 须为字符串数组');
    }
    if (!Array.isArray(im.extensions) || im.extensions.length === 0 || im.extensions.some((e) => !/^\.\w+$/.test(e))) {
      fail('image.extensions 须为 ".png" 形式的扩展名数组');
    }
    if (im.fileStableMs !== undefined && (!Number.isInteger(im.fileStableMs) || im.fileStableMs < 1)) {
      fail('image.fileStableMs 须为正整数');
    }
    if (im.toolName !== undefined && typeof im.toolName !== 'string') fail('image.toolName 须为字符串');
  }
}

/** 校验 config.adapters 段的结构（详细字段校验在合并后由 validateDeclaration 完成）。 */
export function validateAdaptersSection(section) {
  if (!isPlainObject(section)) throw new Error('adapters 段必须是对象');
  for (const [id, patch] of Object.entries(section)) {
    if (!/^[a-z][a-z0-9_-]*$/.test(id)) throw new Error(`adapters 的键须为小写标识符：${id}`);
    if (!isPlainObject(patch)) throw new Error(`adapters.${id} 必须是对象`);
  }
}

/**
 * 构建适配器注册表：
 *   内置声明（agy 实测 / codex 声明未实测）
 *   < config.adapters 覆盖或新增自定义工具（声明级深合并）
 *   < tools.overrides 收窄性覆盖（仅 timeoutMs / options 白名单）
 */
export function buildRegistry(config) {
  validateAdaptersSection(config.adapters || {});
  const registry = new Map();
  for (const [id, decl] of BUILT_INS) registry.set(id, deepClone(decl));

  for (const [id, patch] of Object.entries(config.adapters || {})) {
    const base = registry.get(id) || { id };
    const merged = deepMerge(deepClone(base), patch);
    merged.id = id;
    validateDeclaration(merged, id);
    registry.set(id, merged);
  }

  const overrides = config.tools?.overrides || {};
  for (const [id, ov] of Object.entries(overrides)) {
    const decl = registry.get(id);
    if (!decl) throw new Error(`tools.overrides 指向未声明工具：${id}`);
    if (ov.timeoutMs !== undefined) decl.limits.timeoutMs = ov.timeoutMs;
    if (ov.options !== undefined) decl.options = deepClone(ov.options);
    validateDeclaration(decl, id);
  }
  return registry;
}

/** 沿 PATH 探测二进制（纯 fs 检查，无副作用、不 spawn）。 */
export function findBinary(binary) {
  if (binary.includes('/')) {
    try {
      return fs.statSync(binary).isFile() ? binary : null;
    } catch {
      return null;
    }
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, binary);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      if (fs.statSync(full).isFile()) return full;
    } catch {
      /* 继续找下一目录 */
    }
  }
  return null;
}

export function isAvailable(decl) {
  return !!findBinary(decl.binary);
}
