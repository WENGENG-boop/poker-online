// HTTP + WebSocket 服务：REST 接口、实时对局、后台管理、静态前端

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { IncomingMessage, Server, ServerResponse, createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { containsBlocked } from '../src/net/moderation';
import { normalizeCode } from '../src/net/inviteCode';
import type { ServerMessage } from '../src/net/protocol';
import { randomId } from '../src/net/roomServer';
import { AdminAuth, AuthError, PlayerTokens, RateLimiter } from './auth';
import { Store } from './db';
import { log } from './log';
import { RoomManager } from './rooms';
import { cleanName, parseClientMessage, sanitizeConfig } from './validate';

export interface AppOptions {
  port: number;
  host?: string;
  dbFile: string;
  /** 前端构建产物目录（dist），存在时一并托管 */
  staticDir?: string;
  adminPassword?: string;
  sessionSecret?: string;
  corsOrigin?: string;
  trustProxy?: boolean;
  maxRooms?: number;
  quiet?: boolean;
}

export interface App {
  server: Server;
  rooms: RoomManager;
  port: number;
  adminPassword: string;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const MAX_BODY = 16 * 1024;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

export async function createApp(opts: AppOptions): Promise<App> {
  const store = new Store(opts.dbFile);

  // 密钥与后台密码：优先使用环境变量，否则首次启动时生成并保存到数据库
  const secret = opts.sessionSecret || store.getMeta('session_secret') || randomBytes(32).toString('hex');
  if (!opts.sessionSecret) store.setMeta('session_secret', secret);
  let adminPassword = opts.adminPassword || store.getMeta('admin_password') || '';
  if (!adminPassword) {
    adminPassword = randomBytes(9).toString('base64url');
    store.setMeta('admin_password', adminPassword);
    if (!opts.quiet) log(`已生成后台密码：${adminPassword}（仅显示这一次，可通过环境变量 ADMIN_PASSWORD 覆盖）`);
  }

  const tokens = new PlayerTokens(secret);
  const admin = new AdminAuth(adminPassword);
  const rooms = new RoomManager(store, opts.maxRooms ?? 500);
  const createLimiter = new RateLimiter(10, 60 * 1000);
  const joinLimiter = new RateLimiter(30, 60 * 1000);
  const sweep = setInterval(() => {
    createLimiter.sweep();
    joinLimiter.sweep();
  }, 60 * 1000);

  const staticDir = opts.staticDir && existsSync(join(opts.staticDir, 'index.html')) ? resolve(opts.staticDir) : null;
  if (!opts.quiet) log(staticDir ? `托管前端：${staticDir}` : '未找到前端构建产物，仅提供 API');

  const ipOf = (req: IncomingMessage) => {
    const fwd = opts.trustProxy ? (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() : undefined;
    return fwd || req.socket.remoteAddress || 'unknown';
  };

  // ---------------------------------------------------------------- HTTP

  const send = (res: ServerResponse, status: number, body?: unknown) => {
    if (body === undefined) {
      res.writeHead(status).end();
      return;
    }
    const data = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(data);
  };

  const readJson = (req: IncomingMessage) =>
    new Promise<Record<string, unknown>>((ok, fail) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) {
          fail(new HttpError(413, '请求体过大'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return ok({});
        try {
          const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          ok(v && typeof v === 'object' ? v : {});
        } catch {
          fail(new HttpError(400, '请求格式错误'));
        }
      });
      req.on('error', fail);
    });

  const requireAdmin = (req: IncomingMessage) => {
    if (!admin.check(req.headers.authorization)) throw new HttpError(401, '未登录或登录已过期');
  };

  async function api(req: IncomingMessage, res: ServerResponse, path: string) {
    const method = req.method ?? 'GET';
    const ip = ipOf(req);
    let m: RegExpMatchArray | null;

    if (method === 'GET' && path === '/health') return send(res, 200, { ok: true, rooms: rooms.size });

    if (method === 'POST' && path === '/rooms') {
      if (!createLimiter.allow(ip)) throw new HttpError(429, '创建房间太频繁，请稍后再试');
      const body = await readJson(req);
      const name = cleanName(body.hostName);
      if (!name) throw new HttpError(400, '请输入昵称');
      if (containsBlocked(name)) throw new HttpError(400, '昵称包含不文明内容，请修改');
      const { code, hostId } = rooms.create(name, sanitizeConfig(body.config));
      return send(res, 200, { code, playerId: hostId, token: tokens.sign(code, hostId) });
    }

    if (method === 'POST' && (m = path.match(/^\/rooms\/([A-Za-z0-9]{6})\/join$/))) {
      if (!joinLimiter.allow(ip)) throw new HttpError(429, '请求太频繁，请稍后再试');
      const code = normalizeCode(m[1]);
      const room = rooms.get(code);
      if (!room || room.closed) throw new HttpError(404, '房间不存在，请检查邀请码');
      const body = await readJson(req);
      const name = cleanName(body.name);
      if (!name) throw new HttpError(400, '请输入昵称');
      if (containsBlocked(name)) throw new HttpError(400, '昵称包含不文明内容，请修改');
      if (room.room.status !== 'waiting') throw new HttpError(409, '游戏进行中，暂时无法加入');
      const playerId = randomId('p');
      return send(res, 200, { playerId, token: tokens.sign(code, playerId) });
    }

    // ---- 后台
    if (method === 'POST' && path === '/admin/login') {
      const body = await readJson(req);
      try {
        return send(res, 200, { token: admin.login(ip, body.password) });
      } catch (e) {
        if (e instanceof AuthError) {
          log('后台登录失败', ip);
          throw new HttpError(e.status, e.message);
        }
        throw e;
      }
    }
    if (method === 'POST' && path === '/admin/logout') {
      admin.logout(req.headers.authorization);
      return send(res, 204);
    }
    if (path.startsWith('/admin/')) {
      requireAdmin(req);
      if (method === 'GET' && path === '/admin/rooms') return send(res, 200, rooms.summaries());
      if (method === 'DELETE' && (m = path.match(/^\/admin\/rooms\/([A-Z0-9]{6})$/))) {
        rooms.close(m[1]);
        return send(res, 204);
      }
      if (method === 'GET' && path === '/admin/history') return send(res, 200, store.listHistory(500));
      if (method === 'DELETE' && path === '/admin/history') {
        store.clearHistory();
        log('后台清空历史记录', ip);
        return send(res, 204);
      }
      if (method === 'DELETE' && (m = path.match(/^\/admin\/history\/(.+)$/))) {
        store.deleteHistory(decodeURIComponent(m[1]));
        return send(res, 204);
      }
    }

    throw new HttpError(404, '接口不存在');
  }

  function serveStatic(req: IncomingMessage, res: ServerResponse, urlPath: string) {
    if (!staticDir || (req.method !== 'GET' && req.method !== 'HEAD')) return send(res, 404, { error: 'Not found' });
    let file = resolve(staticDir, '.' + normalize(decodeURIComponent(urlPath)));
    if (!file.startsWith(staticDir + sep) && file !== staticDir) return send(res, 403, { error: 'Forbidden' });
    let isIndex = false;
    if (!existsSync(file) || statSync(file).isDirectory()) {
      // 请求的是具体文件（带扩展名）但不存在：返回 404，避免把 HTML 当成 JS 缓存
      if (extname(urlPath)) return send(res, 404, { error: 'Not found' });
      // 单页应用：/admin 等前端路由都返回 index.html
      file = join(staticDir, 'index.html');
      isIndex = true;
    }
    const ext = extname(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': isIndex || ext === '.html' ? 'no-cache' : urlPath.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
    });
    if (req.method === 'HEAD') return res.end();
    res.end(readFileSync(file));
  }

  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    if (opts.corsOrigin) {
      res.setHeader('Access-Control-Allow-Origin', opts.corsOrigin);
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') return send(res, 204);

    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) return await api(req, res, url.pathname.slice(4));
      return serveStatic(req, res, url.pathname);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      log('请求处理异常', req.method, url.pathname, e);
      return send(res, 500, { error: '服务器内部错误' });
    }
  });

  // ---------------------------------------------------------------- WebSocket

  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const sockets = new Map<string, WebSocket>();
  const alive = new WeakSet<WebSocket>();

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const m = url.pathname.match(/^\/ws\/rooms\/([A-Z0-9]{6})$/);
    const playerId = url.searchParams.get('playerId') ?? '';
    const token = url.searchParams.get('token') ?? '';
    const room = m ? rooms.get(m[1]) : undefined;
    if (!m || !room || room.closed || !/^[\w-]{1,40}$/.test(playerId) || !tokens.verify(m[1], playerId, token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onSocket(ws, m[1], playerId));
  });

  function onSocket(ws: WebSocket, code: string, playerId: string) {
    const room = rooms.get(code);
    if (!room) return ws.close(4404, 'room closed');
    const key = `${code}:${playerId}`;
    // 同一玩家在别处登录：踢掉旧连接
    const prev = sockets.get(key);
    if (prev && prev !== ws) {
      prev.send(JSON.stringify({ type: 'kicked', reason: '你已在其他页面进入该房间' } satisfies ServerMessage));
      prev.close(4000, 'replaced');
    }
    sockets.set(key, ws);
    alive.add(ws);

    const unsubscribe = room.connect(playerId, (msg) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify(msg));
      if (msg.type === 'kicked' || msg.type === 'closed') ws.close(1000, msg.type);
    });

    // 每个连接的消息限流：每秒 20 条，超过 5 秒内 150 条直接断开
    let windowStart = Date.now();
    let count = 0;
    let burst = 0;
    ws.on('message', (data, isBinary) => {
      const now = Date.now();
      if (now - windowStart > 1000) {
        windowStart = now;
        burst = count > 20 ? burst + count : 0;
        count = 0;
      }
      if (++count > 20) {
        if (burst > 150) ws.close(4429, 'too many messages');
        return;
      }
      if (isBinary) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return;
      }
      const msg = parseClientMessage(parsed);
      if (!msg) return;
      const current = rooms.get(code);
      if (!current) return ws.close(4404, 'room closed');
      current.handle(playerId, msg);
    });
    ws.on('pong', () => alive.add(ws));
    ws.on('close', () => {
      unsubscribe();
      if (sockets.get(key) === ws) sockets.delete(key);
    });
    ws.on('error', () => ws.terminate());
  }

  // 清理已断开但未正常关闭的连接
  const ping = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      ws.ping();
    }
  }, 30 * 1000);

  await new Promise<void>((ok) => server.listen(opts.port, opts.host ?? '0.0.0.0', ok));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : opts.port;
  if (!opts.quiet) log(`服务已启动：http://localhost:${port}`);

  return {
    server,
    rooms,
    port,
    adminPassword,
    async close() {
      clearInterval(ping);
      clearInterval(sweep);
      rooms.shutdown();
      for (const ws of wss.clients) ws.close(1012, 'server restart');
      wss.close();
      await new Promise<void>((ok) => server.close(() => ok()));
      server.closeAllConnections?.();
      store.close();
    },
  };
}
