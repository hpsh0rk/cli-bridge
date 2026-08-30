import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, writeConfig, defaultConfig } from '../src/core/config.js';
import { buildRegistry, findBinary } from '../src/adapters/registry.js';
import { useTempHome } from './helpers.js';

test('内置注册表：agy（实测）与 codex（声明未实测）均通过 schema 校验', (t) => {
  useTempHome(t);
  const { config } = loadConfig();
  const registry = buildRegistry(config);
  assert.deepEqual([...registry.keys()], ['agy', 'codex']);
  assert.equal(registry.get('agy').run.args.filter((a) => a === '{input}').length, 1);
  assert.equal(registry.get('codex').untested, true);
});

test('config.adapters 可覆盖内置声明（灵活配置）', (t) => {
  useTempHome(t);
  writeConfig({ ...defaultConfig(), adapters: { agy: { limits: { timeoutMs: 12345 } } } });
  const { config } = loadConfig();
  const registry = buildRegistry(config);
  assert.equal(registry.get('agy').limits.timeoutMs, 12345);
  assert.equal(registry.get('agy').run.args[0], '-p', '未覆盖的字段保持不变');
});

test('config.adapters 可新增自定义工具', (t) => {
  useTempHome(t);
  writeConfig({
    ...defaultConfig(),
    adapters: {
      mytool: {
        displayName: 'My Tool',
        binary: 'whatever',
        run: { args: ['--x', '{input}'], output: 'text' },
        capabilities: { text: true, image: false, stream: false },
        limits: { timeoutMs: 60000, concurrency: 2, outputMaxBytes: 1024 },
        options: [],
      },
    },
  });
  const { config } = loadConfig();
  const registry = buildRegistry(config);
  assert.equal(registry.get('mytool').displayName, 'My Tool');
});

test('非法声明在 buildRegistry 时被拒绝', (t) => {
  useTempHome(t);
  const bad = (adapters) => () => buildRegistry({ ...defaultConfig(), adapters });
  assert.throws(bad({ x: { displayName: 'X' } }), /binary/);
  // {input} 只能整段出现一次
  assert.throws(
    bad({
      y: {
        displayName: 'Y',
        binary: 'y',
        run: { args: ['{input}', '{input}'], output: 'text' },
        capabilities: { text: true, image: false, stream: false },
        limits: { timeoutMs: 1, concurrency: 1, outputMaxBytes: 1 },
        options: [],
      },
    }),
    /一个 \{input\} 槽位/
  );
  // 不允许把 {input} 内嵌进参数值（命令模板固化：{input} 必须是独立 argv 元素）
  assert.throws(
    bad({
      z: {
        displayName: 'Z',
        binary: 'z',
        run: { args: ['--tpl={input}'], output: 'text' },
        capabilities: { text: true, image: false, stream: false },
        limits: { timeoutMs: 1, concurrency: 1, outputMaxBytes: 1 },
        options: [],
      },
    }),
    /模板变量/
  );
  // 未知模板变量一律拒绝
  assert.throws(
    bad({
      w: {
        displayName: 'W',
        binary: 'w',
        run: { args: ['--out', '{output}', '{input}'], output: 'text' },
        capabilities: { text: true, image: false, stream: false },
        limits: { timeoutMs: 1, concurrency: 1, outputMaxBytes: 1 },
        options: [],
      },
    }),
    /模板变量/
  );
});

test('tools.overrides 只做收窄性覆盖', (t) => {
  useTempHome(t);
  writeConfig({ ...defaultConfig(), tools: { allow: [], overrides: { agy: { timeoutMs: 1000, options: [] } } } });
  const { config } = loadConfig();
  const registry = buildRegistry(config);
  assert.equal(registry.get('agy').limits.timeoutMs, 1000);
  assert.throws(() => buildRegistry({ ...defaultConfig(), tools: { allow: [], overrides: { ghost: {} } } }), /未声明工具/);
});

test('findBinary：绝对路径 / PATH 探测 / 缺失', (t) => {
  useTempHome(t);
  assert.equal(findBinary(process.execPath), process.execPath);
  assert.equal(findBinary('definitely-missing-binary-xyz'), null);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-bridge-path-'));
  const script = path.join(dir, 'fakebin');
  fs.writeFileSync(script, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(script, 0o755);
  const prevPath = process.env.PATH;
  process.env.PATH = dir + path.delimiter + prevPath;
  try {
    assert.equal(findBinary('fakebin'), script);
  } finally {
    process.env.PATH = prevPath;
  }
});
