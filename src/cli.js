import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import {
  loadConfig,
  writeConfig,
  readRawConfigFile,
  configPath,
  tokensPath,
  auditLogPath,
  socketPath,
} from './core/config.js';
import { buildRegistry, findBinary } from './adapters/registry.js';
import { Scheduler } from './core/queue.js';
import { RunStore } from './core/runs.js';
import { Audit } from './core/audit.js';
import { createEngine } from './core/engine.js';
import { createRequestHandler, createHttpServer } from './server/http.js';
import { startUdsChannel } from './server/uds.js';
import { loadTokens, createToken, revokeToken, isValidTokenOrigin } from './core/tokens.js';
import { deepMerge, getPath, setPath } from './util.js';

function getVersion() {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[a.slice(2)] = next;
          i += 1;
        } else {
          flags[a.slice(2)] = true;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

async function confirm(question, skip) {
  if (skip) return true;
  if (!process.stdin.isTTY) {
    console.error('非交互环境需要 --yes 确认。');
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((r) => rl.question(`${question} [y/N] `, r));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

function loadConfigOrExit() {
  try {
    return loadConfig();
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
    return null;
  }
}

// ── start ────────────────────────────────────────────────────────────────

async function cmdStart(flags) {
  const loaded = loadConfigOrExit();
  if (!loaded) return;
  const { config, warnings } = loaded;
  if (flags.port !== undefined && flags.port !== true) {
    const p = Number(flags.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      console.error(`--port 非法：${flags.port}`);
      process.exitCode = 1;
      return;
    }
    config.server.port = p;
  }

  let registry;
  try {
    registry = buildRegistry(config);
  } catch (e) {
    console.error(`适配器声明有误：${e.message}`);
    process.exitCode = 1;
    return;
  }
  const unknownAllow = config.tools.allow.filter((id) => !registry.has(id));
  if (unknownAllow.length) warnings.push(`tools.allow 包含未声明工具：${unknownAllow.join(', ')}`);

  const scheduler = new Scheduler(config.limits);
  const engine = createEngine({
    config,
    registry,
    scheduler,
    runs: new RunStore(),
    audit: new Audit(config),
  });
  // HTTP 与 UDS 两个通道共享同一个请求处理函数
  const handler = createRequestHandler({ config, engine, version: getVersion(), verbose: Boolean(flags.verbose) });
  const httpServer = createHttpServer({ handler });
  try {
    await new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(config.server.port, '127.0.0.1', resolve);
    });
  } catch (e) {
    if (e.code === 'EADDRINUSE') {
      console.error(`启动失败：127.0.0.1:${config.server.port} 已被占用。换端口启动：cli-bridge start --port <N>`);
      process.exitCode = 1;
      return;
    }
    throw e;
  }

  let uds;
  try {
    uds = await startUdsChannel(handler);
  } catch (e) {
    httpServer.close();
    console.error(`UDS 通道启动失败：${e.message}`);
    process.exitCode = 1;
    return;
  }
  // 记录本实例 socket 的 inode：退出时只删除仍属于自己的文件。
  // 否则旧实例的延迟关闭会按路径误删新实例刚创建的 socket（实测发生过的竞态）。
  let sockIno = null;
  try {
    sockIno = fs.statSync(socketPath()).ino;
  } catch {
    /* win32 命名管道无文件 */
  }

  const originsNote = config.origins.length ? `${config.origins.length} 个（cli-bridge origins list 查看）` : '空 —— 网页调用前先 origins add';
  const allowNote = config.tools.allow.length ? config.tools.allow.join(', ') : '空 —— 先执行 cli-bridge tools allow <id>';
  console.log(`cli-bridge v${getVersion()} 已启动`);
  console.log(`  HTTP   http://127.0.0.1:${config.server.port}     token：${config.auth.requireToken ? '必须（x-bridge-token 头）' : '未要求 ⚠'}`);
  console.log(`  UDS    ${socketPath()}   本机程序免 token`);
  console.log(`  工具   ${allowNote}`);
  console.log(`  来源   ${originsNote}`);
  console.log(`  限制   ${config.limits.runsPerMinute} 次/分钟 · 队列 ${config.limits.queueDepth} · 请求体上限 ${Math.round(config.limits.maxBodyBytes / 1024)}KB`);
  console.log(`  协议   docs/PROTOCOL.md · 诊断 cli-bridge doctor`);
  for (const w of warnings) console.log(`  ⚠ ${w}`);

  const shutdown = () => {
    console.log('\n正在关闭…');
    httpServer.close();
    try {
      uds.close();
    } catch {
      /* 忽略 */
    }
    if (process.platform !== 'win32') {
      try {
        const st = fs.statSync(socketPath());
        if (sockIno !== null && st.ino === sockIno) fs.unlinkSync(socketPath());
      } catch {
        /* 文件已不存在或属于新实例 */
      }
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// ── tools / origins / token / config ─────────────────────────────────────

async function cmdTools(sub, positional, flags) {
  const loaded = loadConfigOrExit();
  if (!loaded) return;
  const { config } = loaded;
  let registry;
  try {
    registry = buildRegistry(config);
  } catch (e) {
    console.error(`适配器声明有误：${e.message}`);
    process.exitCode = 1;
    return;
  }

  if (sub === 'list' || sub === undefined) {
    console.log('id       名称               白名单  二进制  备注');
    for (const [id, decl] of registry) {
      const bin = findBinary(decl.binary);
      console.log(
        `${id.padEnd(8)} ${(decl.displayName || '').padEnd(18)} ${(config.tools.allow.includes(id) ? '✓' : '✗').padEnd(6)} ${bin ? '✓' : '✗'}       ${
          decl.untested ? '声明未实测' : ''
        }`.trimEnd()
      );
    }
    console.log('\n启用：cli-bridge tools allow <id> · 禁用：cli-bridge tools deny <id>');
    return;
  }

  if (sub === 'allow' || sub === 'deny') {
    const id = positional[0];
    if (!id) {
      console.error(`用法：cli-bridge tools ${sub} <id>`);
      process.exitCode = 1;
      return;
    }
    if (sub === 'allow' && !registry.has(id)) {
      console.error(`工具 ${id} 未声明。可用：${[...registry.keys()].join(', ')}；自定义工具写入 ~/.cli-bridge/config.json 的 adapters 段。`);
      process.exitCode = 1;
      return;
    }
    const set = new Set(config.tools.allow);
    const changing = sub === 'allow' ? !set.has(id) : set.has(id);
    if (!changing) {
      console.log(`工具 ${id} 已经${sub === 'allow' ? '在' : '不在'}白名单中，无需变更。`);
      return;
    }
    if (sub === 'allow') {
      const decl = registry.get(id);
      const ok = await confirm(`允许通过桥调用 ${id}（${decl?.displayName || id}）？网页将只能执行该工具固化的命令模板`, flags.yes === true);
      if (!ok) {
        console.log('已取消。');
        return;
      }
    }
    if (sub === 'allow') set.add(id);
    else set.delete(id);
    config.tools.allow = [...set];
    writeConfig(config);
    console.log(`已${sub === 'allow' ? '启用' : '禁用'} ${id}。重启 cli-bridge start 后生效。`);
    return;
  }

  console.error('用法：cli-bridge tools list | allow <id> | deny <id>');
  process.exitCode = 1;
}

async function cmdOrigins(sub, positional, flags) {
  const loaded = loadConfigOrExit();
  if (!loaded) return;
  const { config } = loaded;

  if (sub === 'list' || sub === undefined) {
    if (!config.origins.length) return console.log('（空）网页调用前先：cli-bridge origins add https://your-site.com');
    for (const o of config.origins) console.log(o);
    return;
  }

  if (sub === 'add') {
    const url = positional[0];
    if (!url || !url.startsWith('https://') || /\s/.test(url)) {
      console.error('用法：cli-bridge origins add https://your-site.com（仅允许 https）');
      process.exitCode = 1;
      return;
    }
    if (config.origins.includes(url)) return console.log('该来源已在白名单中。');
    if (!(await confirm(`允许 ${url} 通过桥调用本机工具？（该站仍需持有为它签发的 token）`, flags.yes === true))) {
      return console.log('已取消。');
    }
    config.origins.push(url);
    writeConfig(config);
    console.log(`已添加 ${url}。重启 cli-bridge start 后生效；接着为它签发 token：cli-bridge token create --origin ${url}`);
    return;
  }

  if (sub === 'remove') {
    const url = positional[0];
    if (!config.origins.includes(url)) return console.error(`白名单中没有 ${url}`);
    config.origins = config.origins.filter((o) => o !== url);
    writeConfig(config);
    console.log(`已移除 ${url}（对应 token 建议一并吊销：cli-bridge token list）。重启后生效。`);
    return;
  }

  console.error('用法：cli-bridge origins list | add <url> | remove <url>');
  process.exitCode = 1;
}

function copyToClipboard(text) {
  if (process.platform !== 'darwin') return false;
  try {
    const p = spawn('pbcopy', [], { stdio: ['pipe', 'ignore', 'ignore'] });
    p.stdin.end(text);
    return true;
  } catch {
    return false;
  }
}

function cmdToken(sub, positional, flags) {
  if (sub === 'create') {
    const origin = flags.origin;
    if (!origin || origin === true) {
      console.error('用法：cli-bridge token create --origin https://your-site.com [--label 说明]');
      console.error('      本机 curl / Agent 的 HTTP 调用使用：--origin local');
      process.exitCode = 1;
      return;
    }
    if (!isValidTokenOrigin(origin)) {
      console.error(`origin 非法："${origin}"（须为 https://… 或 local）`);
      process.exitCode = 1;
      return;
    }
    const { token, record } = createToken({ origin, label: typeof flags.label === 'string' ? flags.label : '' });
    const copied = copyToClipboard(token);
    console.log(`已为 ${record.origin} 签发 token（只显示这一次，服务端只存哈希）：\n`);
    console.log(token);
    console.log('');
    console.log(copied ? '已复制到剪贴板。' : '请手动复制。');
    console.log('网页端把 token 放进请求头 x-bridge-token；吊销：cli-bridge token revoke ' + record.id);
    return;
  }

  if (sub === 'list' || sub === undefined) {
    const list = loadTokens();
    if (!list.length) return console.log('（空）签发：cli-bridge token create --origin https://your-site.com');
    console.log('id         作用域                标签      创建时间             哈希前8位');
    for (const t of list) {
      console.log(
        `${t.id.padEnd(10)} ${(t.origin || '').padEnd(20)} ${(t.label || '').padEnd(8)} ${(t.createdAt || '').padEnd(19)} ${(t.hash || '').slice(0, 8)}`
      );
    }
    return;
  }

  if (sub === 'revoke') {
    const id = positional[0];
    if (!id) {
      console.error('用法：cli-bridge token revoke <id 或 id 前缀>');
      process.exitCode = 1;
      return;
    }
    const r = revokeToken(id);
    if (!r.revoked) {
      console.error(r.matchCount === 0 ? `未找到 token：${id}` : `id 前缀匹配到 ${r.matchCount} 个 token，请写更长的前缀`);
      process.exitCode = 1;
      return;
    }
    console.log(`已吊销 ${r.record.id}（${r.record.origin}）。`);
    return;
  }

  console.error('用法：cli-bridge token list | create --origin <url|local> [--label L] | revoke <id>');
  process.exitCode = 1;
}

function cmdConfig(sub, positional) {
  if (sub === 'get') {
    const loaded = loadConfigOrExit();
    if (!loaded) return;
    const key = positional[0];
    if (!key) return console.log(JSON.stringify(loaded.config, null, 2));
    const v = getPath(loaded.config, key);
    if (v === undefined) {
      console.error(`配置项不存在：${key}`);
      process.exitCode = 1;
      return;
    }
    console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
    return;
  }

  if (sub === 'set') {
    const [key, ...rest] = positional;
    const rawValue = rest.join(' ');
    if (!key || !rawValue) {
      console.error('用法：cli-bridge config set <key> <value>   例：config set server.port 39487');
      process.exitCode = 1;
      return;
    }
    let value;
    try {
      value = JSON.parse(rawValue);
    } catch {
      value = rawValue; // 字符串按原样保存
    }
    const raw = readRawConfigFile();
    const fileConfig = raw ? JSON.parse(raw) : {};
    setPath(fileConfig, key, value);
    const merged = deepMerge(loadConfig({ env: {} }).config, fileConfig);
    try {
      writeConfig(merged);
    } catch (e) {
      console.error(`写入失败：${e.message}`);
      process.exitCode = 1;
      return;
    }
    console.log(`已写入 ${key} = ${JSON.stringify(value)}（${configPath()}）`);
    return;
  }

  console.error('用法：cli-bridge config get [key] | set <key> <value>');
  process.exitCode = 1;
}

// ── doctor ───────────────────────────────────────────────────────────────

function runProbe(decl, timeoutMs = 10000) {
  return new Promise((resolve) => {
    if (!decl.probe) return resolve({ skipped: true });
    let settled = false;
    const finish = (r) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    let child;
    try {
      child = spawn(decl.binary, decl.probe.args, { stdio: 'ignore', windowsHide: true });
    } catch {
      return finish({ code: -1 });
    }
    const t = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 忽略 */
      }
      finish({ code: null, timedOut: true });
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(t);
      finish({ code: -1, error: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(t);
      finish({ code });
    });
  });
}

function checkPortFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

function udsRequest({ method, path: p, body }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        socketPath: socketPath(),
        method,
        path: p,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* 非 JSON */
          }
          resolve({ status: res.statusCode, json, text });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.end(payload);
    else req.end();
  });
}

