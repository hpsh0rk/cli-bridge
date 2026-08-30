import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deepMerge, deepClone, isPlainObject } from '../util.js';
import { validateAdaptersSection } from '../adapters/registry.js';

// ── 安全不变量（DESIGN §5.1）───────────────────────────────────────────────
// 1. 配置只从 ~/.cli-bridge/ 读取，永不读当前工作目录 —— 所有路径都经由本文件取得。
// 2. origins 的持久化增删只能走交互式 CLI；环境变量只能"启动时临时放宽"且必须告警。
// 3. 写入一律走 writeConfig（schema 校验 + 原子写 + 0600）。

export function bridgeDir() {
  return path.join(os.homedir(), '.cli-bridge');
}
export function configPath() {
  return path.join(bridgeDir(), 'config.json');
}
export function tokensPath() {
  return path.join(bridgeDir(), 'tokens.json');
}
export function auditLogPath() {
  return path.join(bridgeDir(), 'audit.log');
}
export function workspaceRoot() {
  return path.join(bridgeDir(), 'workspace');
}
export function socketPath() {
  return process.platform === 'win32'
    ? '\\\\.\\pipe\\cli-bridge'
    : path.join(bridgeDir(), 'bridge.sock');
}

export function defaultConfig() {
  return deepClone({
    server: { port: 39487 }, // host 恒为 127.0.0.1，不提供配置项
    auth: { requireToken: true },
    origins: [],
    tools: { allow: [], overrides: {} },
    adapters: {}, // 声明级覆盖 / 自定义工具（v1 灵活配置入口）
    limits: { runsPerMinute: 10, queueDepth: 8, maxBodyBytes: 1048576 },
    log: { level: 'info', redactPrompts: true, audit: true },
  });
}

/** 读原始配置文件内容（不存在返回 null）。 */
export function readRawConfigFile() {
  try {
    return fs.readFileSync(configPath(), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

/** 校验配置整体合法性；非法抛出含字段路径的错误。 */
export function validateConfig(config) {
  const problems = [];
  const push = (msg) => problems.push(msg);

  if (!isPlainObject(config.server) || !Number.isInteger(config.server.port) || config.server.port < 1 || config.server.port > 65535) {
    push('server.port 必须是 1-65535 的整数');
  }
  if (!isPlainObject(config.auth) || typeof config.auth.requireToken !== 'boolean') {
    push('auth.requireToken 必须是 boolean');
  }
  if (
    !Array.isArray(config.origins) ||
    config.origins.some((o) => typeof o !== 'string' || !o.startsWith('https://') || /\s/.test(o))
  ) {
    push('origins 必须是 https:// 开头的来源字符串数组');
  }
  if (!isPlainObject(config.tools) || !Array.isArray(config.tools.allow) || config.tools.allow.some((s) => typeof s !== 'string' || !s)) {
    push('tools.allow 必须是非空字符串数组（默认全关）');
  }
  if (!isPlainObject(config.tools) || !isPlainObject(config.tools.overrides || {})) {
    push('tools.overrides 必须是对象');
  } else {
    for (const [id, ov] of Object.entries(config.tools.overrides || {})) {
      if (!isPlainObject(ov)) push(`tools.overrides.${id} 必须是对象`);
      else if (ov.timeoutMs !== undefined && (!Number.isInteger(ov.timeoutMs) || ov.timeoutMs < 1)) push(`tools.overrides.${id}.timeoutMs 必须是正整数`);
    }
  }
  try {
    validateAdaptersSection(config.adapters || {});
  } catch (e) {
    push(e.message);
  }
  if (!isPlainObject(config.limits)) {
    push('limits 必须是对象');
  } else {
    for (const k of ['runsPerMinute', 'queueDepth', 'maxBodyBytes']) {
      if (!Number.isInteger(config.limits[k]) || config.limits[k] < 1) push(`limits.${k} 必须是正整数`);
    }
  }
  if (
    !isPlainObject(config.log) ||
    !['debug', 'info', 'warn', 'error'].includes(config.log.level) ||
    typeof config.log.redactPrompts !== 'boolean' ||
    typeof config.log.audit !== 'boolean'
  ) {
    push('log 必须含 level(debug|info|warn|error)、redactPrompts(boolean)、audit(boolean)');
  }

  if (problems.length) throw new Error(`配置非法：\n  - ${problems.join('\n  - ')}`);
}

/**
 * 加载配置：内置默认 < ~/.cli-bridge/config.json < 环境变量（CLI 显式 flags 由调用方再叠加）。
 * 返回 { config, warnings }；warnings 会打进启动横幅。
 */
export function loadConfig({ env = process.env } = {}) {
  const warnings = [];
  let raw = {};
  const text = readRawConfigFile();
  if (text !== null) {
    try {
      raw = JSON.parse(text);
    } catch (e) {
      throw new Error(`${configPath()} 不是合法 JSON：${e.message}`);
    }
    if (!isPlainObject(raw)) throw new Error(`${configPath()} 顶层必须是对象`);
    const mode = fs.statSync(configPath()).mode & 0o777;
    if (mode & 0o077) warnings.push(`配置文件权限过宽（${mode.toString(8)}），建议执行 chmod 600 ${configPath()}`);
  }

  const config = deepMerge(defaultConfig(), raw);

  if (env.CLI_BRIDGE_PORT) {
    const p = Number(env.CLI_BRIDGE_PORT);
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`CLI_BRIDGE_PORT 非法：${env.CLI_BRIDGE_PORT}`);
    config.server.port = p;
  }
  if (env.CLI_BRIDGE_LOG_LEVEL) config.log.level = env.CLI_BRIDGE_LOG_LEVEL;
  if (env.CLI_BRIDGE_REQUIRE_TOKEN !== undefined) {
    if (env.CLI_BRIDGE_REQUIRE_TOKEN === 'false') {
      config.auth.requireToken = false;
      warnings.push('CLI_BRIDGE_REQUIRE_TOKEN=false 关闭了 token 校验（仅本次启动生效）');
    }
  }
  if (env.CLI_BRIDGE_ORIGINS) {
    const list = env.CLI_BRIDGE_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
    config.origins = [...new Set([...config.origins, ...list])];
    warnings.push(`CLI_BRIDGE_ORIGINS 临时放宽了来源白名单（仅本次启动生效）：${list.join(', ')}`);
  }

  validateConfig(config);
  return { config, warnings };
}

/** schema 校验 + 原子写入 + 0600（目录 0700）。 */
export function writeConfig(config) {
  validateConfig(config);
  fs.mkdirSync(bridgeDir(), { recursive: true });
  fs.chmodSync(bridgeDir(), 0o700);
  const file = configPath();
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}
