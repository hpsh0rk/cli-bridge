import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { BridgeError } from '../errors.js';
import { getPath } from '../util.js';
import { workspaceRoot } from './config.js';

export function makeRunDir(toolId, runId) {
  const dir = path.join(workspaceRoot(), toolId, runId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 杀整个进程组：先 SIGTERM，5 秒后兜底 SIGKILL。 */
export function killProcessTree(child) {
  if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  const signal = (sig) => {
    try {
      process.kill(-pid, sig); // detached 模式下 -pid 命中整个进程组
    } catch {
      try {
        child.kill(sig);
      } catch {
        /* 进程已退出 */
      }
    }
  };
  signal('SIGTERM');
  const t = setTimeout(() => signal('SIGKILL'), 5000);
  if (typeof t.unref === 'function') t.unref();
  child.once('close', () => clearTimeout(t));
}

/** 选项白名单 → argv（引擎已做过类型/白名单校验，这里只做映射）。 */
function optionsToArgs(decl, options) {
  const args = [];
  for (const opt of decl.options) {
    const v = options?.[opt.name];
    if (v === undefined) continue;
    args.push(opt.flag);
    if (opt.type !== 'boolean') args.push(String(v));
  }
  return args;
}

function unavailableError(decl) {
  return new BridgeError('E_TOOL_UNAVAILABLE', `工具 ${decl.binary} 未安装或不可执行`, {
    installHint: decl.installHint || '',
  });
}

/**
 * 附件落盘（vision 输入）：写入 run 工作目录的 attachments/ 子目录——图片收割只扫 cwd 本层，
 * 子目录隔离避免参考图被误收成生成产物。engine.validateRunRequest 已做数量/大小/类型校验，
 * 这里只做落盘与文件名防御（正则排除路径分隔符，杜绝路径穿越）。
 */
function prepareAttachments(cwd, decl, attachments) {
  const cap = decl.attachments;
  if (!cap || !Array.isArray(attachments) || attachments.length === 0) return { paths: [], extraArgs: [] };
  const dir = path.join(cwd, 'attachments');
  fs.mkdirSync(dir, { recursive: true });
  const paths = [];
  for (const att of attachments) {
    const name = String(att?.filename ?? '');
    if (!/^att-\d+\.[A-Za-z0-9]+$/.test(name)) {
      throw new BridgeError('E_BAD_REQUEST', `附件名非法：${name.slice(0, 40)}`);
    }
    const buf = Buffer.from(String(att?.dataBase64 ?? ''), 'base64');
    if (!buf.length) throw new BridgeError('E_BAD_REQUEST', `附件解码后为空：${name}`);
    const target = path.join(dir, name);
    fs.writeFileSync(target, buf);
    paths.push(target);
  }
  return { paths, extraArgs: Array.isArray(cap.extraArgs) ? cap.extraArgs : [] };
}

/** 输入中的 {attachments} 占位符 → 绝对路径清单（相对路径解析不可靠，实测 agent 会解析到 $HOME）。 */
function composeInputWithAttachments(input, paths) {
  if (!paths.length) return input.replaceAll('{attachments}', '');
  const manifest = paths.join('\n');
  if (input.includes('{attachments}')) return input.replaceAll('{attachments}', manifest);
  return `${input}\n\n[随附图片文件（本机文件，可用 view_file 按绝对路径查看）]\n${manifest}`;
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** 按适配器声明从 stdout 提取输出；失败抛 BridgeError。 */
function extractOutput(decl, stdoutBuf, { exitCode, truncated }) {
  const text = stdoutBuf.toString('utf8');
  const preview = text.trim().slice(0, 300);
  const fail = (msg) => {
    throw new BridgeError('E_TOOL_FAILED', truncated ? `${msg}（输出已被截断）` : msg);
  };
  if (exitCode !== 0) {
    fail(`工具退出码 ${exitCode}（非成功）${preview ? `，输出预览：${preview}` : ''}`);
  }

  if (decl.run.output === 'text') {
    return { value: text.trim(), usage: undefined };
  }

  if (decl.run.output === 'json') {
    let obj = tryParseJson(text);
    if (obj === undefined || obj === null) {
      // 容忍工具在 JSON 前后混入非 JSON 日志：截取首尾大括号之间重试（原型验证过的行为）
      obj = tryParseJson(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    }
    if (obj === undefined || obj === null) fail(`工具输出不是合法 JSON${preview ? `：${preview}` : ''}`);
    if (decl.run.jsonStatusPath) {
      const st = getPath(obj, decl.run.jsonStatusPath);
      const okList = decl.run.jsonStatusSuccess;
      if (okList && !okList.includes(st)) {
        const detail = typeof obj?.response === 'string' ? `：${obj.response.slice(0, 200)}` : '';
        fail(`工具返回状态 ${String(st)}${detail}`);
      }
    }
    const value = getPath(obj, decl.run.jsonResponsePath);
    if (value === undefined) fail(`无法从输出提取 ${decl.run.jsonResponsePath}${preview ? `，预览：${preview}` : ''}`);
    const conversationId = decl.run.jsonConversationIdPath ? getPath(obj, decl.run.jsonConversationIdPath) : undefined;
    return { value, usage: decl.run.usagePath ? getPath(obj, decl.run.usagePath) : undefined, conversationId };
  }

  // ndjson：取最后一条匹配 ndjsonPick（点路径 → 期望值）的行
  const pick = decl.run.ndjsonPick || {};
  let picked;
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let obj;
    try {
      obj = JSON.parse(s);
    } catch {
      continue;
    }
    if (Object.entries(pick).every(([k, v]) => getPath(obj, k) === v)) picked = obj;
  }
  if (!picked) fail(`输出中未找到匹配的事件${preview ? `，预览：${preview}` : ''}`);
  const value = getPath(picked, decl.run.ndjsonTextPath);
  if (value === undefined) fail(`无法从事件提取 ${decl.run.ndjsonTextPath}`);
  return { value, usage: decl.run.usagePath ? getPath(picked, decl.run.usagePath) : undefined };
}

/**
 * 执行一次适配器调用。
 * resolve({ output, meta })；失败 reject(BridgeError)：
 *   E_TOOL_UNAVAILABLE（二进制缺失）/ E_TIMEOUT / E_CANCELLED / E_TOOL_FAILED（附 stderrTail）。
 * 每次运行在 ~/.cli-bridge/workspace/<tool>/<runId>/ 下执行，隔离工具落盘行为。
 */
export function execAdapter({ decl, input, options, timeoutMs, runId, attachments, isCancelled = () => false, onSpawn }) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const cwd = makeRunDir(decl.id, runId);
    let finalInput = input;
    let attArgs = [];
    try {
      const prepared = prepareAttachments(cwd, decl, attachments);
      finalInput = composeInputWithAttachments(input, prepared.paths);
      attArgs = prepared.extraArgs;
    } catch (e) {
      return reject(e);
    }
    let args = decl.run.args.map((a) => (a === '{input}' ? finalInput : a));
    if (attArgs.length) args = args.concat(attArgs);
    args = args.concat(optionsToArgs(decl, options));

    let child;
    try {
      child = spawn(decl.binary, args, {
        cwd,
        detached: true, // 独立进程组，超时/取消可整组终止
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      return reject(unavailableError(decl));
    }
    onSpawn?.(child);

    const stdoutCap = decl.limits.outputMaxBytes;
    let stdout = Buffer.alloc(0);
    let truncated = false;
    let stderr = Buffer.alloc(0);
    const STDERR_CAP = 64 * 1024;

    child.stdout.on('data', (chunk) => {
      if (stdout.length >= stdoutCap) {
        truncated = true;
        return;
      }
      const room = stdoutCap - stdout.length;
      stdout = Buffer.concat([stdout, chunk.subarray(0, room)]);
      if (chunk.length > room) truncated = true;
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < STDERR_CAP) stderr = Buffer.concat([stderr, chunk.subarray(0, STDERR_CAP - stderr.length)]);
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeoutMs);

    child.on('error', (e) => {
      clearTimeout(timer);
      if (e.code === 'ENOENT') return reject(unavailableError(decl));
      reject(new BridgeError('E_TOOL_FAILED', `工具进程启动失败：${e.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;
      const stderrTail = stderr.toString('utf8').trim().slice(-500);
      if (isCancelled()) {
        return reject(new BridgeError('E_CANCELLED', '运行已被取消', { durationMs }));
      }
      if (timedOut) {
        return reject(
          new BridgeError('E_TIMEOUT', `工具执行超过 ${timeoutMs}ms，已终止进程组`, { durationMs, stderrTail: stderrTail || undefined })
        );
      }
      try {
        const { value, usage, conversationId } = extractOutput(decl, stdout, { exitCode: code, truncated });
        const meta = {
          durationMs,
          exitCode: code,
          ...(usage !== undefined ? { usage } : {}),
          ...(conversationId !== undefined ? { conversationId } : {}),
          ...(truncated ? { truncated } : {}),
        };
        resolve({ output: value, meta });
      } catch (e) {
        if (e instanceof BridgeError) {
          e.extra = { ...(e.extra || {}), durationMs, exitCode: code, ...(stderrTail ? { stderrTail } : {}) };
          reject(e);
        } else {
          reject(new BridgeError('E_TOOL_FAILED', e?.message || '输出解析失败', { durationMs, exitCode: code }));
        }
      }
    });
  });
}

function matchWhen(obj, when) {
  if (!when) return true;
  return Object.entries(when).every(([k, v]) => getPath(obj, k) === v);
}

/**
 * 从图片工具的 ERROR 事件提取人话原因（实测 agy generate_image 失败时
 * tool_info.error.message 内嵌 Google API 的 JSON body：429 QUOTA_EXHAUSTED 等）。
 */
function describeImageToolError(su) {
  const raw = su && su.tool_info && su.tool_info.error;
  if (!raw) return null;
  const rawMsg = typeof raw.message === 'string' ? raw.message : JSON.stringify(raw);
  const parsed = { status: (rawMsg.match(/\b(\d{3})\s/) || [])[1], apiMsg: '', reason: '', model: '', reset: '' };
  const bodyIdx = rawMsg.indexOf('body:');
  if (bodyIdx !== -1) {
    try {
      const j = JSON.parse(rawMsg.slice(bodyIdx + 5).trim());
      parsed.apiMsg = (j.error && j.error.message) || '';
      const info = ((j.error && j.error.details) || []).find((d) => String(d['@type'] || '').includes('ErrorInfo')) || {};
      parsed.reason = info.reason || '';
      parsed.model = (info.metadata && info.metadata.model) || '';
      parsed.reset = (info.metadata && info.metadata.quotaResetTimeStamp) || '';
    } catch {
      /* 内嵌体不是 JSON 就按原文兜底 */
    }
  }
  let human;
  if (/QUOTA_EXHAUSTED|quota/i.test(rawMsg)) {
    human = `图像生成配额已用尽${parsed.model ? `（模型 ${parsed.model}）` : ''}` +
      (parsed.reset ? `，将于 ${parsed.reset} 重置` : '') +
      '。这是上游配额限制，不是桥的故障；恢复后重试即可。';
  } else if (parsed.status === '401' || parsed.status === '403') {
    human = `图像生成认证/权限被拒（HTTP ${parsed.status}），请检查工具的登录态。`;
  } else {
    human = `图像生成工具报错${parsed.status ? `（HTTP ${parsed.status}）` : ''}：${(parsed.apiMsg || rawMsg).slice(0, 200)}`;
  }
  return { human, raw: rawMsg.slice(0, 500) };
}

/**
 * 流式/实时执行（流式聊天与图片生成共用）：
 * - stdout 逐行解析 NDJSON 事件；命中 decl.stream.deltas 时调 onDelta(text)（真增量流式）；
 * - 命中 decl.stream.final 时暂存最终结果（output/status/usage），进程收尾时结算；
 * - 图片模式（image = {extensions, fileStableMs, toolName}）：轮询工作目录，图片文件出现且
 *   尺寸稳定即终止进程组并收割（实测 agy 出图后可能挂住不退出）；声明的图片工具调用报错
 *   且尚未出图时快速失败（实测 agent 会转入无效的 shell 兜底，空耗数分钟）。
 * 无 decl.stream 的适配器退化为缓冲执行，收尾走 extractOutput。
 */
export function execAdapterLive({ decl, input, options, timeoutMs, runId, onDelta, image = null, attachments, isCancelled = () => false, onSpawn }) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const cwd = makeRunDir(decl.id, runId);
    let finalInput = input;
    let attArgs = [];
    try {
      const prepared = prepareAttachments(cwd, decl, attachments);
      finalInput = composeInputWithAttachments(input, prepared.paths);
      attArgs = prepared.extraArgs;
    } catch (e) {
      return reject(e);
    }
    const useStream = !!decl.stream;
    let args = (useStream ? decl.stream.args : decl.run.args).map((a) => (a === '{input}' ? finalInput : a));
    if (image && Array.isArray(decl.image?.extraArgs)) args = args.concat(decl.image.extraArgs);
    if (attArgs.length) args = args.concat(attArgs);
    args = args.concat(optionsToArgs(decl, options));
    let child;
    try {
      child = spawn(decl.binary, args, {
        cwd,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      return reject(unavailableError(decl));
    }
    onSpawn?.(child);

    const stdoutCap = decl.limits.outputMaxBytes;
    let stdoutBuf = Buffer.alloc(0);
    let truncated = false;
    let stderr = Buffer.alloc(0);
    const STDERR_CAP = 64 * 1024;

    let timedOut = false;
    let settled = false;
    let fileTimer = null;
    let finalHarvest = null; // 图片模式：进程退出后的兜底收割（close 处理器调用）
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (fileTimer) clearInterval(fileTimer);
      fn(arg);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeoutMs);

    // —— NDJSON 事件流解析 ——
    const decoder = new StringDecoder('utf8');
    let lineBuf = '';
    let final = null; // { output, usage, status }
    let fileSeen = false;
    const handleLine = (line) => {
      const s = line.trim();
      if (!s || (!useStream && !image)) return; // 图片模式也需解析事件（快速失败依赖工具错误事件）
      let ev;
      try {
        ev = JSON.parse(s);
      } catch {
        return;
      }
      const st = decl.stream;
      if (st && onDelta && st.deltas && matchWhen(ev, st.deltas.when)) {
        const text = getPath(ev, st.deltas.path);
        if (typeof text === 'string' && text) {
          if (stdoutBuf.length < stdoutCap) onDelta(text);
          else truncated = true;
        }
      }
      if (st && st.final && matchWhen(ev, st.final.when)) {
        final = {
          output: getPath(ev, st.final.outputPath),
          usage: st.final.usagePath ? getPath(ev, st.final.usagePath) : undefined,
          status: st.final.statusPath ? getPath(ev, st.final.statusPath) : undefined,
          conversationId: st.final.conversationIdPath ? getPath(ev, st.final.conversationIdPath) : undefined,
        };
      }
      if (image && image.toolName && !fileSeen) {
        const su = ev && ev.step_update;
        if (su && su.state === 'ERROR' && su.tool_name === image.toolName) {
          killProcessTree(child);
          const described = describeImageToolError(su);
          finish(reject, new BridgeError(
            'E_TOOL_FAILED',
            `图片生成工具 ${image.toolName} 调用失败（已中止，避免无效重试）${described ? '：' + described.human : ''}`,
            { durationMs: Date.now() - startedAt, ...(described ? { detail: described.raw } : {}) }
          ));
        }
      }
    };
    child.stdout.on('data', (chunk) => {
      if (stdoutBuf.length < stdoutCap) {
        const room = stdoutCap - stdoutBuf.length;
        stdoutBuf = Buffer.concat([stdoutBuf, chunk.subarray(0, room)]);
        if (chunk.length > room) truncated = true;
      } else truncated = true;
      lineBuf += decoder.write(chunk);
      let idx;
      while ((idx = lineBuf.indexOf('\n')) !== -1) {
        handleLine(lineBuf.slice(0, idx));
        lineBuf = lineBuf.slice(idx + 1);
      }
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < STDERR_CAP) stderr = Buffer.concat([stderr, chunk.subarray(0, STDERR_CAP - stderr.length)]);
    });

    // —— 图片文件收割 ——
    // cwd（工具约定落盘处）之外，还扫 image.searchDirs（适配器声明的额外语境目录，支持 ~）：
    // 实测新版 agy 的 generate_image 把产物写进 brain 会话目录（<searchDir>/<会话 id>/图片）而非 cwd，
    // 因此 searchDir 根与其直接子目录都在扫描范围。mtime 晚于 run 开始才认，防止收割旧会话/并发会话的历史产物。
    // 外部目录的命中文件复制进 cwd（run 工作目录）再返回，下游（/v1/files、b64 读取）保持只看 cwd。
    if (image) {
      const exts = image.extensions.map((e) => e.toLowerCase());
      // mtime 防线必须严格：文件只可能在 spawn 之后写出，而 startedAt 在 spawn 前捕获，
      // 因此 mtime >= startedAt（无余量）恰好排除上一次运行/历史会话落下的旧图——
      // 留任何余量都会让"背靠背两次生成"误收前一次的图。
      const freshSince = startedAt;
      const searchDirs = (Array.isArray(image.searchDirs) ? image.searchDirs : []).map((d) =>
        d.startsWith('~') ? path.join(os.homedir(), d.slice(1)) : d
      );
      const scanImageFiles = () => {
        const dirs = [cwd];
        for (const root of searchDirs) {
          dirs.push(root);
          try {
            for (const sub of fs.readdirSync(root)) {
              try {
                if (fs.statSync(path.join(root, sub)).isDirectory()) dirs.push(path.join(root, sub));
              } catch {
                /* 竞态删除 */
              }
            }
          } catch {
            /* 目录尚未就绪 */
          }
        }
        const hits = [];
        for (const dir of dirs) {
          let names = [];
          try {
            names = fs.readdirSync(dir);
          } catch {
            continue;
          }
          for (const name of names) {
            if (name.startsWith('.') || !exts.includes(path.extname(name).toLowerCase())) continue;
            try {
              const st = fs.statSync(path.join(dir, name));
              if (st.isFile() && st.size > 0 && st.mtimeMs >= freshSince) hits.push({ dir, name, size: st.size });
            } catch {
              /* 竞态删除 */
            }
          }
        }
        return hits;
      };
      // 外部文件落回 run 工作目录；返回 cwd 内最终图片文件名列表
      const collectIntoCwd = (hits) => {
        for (const h of hits) {
          if (h.dir !== cwd) {
            try {
              fs.copyFileSync(path.join(h.dir, h.name), path.join(cwd, h.name));
            } catch {
              /* 复制失败当作没看见 */
            }
          }
        }
        try {
          return fs
            .readdirSync(cwd)
            .filter((n) => !n.startsWith('.') && exts.includes(path.extname(n).toLowerCase()))
            .filter((n) => fs.statSync(path.join(cwd, n)).size > 0);
        } catch {
          return [];
        }
      };

      let stableKey = '';
      let stableSince = 0;
      fileTimer = setInterval(() => {
        if (settled) return;
        const hits = scanImageFiles();
        if (!hits.length) {
          stableKey = '';
          return;
        }
        fileSeen = true;
        const key = hits.map((h) => `${h.dir}/${h.name}:${h.size}`).sort().join('|');
        if (key === stableKey && Date.now() - stableSince >= (image.fileStableMs ?? 1500)) {
          setTimeout(() => {
            if (settled) return;
            const files = collectIntoCwd(scanImageFiles());
            if (!files.length) return; // 文件可能被改名，继续等
            finish(resolve, { output: files, meta: { durationMs: Date.now() - startedAt } });
            killProcessTree(child);
          }, 400);
        } else if (key !== stableKey) {
          stableKey = key;
          stableSince = Date.now();
        }
      }, 400);
      if (typeof fileTimer.unref === 'function') fileTimer.unref();

      finalHarvest = () => {
        const files = collectIntoCwd(scanImageFiles());
        if (files.length) finish(resolve, { output: files, meta: { durationMs: Date.now() - startedAt } });
        return files.length > 0;
      };
    }

    child.on('error', (e) => {
      if (e.code === 'ENOENT') return finish(reject, unavailableError(decl));
      finish(reject, new BridgeError('E_TOOL_FAILED', `工具进程启动失败：${e.message}`));
    });

    child.on('close', (code) => {
      if (settled) return;
      lineBuf += decoder.end();
      if (lineBuf.trim()) handleLine(lineBuf);
      const durationMs = Date.now() - startedAt;
      const stderrTail = stderr.toString('utf8').trim().slice(-500);
      const preview = stdoutBuf.toString('utf8').trim().slice(0, 300);

      if (isCancelled()) return finish(reject, new BridgeError('E_CANCELLED', '运行已被取消', { durationMs }));
      if (timedOut) {
        return finish(reject, new BridgeError('E_TIMEOUT', `工具执行超过 ${timeoutMs}ms，已终止进程组`, { durationMs, stderrTail: stderrTail || undefined }));
      }

      if (image) {
        // 进程已自行结束：最后一轮收割（轮询间隔可能刚好没赶上文件稳定），收不到才报失败
        if (finalHarvest && finalHarvest()) return;
        const agentSays = final && typeof final.output === 'string' && final.output.trim() ? `。工具回复：${final.output.trim().slice(0, 200)}` : '';
        return finish(
          reject,
          new BridgeError('E_TOOL_FAILED', `工具已结束但未产出图片文件${agentSays}${preview && !agentSays ? `，输出预览：${preview}` : ''}`, {
            durationMs,
            exitCode: code,
            ...(stderrTail ? { stderrTail } : {}),
          })
        );
      }

      if (!useStream) {
        try {
          const { value, usage } = extractOutput(decl, stdoutBuf, { exitCode: code, truncated });
          return finish(resolve, {
            output: value,
            meta: { durationMs, exitCode: code, ...(usage !== undefined ? { usage } : {}), ...(truncated ? { truncated } : {}) },
          });
        } catch (e) {
          if (e instanceof BridgeError) {
            e.extra = { ...(e.extra || {}), durationMs, exitCode: code, ...(stderrTail ? { stderrTail } : {}) };
            return finish(reject, e);
          }
          return finish(reject, new BridgeError('E_TOOL_FAILED', e?.message || '输出解析失败', { durationMs, exitCode: code }));
        }
      }

      if (!final) {
        return finish(reject, new BridgeError('E_TOOL_FAILED', '工具输出缺少最终结果事件', { durationMs, exitCode: code, ...(stderrTail ? { stderrTail } : {}) }));
      }
      const okList = decl.stream.final.successValues;
      if (decl.stream.final.statusPath && okList && !okList.includes(final.status)) {
        const detail = typeof final.output === 'string' ? `：${final.output.slice(0, 200)}` : '';
        return finish(reject, new BridgeError('E_TOOL_FAILED', `工具返回状态 ${String(final.status)}${detail}`, { durationMs, exitCode: code }));
      }
      if (final.output === undefined) {
        return finish(reject, new BridgeError('E_TOOL_FAILED', `无法从最终事件提取 ${decl.stream.final.outputPath}`, { durationMs, exitCode: code }));
      }
      finish(resolve, {
        output: final.output,
        meta: {
          durationMs,
          exitCode: code,
          ...(final.usage !== undefined ? { usage: final.usage } : {}),
          ...(final.conversationId !== undefined ? { conversationId: final.conversationId } : {}),
        },
      });
    });
  });
}