async function cmdDoctor() {
  let failures = 0;
  const rows = [];
  const add = (level, msg) => rows.push({ level, msg });

  let config;
  try {
    const loaded = loadConfig();
    config = loaded.config;
    for (const w of loaded.warnings) add('warn', w);
    add('ok', `配置 ${configPath()} 校验通过`);
  } catch (e) {
    add('fail', `配置加载失败：${e.message}`);
    failures += 1;
  }

  if (fs.existsSync(tokensPath())) {
    const mode = fs.statSync(tokensPath()).mode & 0o777;
    if (mode & 0o077) {
      add('warn', `tokens 文件权限过宽（${mode.toString(8)}），建议 chmod 600`);
    } else {
      add('ok', `tokens 文件权限 0600（${loadTokens().length} 个 token）`);
    }
  } else {
    add('info', '尚无 token（网页接入时签发：cli-bridge token create --origin <url>）');
  }

  if (config) {
    let registry;
    try {
      registry = buildRegistry(config);
    } catch (e) {
      add('fail', `适配器声明有误：${e.message}`);
      failures += 1;
      registry = null;
    }
    if (registry) {
      const probes = await Promise.all(
        [...registry.entries()].map(async ([id, decl]) => {
          const bin = findBinary(decl.binary);
          if (!bin) return { id, decl, ok: false, msg: `二进制 ${decl.binary} 未找到${decl.installHint ? `（${decl.installHint}）` : ''}` };
          const r = decl.probe ? await runProbe(decl) : { skipped: true };
          if (r.skipped) return { id, decl, ok: true, msg: `${bin}（无 probe，跳过探测）` };
          if (decl.probe.expectExit.includes(r.code)) {
            return { id, decl, ok: true, msg: `${bin}${decl.untested ? '（声明未实测）' : ''}，探测退出码 ${r.code}` };
          }
          return { id, decl, ok: false, msg: `${bin} 探测失败（退出码 ${r.code}${r.timedOut ? '，超时' : ''}）——可能未登录或 probe 参数不适用` };
        })
      );
      for (const p of probes) {
        add(p.ok ? 'ok' : 'fail', `工具 ${p.id}：${p.msg}`);
        if (!p.ok) failures += 1;
      }
      const free = await checkPortFree(config.server.port);
      add(free ? 'ok' : 'warn', free ? `端口 127.0.0.1:${config.server.port} 空闲` : `端口 ${config.server.port} 已被占用（可能桥已在运行）`);
    }
  }

  try {
    const r = await Promise.race([
      udsRequest({ method: 'GET', path: '/v1/health' }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 1500)),
    ]);
    add('ok', `桥正在运行（UDS 连通，v${r.json?.version || '?'})`);
  } catch {
    add('info', '桥未运行（启动：cli-bridge start）');
  }

  if (fs.existsSync(auditLogPath())) {
    const size = fs.statSync(auditLogPath()).size;
    add('info', `审计日志 ${(size / 1024).toFixed(1)}KB（${auditLogPath()}）`);
  }

  const icon = { ok: '✅', warn: '⚠️ ', fail: '❌', info: 'ℹ️ ' };
  for (const r of rows) console.log(`${icon[r.level]} ${r.msg}`);
  if (failures > 0) {
    console.log(`\n${failures} 项未通过。`);
    process.exitCode = 1;
  }
}

