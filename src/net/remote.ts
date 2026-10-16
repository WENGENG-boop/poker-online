// 真实后端连接（server/ 目录）。
//
// REST（前缀 VITE_API_URL，同域部署时为 /api）：
//   POST /rooms                 { hostName, config } -> { code, playerId, token }
//   POST /rooms/:code/join      { name }             -> { playerId, token }
//   后台接口见 adminApi.ts
//
// WebSocket：{VITE_WS_URL 或 当前域名/ws}/rooms/:code?playerId=..&token=..
//   客户端发送 ClientMessage（JSON），服务器推送 ServerMessage（JSON），格式见 protocol.ts。
//   每次连上（包括断线重连）都会先发送 join，服务器据此恢复玩家在线状态。

import type { LobbyApi } from './api';
import type { RoomConnection } from './connection';
import type { ClientMessage, RoomConfig, ServerMessage } from './protocol';
import { Session, sessionStore } from './storage';

/** 未配置 VITE_WS_URL 时，按当前页面地址推导（https 页面使用 wss） */
export function defaultWsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

export class WebSocketConnection implements RoomConnection {
  private ws: WebSocket | null = null;
  private subs = new Set<(msg: ServerMessage) => void>();
  private queue: ClientMessage[] = [];
  private retry = 0;
  private closedByUser = false;
  private beat: ReturnType<typeof setInterval> | null = null;

  constructor(
    private wsUrl: string,
    readonly code: string,
    readonly playerId: string,
    private token: string,
    readonly role: 'host' | 'guest',
    private name: string,
  ) {
    this.open();
  }

  private open() {
    const url = `${this.wsUrl}/rooms/${this.code}?playerId=${encodeURIComponent(this.playerId)}&token=${encodeURIComponent(this.token)}`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      ws.send(JSON.stringify({ type: 'join', name: this.name } satisfies ClientMessage));
      for (const m of this.queue.splice(0)) ws.send(JSON.stringify(m));
      if (this.beat) clearInterval(this.beat);
      this.beat = setInterval(() => this.send({ type: 'heartbeat', sentAt: Date.now() }), 2000);
    };
    ws.onmessage = (e) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(e.data as string) as ServerMessage;
      } catch {
        return;
      }
      if (msg.type === 'kicked' || msg.type === 'closed') this.closedByUser = true;
      for (const s of this.subs) s(msg);
    };
    ws.onclose = (e) => {
      if (this.beat) clearInterval(this.beat);
      this.beat = null;
      if (this.closedByUser) return;
      // 房间已不存在 / 被其他页面顶替：不再重连
      if (e.code === 4404 || e.code === 4000) {
        this.closedByUser = true;
        for (const s of this.subs) s({ type: 'closed', reason: e.code === 4000 ? '你已在其他页面进入该房间' : '房间已关闭' });
        return;
      }
      // 指数退避重连
      const delay = Math.min(10000, 500 * 2 ** this.retry++);
      setTimeout(() => this.open(), delay);
    };
  }

  /** 等待服务器确认加入（或返回错误） */
  handshake(timeoutMs = 6000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsub();
        reject(new Error('连接服务器超时，请检查网络'));
      }, timeoutMs);
      const unsub = this.subscribe((msg) => {
        if (msg.type === 'joined') {
          clearTimeout(timer);
          unsub();
          resolve();
        } else if (msg.type === 'error' || msg.type === 'closed' || msg.type === 'kicked') {
          clearTimeout(timer);
          unsub();
          reject(new Error(msg.type === 'error' ? msg.message : msg.reason));
        }
      });
    });
  }

  send(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    else if (msg.type !== 'heartbeat') this.queue.push(msg);
  }

  subscribe(cb: (msg: ServerMessage) => void) {
    this.subs.add(cb);
    return () => void this.subs.delete(cb);
  }

  close() {
    this.closedByUser = true;
    if (this.beat) clearInterval(this.beat);
    this.ws?.close();
  }
}

export class RemoteLobbyApi implements LobbyApi {
  readonly mode = 'remote' as const;
  private wsUrl: string;
  constructor(
    private apiUrl: string,
    wsUrl?: string,
  ) {
    this.wsUrl = wsUrl || defaultWsUrl();
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.apiUrl + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      throw new Error('无法连接服务器，请检查网络');
    }
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
    return data;
  }

  private async connect(s: Session) {
    const conn = new WebSocketConnection(this.wsUrl, s.code, s.playerId, s.token ?? '', s.role, s.name);
    try {
      await conn.handshake();
    } catch (e) {
      conn.close();
      throw e;
    }
    return conn;
  }

  async createRoom(hostName: string, config?: Partial<RoomConfig>) {
    const r = await this.post<{ code: string; playerId: string; token: string }>('/rooms', { hostName, config });
    const s: Session = { code: r.code, playerId: r.playerId, name: hostName, role: 'host', token: r.token };
    const conn = await this.connect(s);
    sessionStore.set(s);
    return conn;
  }

  async joinRoom(rawCode: string, name: string) {
    const code = rawCode.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== 6) throw new Error('邀请码为 6 位字母或数字');
    const r = await this.post<{ playerId: string; token: string }>(`/rooms/${code}/join`, { name });
    const s: Session = { code, playerId: r.playerId, name, role: 'guest', token: r.token };
    const conn = await this.connect(s);
    sessionStore.set(s);
    return conn;
  }

  resume(s: Session) {
    return this.connect(s);
  }
}
