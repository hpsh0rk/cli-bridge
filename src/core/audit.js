import fs from 'node:fs';
import { auditLogPath } from './config.js';

/**
 * 审计日志（DESIGN §6.4）：JSONL 追加到 ~/.cli-bridge/audit.log。
 * 字段：时间 · 通道/origin · token 哈希前 8 位 · 工具 · 状态 · 耗时。
 * 默认不记录 prompt（redactPrompts）；日志文件属于用户本人，随时可回答"哪个网站在用我的工具"。
 */
export class Audit {
  constructor(config) {
    this.enabled = config.log.audit;
    this.redactPrompts = config.log.redactPrompts;
    this.file = auditLogPath();
  }

  log(entry) {
    if (!this.enabled) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
    // 同步追加：量级为"每次运行一行"，换取落盘可靠（进程崩溃也不丢记录）
    try {
      fs.appendFileSync(this.file, line, { mode: 0o600 });
    } catch {
      /* 磁盘异常不阻断主流程 */
    }
  }
}