// ── run（本机快捷调用，走 UDS）─────────────────────────────────────────

async function cmdRun(sub, positional, flags) {
  const toolId = sub;
  if (!toolId || positional.length === 0) {
    console.error('用法：cli-bridge run <tool> <input> [--json] [--timeout-ms N]');
    process.exitCode = 1;
    return;
  }
  const input = positional.join(' ');
  let res;
  try {
    res = await udsRequest({
      method: 'POST',
      path: `/v1/tools/${encodeURIComponent(toolId)}/run`,
      body: {
        input,
        wait: true,
        ...(flags['timeout-ms'] ? { timeoutMs: Number(flags['timeout-ms']) } : {}),
      },
    });
  } catch (e) {
    console.error(`无法连接桥（${e.message}）。请先启动：cli-bridge start`);
    process.exitCode = 1;
    return;
  }
  const body = res.json;
  if (body?.ok) {
    if (flags.json) console.log(JSON.stringify(body, null, 2));
    else process.stdout.write(String(body.data.output ?? '') + '\n');
    return;
  }
  const err = body?.error || { code: `HTTP_${res.status}`, message: res.text.slice(0, 200) };
  if (flags.json) console.log(JSON.stringify(body, null, 2));
  console.error(`失败 [${err.code}]：${err.message}${err.installHint ? `\n提示：${err.installHint}` : ''}`);
  process.exitCode = 1;
}

