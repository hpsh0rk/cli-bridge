import http from 'node:http';
import fs from 'node:fs';
import net from 'node:net';
import { bridgeDir, socketPath } from '../core/config.js';

/**
 * UDS 通道（Windows 为命名管道）：复用 HTTP 协议，但 socket 标记 trustedLocal，
 * 请求处理时跳过 Host/CORS/token 检查——本机文件系统权限（目录 0700）即信任边界。
 * 本地程序可直接 `curl --unix-socket ~/.cli-bridge/bridge.sock http://localhost/v1/...`。
 */
export function startUdsChannel(handler) {
  const server = http.createServer(handler);
  server.requestTimeout = 0;
  server.on('connection', (sock) => {
    sock.trustedLocal = true;
  });

  const sockPath = socketPath();
  return new Promise((resolve, reject) => {
    const boot = () => {
      try {
        fs.mkdirSync(bridgeDir(), { recursive: true });
        fs.chmodSync(bridgeDir(), 0o700);
      } catch {
        /* 目录已存在等 */
      }
      server.once('error', reject);
      server.listen({ path: sockPath }, () => {
        if (process.platform !== 'win32') {
          try {
            fs.chmodSync(sockPath, 0o660);
          } catch {
            /* 平台差异忽略 */
          }
        }
        resolve(server);
      });
    };

    if (process.platform === 'win32') return boot();
    if (!fs.existsSync(sockPath)) return boot();
    // 残留 socket：能连通说明已有桥在跑；连不上说明是陈旧文件，清理后重启
    const probe = net.connect(sockPath);
    probe.once('connect', () => {
      probe.destroy();
      reject(new Error(`UDS 已被占用（${sockPath}），桥可能已在运行`));
    });
    probe.once('error', () => {
      try {
        fs.unlinkSync(sockPath);
      } catch {
        /* 忽略 */
      }
      boot();
    });
  });
}
