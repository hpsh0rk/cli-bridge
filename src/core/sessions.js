import { createHash } from 'node:crypto';

/**
 * OpenAI 兼容层的多轮会话映射（仅 /v1/chat/completions 使用）：
 * 「已发过的对话前缀」→ 工具侧会话 id。客户端下一轮重发完整历史时，
 * 前缀命中即可改为会话续聊（agy --conversation），只把新增消息发给 CLI——
 * 上游 prompt cache（KV cache）因此能复用，token 花费显著下降（实测 agy
 * 第二轮 input_tokens 33981 中 24480 来自缓存）。
 *
 * 工具侧会话丢失（如被清理）时 CLI 侧只是开新会话、上下文缺失，不报错——
 * 见适配器实测注记。映射条目过期同理：miss 后回退整段转写，行为退化为 v1 基线。
 */
export function sessionKey(toolId, transcript) {
  return createHash('sha256').update(toolId).update('\n').update(transcript).digest('hex');
}

export function createSessionStore({ maxEntries = 200, ttlMs = 2 * 60 * 60 * 1000 } = {}) {
  const map = new Map(); // key → { conversationId, ts }；Map 迭代序即最近使用序，用于 LRU
  return {
    find(key) {
      const e = map.get(key);
      if (!e) return null;
      if (Date.now() - e.ts > ttlMs) {
        map.delete(key);
        return null;
      }
      map.delete(key);
      map.set(key, e); // 命中刷新 LRU 位置
      return e.conversationId;
    },
    save(key, conversationId) {
      if (!conversationId) return;
      map.delete(key);
      map.set(key, { conversationId, ts: Date.now() });
      while (map.size > maxEntries) map.delete(map.keys().next().value);
    },
    clear() {
      map.clear();
    },
    get size() {
      return map.size;
    },
  };
}
