import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, writeConfig, defaultConfig, configPath, bridgeDir } from '../src/core/config.js';
import { useTempHome, writeTestConfig } from './helpers.js';

test('默认配置：端口 39487、token 必填、白名单全关、审计开', (t) => {
  useTempHome(t);
  const { config, warnings } = loadConfig();
  assert.deepEqual(config, defaultConfig());
  assert.equal(config.server.port, 39487);
  assert.equal(config.auth.requireToken, true);
  assert.deepEqual(config.tools.allow, []);
  assert.deepEqual(config.origins, []);
  assert.deepEqual(warnings, []);
});

test('文件配置与默认值合并，env 只做启动时覆盖', (t) => {
  const home = useTempHome(t);
  writeTestConfig(home, { server: { port: 4321 }, origins: ['https://a.com'] });
  const { config, warnings } = loadConfig({
    env: { CLI_BRIDGE_PORT: '4322', CLI_BRIDGE_ORIGINS: 'https://b.com,https://a.com', CLI_BRIDGE_REQUIRE_TOKEN: 'false' },
  });
  assert.equal(config.server.port, 4322);
  assert.deepEqual(config.origins, ['https://a.com', 'https://b.com']);
  assert.equal(config.auth.requireToken, false);
  // 放宽必须告警
  assert.ok(warnings.some((w) => w.includes('CLI_BRIDGE_ORIGINS')));
  assert.ok(warnings.some((w) => w.includes('CLI_BRIDGE_REQUIRE_TOKEN')));
});

test('安全不变量：CWD 下的 config.json 永不被读取', (t) => {
  useTempHome(t);
  const prevCwd = process.cwd();
  process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-bridge-cwd-')));
  t.after(() => process.chdir(prevCwd));
  // 恶意仓库在 CWD 放配置试图削弱安全设置
  fs.writeFileSync('config.json', JSON.stringify({ server: { port: 5555 }, origins: ['https://evil.com'] }));
  const { config } = loadConfig();
  assert.equal(config.server.port, 39487);
  assert.deepEqual(config.origins, []);
});

test('非法配置被拒绝', (t) => {
  useTempHome(t);
  assert.throws(() => writeConfig({ ...defaultConfig(), server: { port: 0 } }), /server\.port/);
  assert.throws(() => writeConfig({ ...defaultConfig(), origins: ['http://insecure.com'] }), /https/);
  assert.throws(() => writeConfig({ ...defaultConfig(), auth: { requireToken: 'yes' } }), /requireToken/);
  assert.throws(() => loadConfig({ env: { CLI_BRIDGE_PORT: 'abc' } }), /CLI_BRIDGE_PORT/);
});

test('写入是原子且收紧权限的：config 0600、目录 0700', (t) => {
  useTempHome(t);
  writeConfig(defaultConfig());
  assert.equal(fs.statSync(configPath()).mode & 0o777, 0o600);
  assert.equal(fs.statSync(bridgeDir()).mode & 0o777, 0o700);
  assert.equal(JSON.parse(fs.readFileSync(configPath(), 'utf8')).server.port, 39487);
});
