import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { useTempHome } from './helpers.js';
import { main, splitCommand } from '../src/cli.js';
import { loadConfig } from '../src/core/config.js';
import { loadTokens } from '../src/core/tokens.js';

test('splitCommand：无子命令时 flag 不被吞（start --port 曾因此失效）', () => {
  assert.deepEqual(splitCommand(['start', '--port', '45657']), {
    cmd: 'start', sub: undefined, flags: { port: '45657' }, positional: [],
  });
  assert.deepEqual(splitCommand(['doctor']), { cmd: 'doctor', sub: undefined, flags: {}, positional: [] });
  assert.deepEqual(splitCommand(['run', 'agy', 'hello', '--json']), {
    cmd: 'run', sub: 'agy', flags: { json: true }, positional: ['hello'],
  });
  assert.deepEqual(splitCommand(['tools', 'allow', 'agy', '--yes']), {
    cmd: 'tools', sub: 'allow', flags: { yes: true }, positional: ['agy'],
  });
});

test('config set / get：schema 校验通过后原子写入', async (t) => {
  useTempHome(t);
  await main(['config', 'set', 'server.port', '1234']);
  const { config } = loadConfig();
  assert.equal(config.server.port, 1234);
  // 非法值被拒绝且不落盘
  process.exitCode = 0;
  await main(['config', 'set', 'log.level', 'nonsense']);
  assert.equal(process.exitCode, 1, '非法枚举值应失败');
  assert.equal(loadConfig().config.log.level, 'info');
  process.exitCode = 0;
});

test('tools allow / deny：交互确认门 + 白名单持久化', async (t) => {
  useTempHome(t);
  // 非 TTY 且无 --yes：拒绝执行
  await main(['tools', 'allow', 'agy']);
  assert.deepEqual(loadConfig().config.tools.allow, []);
  // --yes 放行
  await main(['tools', 'allow', 'agy', '--yes']);
  assert.deepEqual(loadConfig().config.tools.allow, ['agy']);
  // 未声明工具不允许 allow
  process.exitCode = 0;
  await main(['tools', 'allow', 'nope', '--yes']);
  assert.equal(process.exitCode, 1);
  process.exitCode = 0;
  // deny 无需确认（收紧操作）
  await main(['tools', 'deny', 'agy']);
  assert.deepEqual(loadConfig().config.tools.allow, []);
  process.exitCode = 0;
});

test('origins add：仅 https、需确认', async (t) => {
  useTempHome(t);
  await main(['origins', 'add', 'https://site.com', '--yes']);
  assert.deepEqual(loadConfig().config.origins, ['https://site.com']);
  // http 被拒
  process.exitCode = 0;
  await main(['origins', 'add', 'http://insecure.com', '--yes']);
  assert.equal(process.exitCode, 1);
  assert.deepEqual(loadConfig().config.origins, ['https://site.com']);
  // 非 TTY 无 --yes 拒绝
  await main(['origins', 'add', 'https://other.com']);
  assert.deepEqual(loadConfig().config.origins, ['https://site.com']);
  process.exitCode = 0;
});

test('token create / list：落盘记录、明文只在 stdout', async (t) => {
  useTempHome(t);
  await main(['token', 'create', '--origin', 'local', '--label', 'for-curl']);
  const tokens = loadTokens();
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].origin, 'local');
  assert.equal(tokens[0].label, 'for-curl');
  assert.ok(tokens[0].hash.length === 64, '存的是 sha256 哈希');
  // 非法 origin 拒绝
  process.exitCode = 0;
  await main(['token', 'create', '--origin', 'http://x.com']);
  assert.equal(process.exitCode, 1);
  assert.equal(loadTokens().length, 1);
  process.exitCode = 0;
});

test('config 文件只写进沙箱 HOME，绝不碰 CWD', async (t) => {
  const home = useTempHome(t);
  const prevCwd = process.cwd();
  const scratch = fs.mkdtempSync(path.join(path.dirname(home), 'cli-bridge-cwd-'));
  process.chdir(scratch);
  t.after(() => process.chdir(prevCwd));
  await main(['config', 'set', 'server.port', '4321']);
  assert.ok(fs.existsSync(path.join(home, '.cli-bridge', 'config.json')));
  assert.ok(!fs.existsSync(path.join(scratch, '.cli-bridge')), 'CWD 不产生任何配置');
});

// ── stop / restart（子进程端到端：真实端口 + 信号，无法在进程内模拟）──────

const BIN = fileURLToPath(new URL('../bin/cli-bridge.js', import.meta.url));

async function waitUntil(fn, { timeoutMs = 10000, step = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, step));
  }
  throw new Error('waitUntil 超时');
}

async function healthOk(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/health`);
    return r.ok;
  } catch {
    return false;
  }
}

function exited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

test('stop：pid 文件优雅关闭并清理；无实例时提示未在运行', async (t) => {
  const home = useTempHome(t);
  const port = 47100 + (process.pid % 400);
  const env = { ...process.env, HOME: home };
  const pidFile = path.join(home, '.cli-bridge', 'bridge.pid');

  const bridge = spawn(process.execPath, [BIN, 'start', '--port', String(port)], { env, stdio: 'ignore' });
  t.after(() => {
    if (!exited(bridge)) bridge.kill('SIGKILL');
  });

  await waitUntil(() => fs.existsSync(pidFile));
  await waitUntil(() => healthOk(port));
  assert.equal(JSON.parse(fs.readFileSync(pidFile, 'utf8')).port, port);

  const r = spawnSync(process.execPath, [BIN, 'stop'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  await waitUntil(() => exited(bridge));
  assert.ok(!fs.existsSync(pidFile), 'stop 后 pid 文件应清理');
  assert.equal(await healthOk(port), false, '端口应已释放');

  const r2 = spawnSync(process.execPath, [BIN, 'stop'], { env, encoding: 'utf8' });
  assert.equal(r2.status, 0);
  assert.match(r2.stdout, /未在运行/);
});

test('restart：停旧实例，restart 进程原地成为新桥', async (t) => {
  const home = useTempHome(t);
  const port = 47600 + (process.pid % 400);
  const env = { ...process.env, HOME: home };
  const pidFile = path.join(home, '.cli-bridge', 'bridge.pid');

  const a = spawn(process.execPath, [BIN, 'start', '--port', String(port)], { env, stdio: 'ignore' });
  t.after(() => {
    if (!exited(a)) a.kill('SIGKILL');
  });
  await waitUntil(() => fs.existsSync(pidFile));
  const pidA = JSON.parse(fs.readFileSync(pidFile, 'utf8')).pid;
  await waitUntil(() => healthOk(port));

  const b = spawn(process.execPath, [BIN, 'restart', '--port', String(port)], { env, stdio: 'ignore' });
  t.after(() => {
    if (!exited(b)) b.kill('SIGKILL');
  });

  await waitUntil(() => {
    if (!fs.existsSync(pidFile)) return false;
    return JSON.parse(fs.readFileSync(pidFile, 'utf8')).pid === b.pid;
  });
  await waitUntil(() => healthOk(port));
  assert.notEqual(b.pid, pidA, '新桥应是 restart 进程自己');
  assert.ok(exited(a), '旧实例应已退出');

  const r = spawnSync(process.execPath, [BIN, 'stop'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  await waitUntil(() => exited(b));
});