// ── 入口 ─────────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`cli-bridge v${getVersion()} —— 本机 CLI AI 工具的统一受控桥

用法：cli-bridge <命令>

  start                        启动桥（HTTP 127.0.0.1:39487 + UDS）
                               [--port N] [--verbose]
  tools list                   查看适配器与启用状态
  tools allow <id>             启用工具（交互确认；脚本加 --yes）
  tools deny <id>              禁用工具
  origins list                 查看来源白名单
  origins add <url>            添加 https 站点（交互确认；脚本加 --yes）
  origins remove <url>         移除站点
  token create --origin <url|local> [--label L]
                               签发 per-origin token（明文只显示一次）
  token list / revoke <id>     查看 / 吊销
  config get [key]             查看配置（无 key 输出全部）
  config set <key> <value>     修改配置（schema 校验后原子写入）
  doctor                       体检：配置/工具/端口/桥状态
  run <tool> <input>           本机快捷调用（走 UDS 免 token）[--json] [--timeout-ms N]

协议与网页接入：docs/PROTOCOL.md`);
}

/**
 * 拆分命令行：argv[1] 只有在不是 flag 时才是子命令。
 * （曾因无条件 slice(2) 吞掉无子命令场景的 flag：`start --port N` 从未生效——已修。）
 */
export function splitCommand(argv) {
  const [cmd] = argv;
  const hasSub = argv.length > 1 && !argv[1].startsWith('--');
  const sub = hasSub ? argv[1] : undefined;
  const { flags, positional } = parseArgs(hasSub ? argv.slice(2) : argv.slice(1));
  return { cmd, sub, flags, positional };
}

export async function main(argv = process.argv.slice(2)) {
  const { cmd, sub, flags, positional } = splitCommand(argv);
  switch (cmd) {
    case 'start':
      return cmdStart(flags);
    case 'tools':
      return cmdTools(sub, positional, flags);
    case 'origins':
      return cmdOrigins(sub, positional, flags);
    case 'token':
      return cmdToken(sub, positional, flags);
    case 'config':
      return cmdConfig(sub, positional);
    case 'doctor':
      return cmdDoctor();
    case 'run':
      return cmdRun(sub, positional, flags);
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      return printHelp();
    default:
      console.error(`未知命令：${cmd}\n`);
      printHelp();
      process.exitCode = 1;
  }
}
