import { BridgeError } from '../errors.js';

/** 读取并解析 JSON 请求体（限长）。从 http.js 拆出，供 OpenAI 兼容层复用。 */
export function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        req.pause(); // 停止缓冲超大请求体；错误响应发出后由调用方断开连接
        reject(new BridgeError('E_BAD_REQUEST', `请求体超过上限 ${maxBytes} 字节`));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return reject(new BridgeError('E_BAD_REQUEST', '请求体不能为空'));
      let body;
      try {
        body = JSON.parse(text);
      } catch (e) {
        return reject(new BridgeError('E_BAD_REQUEST', `请求体不是合法 JSON：${e.message}`));
      }
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return reject(new BridgeError('E_BAD_REQUEST', '请求体必须是 JSON 对象'));
      }
      resolve(body);
    });
    req.on('error', () => reject(new BridgeError('E_BAD_REQUEST', '读取请求体失败')));
  });
}
