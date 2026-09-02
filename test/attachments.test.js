import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startBridge, post } from './helpers.js';
import { extractAttachments } from '../src/server/openai.js';
import { BridgeError } from '../src/errors.js';

// —— v0.5.0 多模态附件 / model 斜杠约定 / response_format ——

const PNG_BASE64 = Buffer.from('fake-png-bytes-0').toString('base64');
const JPEG_BASE64 = Buffer.from('fake-jpeg-bytes-1').toString('base64');

/** fake 视觉工具：把收到的 input/argv/附件可见性回显进 response，供断言桥的接线是否正确。 */
const VISION_CODE = `
const fs = require('fs');
const input = process.argv[1] || '';
const lines = input.split('\\n');
const manifestIdx = lines.indexOf('[随附图片文件（本机文件，先用 view_file 查看全部图片再回答）]');
const paths = manifestIdx >= 0 ? lines.slice(manifestIdx + 1).filter((l) => l.startsWith('/')) : [];
const out = {
  manifestIdx,
  paths,
  filesExist: paths.map((p) => { try { return fs.statSync(p).size > 0; } catch { return false; } }),
  inAttachmentsDir: paths.every((p) => p.indexOf('/attachments/') !== -1),
  argv: process.argv.slice(2),
};
console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: JSON.stringify(out), usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } }));
process.exit(0);
`;

function visionConfig() {
  return {
    auth: { requireToken: false },
    tools: { allow: ['vis', 'novis'] },
    adapters: {
      vis: {
        displayName: 'Vision Tool',
        binary: process.execPath,
        run: { args: ['-e', VISION_CODE, '{input}'], output: 'json', jsonResponsePath: 'response', jsonStatusPath: 'status', jsonStatusSuccess: ['SUCCESS'] },
        stream: {
          args: ['-e', VISION_CODE, '{input}'],
          final: { when: { event: 'result' }, outputPath: 'result.response', statusPath: 'result.status', successValues: ['SUCCESS'] },
        },
        attachments: { extensions: ['.png', '.jpg', '.jpeg', '.webp', '.gif'], maxCount: 4, maxBytes: 8 * 1024 * 1024, extraArgs: ['--dangerously-skip-permissions'] },
        capabilities: { text: true, image: false, stream: true, attachments: true },
        limits: { timeoutMs: 30000, concurrency: 1, outputMaxBytes: 8388608 },
        options: [
          { name: 'model', flag: '--model', type: 'string' },
          { name: 'jsonSchema', flag: '--json-schema', type: 'string' },
        ],
      },
      novis: {
        displayName: 'No Attachment Tool',
        binary: process.execPath,
        run: { args: ['-e', VISION_CODE, '{input}'], output: 'json', jsonResponsePath: 'response', jsonStatusPath: 'status', jsonStatusSuccess: ['SUCCESS'] },
        stream: {
          args: ['-e', VISION_CODE, '{input}'],
          final: { when: { event: 'result' }, outputPath: 'result.response', statusPath: 'result.status', successValues: ['SUCCESS'] },
        },
        capabilities: { text: true, image: false, stream: true },
        limits: { timeoutMs: 30000, concurrency: 1, outputMaxBytes: 8388608 },
        options: [],
      },
    },
  };
}

function visionBridge(t) {
  return startBridge(t, { configPatch: visionConfig() });
}

function userContent(text, images = []) {
  const parts = [{ type: 'text', text }];
  for (const b64 of images) parts.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } });
  return { role: 'user', content: parts.length === 1 ? text : parts };
}

test('extractAttachments：data URL → 附件列表，mime 决定扩展名，多图按序编号', () => {
  const atts = extractAttachments([
    { role: 'user', content: [
      { type: 'text', text: '看图' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_BASE64}` } },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${JPEG_BASE64}` } },
    ] },
  ]);
  assert.deepEqual(atts.map((a) => a.filename), ['att-0.png', 'att-1.jpg']);
  assert.equal(atts[0].dataBase64, PNG_BASE64);
  assert.equal(atts[1].dataBase64, JPEG_BASE64);
});

