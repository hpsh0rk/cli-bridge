/**
 * 协议错误码 → HTTP 状态。错误码枚举见 docs/PROTOCOL.md §2，
 * 其中 E_CANCELLED / E_NOT_FOUND / E_INTERNAL 是对 DESIGN §3.1 的补充（协议只增不改）。
 */
export const HTTP_STATUS = {
  E_AUTH: 401,
  E_ORIGIN: 403,
  E_TOOL_NOT_FOUND: 404,
  E_TOOL_DISABLED: 403,
  E_TOOL_UNAVAILABLE: 503,
  E_RATE_LIMIT: 429,
  E_BUSY: 503,
  E_TIMEOUT: 504,
  E_TOOL_FAILED: 502,
  E_BAD_REQUEST: 400,
  E_CANCELLED: 409,
  E_NOT_FOUND: 404,
  E_INTERNAL: 500,
};

const RETRYABLE = new Set(['E_RATE_LIMIT', 'E_BUSY', 'E_TIMEOUT']);

export class BridgeError extends Error {
  constructor(code, message, extra = undefined) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.httpStatus = HTTP_STATUS[code] ?? 500;
    this.extra = extra; // 附加字段：installHint / retryAfterMs / detail / stderrTail / durationMs
  }

  toEnvelope() {
    return {
      ok: false,
      error: {
        code: this.code,
        message: this.message,
        retryable: RETRYABLE.has(this.code),
        ...(this.extra || {}),
      },
    };
  }
}