test('extractAttachments：外链 / 不支持的 mime / 非法 data URL 均抛 E_BAD_REQUEST', () => {
  assert.throws(() => extractAttachments([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x/y.png' } }] }]), (e) => e instanceof BridgeError && e.code === 'E_BAD_REQUEST');
  assert.throws(() => extractAttachments([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/tiff;base64,AAAA' } }] }]), (e) => e instanceof BridgeError && e.code === 'E_BAD_REQUEST');
  assert.throws(() => extractAttachments([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:not-base64' } }] }]), (e) => e instanceof BridgeError && e.code === 'E_BAD_REQUEST');
});

test('chat 多模态单轮：附件落盘 attachments/ 子目录、清单注入绝对路径、自动挂 skip-permissions', async (t) => {
  const b = await visionBridge(t);
  const r = await post(b.port, '/v1/chat/completions', {
    model: 'vis',
    messages: [userContent('分析这张图', [PNG_BASE64])],
  });
  assert.equal(r.status, 200, r.text);
  const out = JSON.parse(r.json.choices[0].message.content);
  assert.ok(out.manifestIdx > 0, '输入末尾应有附件清单段');
  assert.equal(out.paths.length, 1);
  assert.deepEqual(out.filesExist, [true], '附件文件应已落盘');
  assert.ok(out.inAttachmentsDir, '附件应位于 run 目录 attachments/ 子目录');
  assert.ok(out.argv.includes('--dangerously-skip-permissions'), '带附件应自动追加 extraArgs');
});

test('chat 多模态：model 斜杠约定透传 --model，response_format 透传 --json-schema', async (t) => {
  const b = await visionBridge(t);
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };
  const r = await post(b.port, '/v1/chat/completions', {
    model: 'vis/claude-sonnet-4-6',
    messages: [userContent('看图', [PNG_BASE64])],
    response_format: { type: 'json_schema', json_schema: { name: 'draft', schema } },
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.model, 'vis/claude-sonnet-4-6', '响应回显请求的 model 原文');
  const out = JSON.parse(r.json.choices[0].message.content);
  const mi = out.argv.indexOf('--model');
  assert.ok(mi >= 0 && out.argv[mi + 1] === 'claude-sonnet-4-6', `--model 应透传，argv=${out.argv.join(' ')}`);
  const ji = out.argv.indexOf('--json-schema');
  assert.ok(ji >= 0 && JSON.parse(out.argv[ji + 1]).type === 'object', '--json-schema 应透传 schema');
});

test('chat 多模态：多轮（含 assistant 历史）带图 400', async (t) => {
  const b = await visionBridge(t);
  const r = await post(b.port, '/v1/chat/completions', {
    model: 'vis',
    messages: [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好！' },
      userContent('看图', [PNG_BASE64]),
    ],
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, 'E_BAD_REQUEST');
});

test('chat 多模态：未声明 attachments 能力的工具 400', async (t) => {
  const b = await visionBridge(t);
  const r = await post(b.port, '/v1/chat/completions', {
    model: 'novis',
    messages: [userContent('看图', [PNG_BASE64])],
  });
  assert.equal(r.status, 400);
  assert.match(r.json.error.message, /不支持附件/);
});

test('chat 超全局 1MB 但低于 20MB 的请求体被接受（chat 端点托底上限）', async (t) => {
  const b = await visionBridge(t);
  const big = Buffer.alloc(1.5 * 1024 * 1024, 7).toString('base64'); // ~2MB data URL
  const r = await post(b.port, '/v1/chat/completions', {
    model: 'vis',
    messages: [userContent('大图', [big])],
  });
  assert.equal(r.status, 200, r.text);
  const out = JSON.parse(r.json.choices[0].message.content);
  assert.deepEqual(out.filesExist, [true]);
});

test('runner 附件防御：非法文件名（路径穿越）在落盘时被 E_BAD_REQUEST 拦截', async (t) => {
  const b = await visionBridge(t);
  // HTTP 层的文件名由 extractAttachments 生成（恒合法）；恶意名需直调引擎才能到达 runner
  await assert.rejects(
    b.engine.run({ toolId: 'vis', input: 'x', mode: 'stream', attachments: [{ filename: '../evil.png', dataBase64: PNG_BASE64 }] }),
    (e) => e instanceof BridgeError && e.code === 'E_BAD_REQUEST'
  );
  await assert.rejects(
    b.engine.run({ toolId: 'vis', input: 'x', mode: 'stream', attachments: [{ filename: 'att-0.png', dataBase64: '!!!' }] }),
    (e) => e instanceof BridgeError && e.code === 'E_BAD_REQUEST'
  );
});

test('chat 多模态无附件路径回归：纯文本单轮不含清单段', async (t) => {
  const b = await visionBridge(t);
  const r = await post(b.port, '/v1/chat/completions', { model: 'vis', messages: [{ role: 'user', content: '纯文本' }] });
  assert.equal(r.status, 200, r.text);
  const out = JSON.parse(r.json.choices[0].message.content);
  assert.equal(out.manifestIdx, -1);
  assert.deepEqual(out.paths, []);
  assert.equal(out.argv.includes('--dangerously-skip-permissions'), false, '无附件不挂 extraArgs');
});

// —— images/generations 参考图（i2i） ——

const IMAGE_OUT_CODE = `
const fs = require('fs');
setTimeout(() => {
  fs.writeFileSync('out.png', Buffer.from('generated-image-bytes'));
  const input = process.argv[1] || '';
  fs.writeFileSync('last-input.txt', input);
  setInterval(() => {}, 1000); // 模拟 agy 出图后挂住：验证"文件稳定即收割"
}, 500);
`;

test('images/generations 带 image 参考图：附件落盘 + prompt 注入清单 + 收割产物（与参考图隔离）', async (t) => {
  const cfg = visionConfig();
  cfg.adapters.img2i = {
    displayName: 'Image2Image Tool',
    binary: process.execPath,
    run: { args: ['-e', IMAGE_OUT_CODE, '{input}'], output: 'json', jsonResponsePath: 'response' },
    stream: { args: ['-e', IMAGE_OUT_CODE, '{input}'] },
    image: { extraArgs: ['--dangerously-skip-permissions'], extensions: ['.png'], fileStableMs: 400, toolName: 'generate_image', searchDirs: ['./nonexistent'] },
    attachments: { extensions: ['.png', '.jpg'], maxCount: 2, maxBytes: 8388608, extraArgs: ['--dangerously-skip-permissions'] },
    capabilities: { text: true, image: true, stream: true, attachments: true },
    limits: { timeoutMs: 30000, concurrency: 1, outputMaxBytes: 8388608 },
    options: [],
  };
  cfg.tools.allow.push('img2i');
  const b = await startBridge(t, { configPatch: cfg });
  const r = await post(b.port, '/v1/images/generations', {
    model: 'img2i',
    prompt: '按参考图风格画新图',
    image: `data:image/jpeg;base64,${JPEG_BASE64}`,
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.data.length, 1, '只收割生成产物一张');
  assert.equal(r.json.data[0].b64_json, Buffer.from('generated-image-bytes').toString('base64'));
  // 产物与参考图不混淆：参考图在 attachments/ 子目录，收割只看 cwd 本层
  const runsDir = fs.readdirSync(path.join(b.home, '.cli-bridge', 'workspace', 'img2i'));
  const runDir = path.join(b.home, '.cli-bridge', 'workspace', 'img2i', runsDir[0]);
  const lastInput = fs.readFileSync(path.join(runDir, 'last-input.txt'), 'utf8');
  assert.ok(lastInput.includes('[参考图片（本机文件，先用 view_file 查看，新图严格延续其视觉风格）]'), 'prompt 应注入参考图指令');
  assert.ok(/attachments\/att-0\.jpg$/.test(lastInput.trim().split('\n').pop()), '清单应为 attachments/ 下绝对路径');
  assert.ok(fs.existsSync(path.join(runDir, 'attachments', 'att-0.jpg')), '参考图应落盘');
  assert.deepEqual(fs.readdirSync(runDir).filter((n) => n.endsWith('.png')), ['out.png'], 'cwd 本层只有生成产物');
});

test('images/generations：外链 image 400；image + n=1 语义保持', async (t) => {
  const cfg = visionConfig();
  cfg.adapters.img2i = {
    displayName: 'Image2Image Tool',
    binary: process.execPath,
    run: { args: ['-e', IMAGE_OUT_CODE, '{input}'], output: 'json', jsonResponsePath: 'response' },
    stream: { args: ['-e', IMAGE_OUT_CODE, '{input}'] },
    image: { extraArgs: [], extensions: ['.png'], fileStableMs: 400, toolName: 'generate_image', searchDirs: ['./nonexistent'] },
    attachments: { extensions: ['.png', '.jpg'], maxCount: 2, maxBytes: 8388608, extraArgs: [] },
    capabilities: { text: true, image: true, stream: true, attachments: true },
    limits: { timeoutMs: 30000, concurrency: 1, outputMaxBytes: 8388608 },
    options: [],
  };
  cfg.tools.allow.push('img2i');
  const b = await startBridge(t, { configPatch: cfg });
  const bad = await post(b.port, '/v1/images/generations', {
    model: 'img2i',
    prompt: 'x',
    image: 'https://example.com/ref.png',
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'E_BAD_REQUEST');
});
