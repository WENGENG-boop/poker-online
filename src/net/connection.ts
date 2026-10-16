// 连接层：前端只依赖 RoomConnection 接口。
//  - HostConnection   ：房主标签页内直接与 RoomServer 通信，并通过 BroadcastChannel 为其他标签页提供服务
//  - TabConnection    ：同一浏览器的其他标签页（模拟另一台设备）通过 BroadcastChannel 连接房主
//  - WebSocketConnection（见 remote.ts）：后续接入真实服务器

import { ClientMessage, ServerMessage } from './protocol';
import { RoomServer } from './roomServer';
import { adminHistoryStore } from './adminHistory';
import { registry, saveSnapshot, removeSnapshot } from './storage';

export interface RoomConnection {
  readonly playerId: string;
  readonly code: string;
  readonly role: 'host' | 'guest';
  send(msg: ClientMessage): void;
  subscribe(cb: (msg: ServerMessage) => void): () => void;
  close(): void;
}

type Envelope =
  | { dir: 'c2s'; from: string; msg: ClientMessage }
  | { dir: 's2c'; to: string; msg: ServerMessage };

export const channelName = (code: string) => `poker-room-${code}`;

const idle = (fn: () => void) =>
  typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: 3000 }) : setTimeout(fn, 200);

class Emitter {
  private subs = new Set<(msg: ServerMessage) => void>();
  private last: ServerMessage | null = null;
  emit(msg: ServerMessage) {
    if (msg.type === 'state') this.last = msg;
    for (const s of this.subs) s(msg);
  }
  subscribe(cb: (msg: ServerMessage) => void) {
    this.subs.add(cb);
    if (this.last) cb(this.last);
    return () => void this.subs.delete(cb);
  }
}

/** 房主连接：持有 RoomServer，同时作为跨标签页的"服务器" */
export class HostConnection implements RoomConnection {
  readonly role = 'host' as const;
  readonly playerId: string;
  readonly code: string;
  private emitter = new Emitter();
  private channel: BroadcastChannel | null;
  private remoteUnsubs = new Map<string, () => void>();
  private disconnectSelf: () => void;
  private beat: ReturnType<typeof setInterval>;

  constructor(readonly server: RoomServer) {
    this.playerId = server.room.hostId;
    this.code = server.room.code;
    this.channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(channelName(this.code)) : null;
    this.channel?.addEventListener('message', (e: MessageEvent<Envelope>) => this.onRemote(e.data));

    server.onChange = (s) => {
      if (s.closed) {
        if (this.persistTimer) clearTimeout(this.persistTimer);
        registry.remove(s.room.code);
        removeSnapshot(s.room.code);
        return;
      }
      // 写 localStorage 是同步操作，合并到最多每 500ms 一次，避免出牌时卡顿
      this.persistTimer ??= setTimeout(() => this.persist(), 500);
    };
    // 每局结束写入后台历史记录（真实后端由服务器自己保存）；放到空闲时执行
    server.onRoundFinished = (record) => idle(() => adminHistoryStore.save(record));
    this.disconnectSelf = server.connect(this.playerId, (msg) => this.emitter.emit(msg));
    server.start();
    registry.put(server.summary());
    saveSnapshot(server.snapshot());
    // 定期刷新房间概要，后台据此判断房主是否在线
    this.beat = setInterval(() => registry.put(server.summary()), 2000);
  }

  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  private persist() {
    this.persistTimer = null;
    if (this.server.closed) return;
    saveSnapshot(this.server.snapshot());
    registry.put(this.server.summary());
  }

  private onRemote(env: Envelope) {
    if (env.dir !== 'c2s') return;
    const { from, msg } = env;
    if ((msg.type === 'join' || this.server.isMember(from)) && !this.remoteUnsubs.has(from)) {
      const unsub = this.server.connect(from, (out) => {
        this.channel?.postMessage({ dir: 's2c', to: from, msg: out } satisfies Envelope);
        if (out.type === 'kicked' || out.type === 'closed') this.dropRemote(from);
      });
      this.remoteUnsubs.set(from, unsub);
    }
    if (!this.server.isMember(from) && msg.type !== 'join') {
      this.channel?.postMessage({ dir: 's2c', to: from, msg: { type: 'error', message: '你不在该房间中' } } satisfies Envelope);
      return;
    }
    this.server.handle(from, msg);
    if (msg.type === 'leave') this.dropRemote(from);
    // 加入失败时释放监听
    if (msg.type === 'join' && !this.server.isMember(from)) this.dropRemote(from);
  }

  private dropRemote(id: string) {
    this.remoteUnsubs.get(id)?.();
    this.remoteUnsubs.delete(id);
  }

  send(msg: ClientMessage) {
    this.server.handle(this.playerId, msg);
  }

  subscribe(cb: (msg: ServerMessage) => void) {
    return this.emitter.subscribe(cb);
  }

  close() {
    clearInterval(this.beat);
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persist();
    }
    this.disconnectSelf();
    for (const u of this.remoteUnsubs.values()) u();
    this.remoteUnsubs.clear();
    // 仅停止计时器：页面刷新时保留快照，房主重新打开后可恢复房间
    this.server.stop();
    this.channel?.close();
  }
}

/** 访客连接：通过 BroadcastChannel 与房主标签页通信 */
export class TabConnection implements RoomConnection {
  readonly role = 'guest' as const;
  private emitter = new Emitter();
  private channel: BroadcastChannel;
  private beat: ReturnType<typeof setInterval>;

  constructor(readonly code: string, readonly playerId: string) {
    this.channel = new BroadcastChannel(channelName(code));
    this.channel.addEventListener('message', (e: MessageEvent<Envelope>) => {
      if (e.data.dir === 's2c' && e.data.to === playerId) this.emitter.emit(e.data.msg);
    });
    this.beat = setInterval(() => this.send({ type: 'heartbeat', sentAt: Date.now() }), 2000);
  }

  /** 发送加入请求并等待服务器确认 */
  handshake(name: string, timeoutMs = 2500): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsub();
        reject(new Error('房间无响应：房主可能已离线'));
      }, timeoutMs);
      const unsub = this.emitter.subscribe((msg) => {
        if (msg.type === 'joined') {
          clearTimeout(timer);
          unsub();
          resolve();
        } else if (msg.type === 'error' || msg.type === 'closed') {
          clearTimeout(timer);
          unsub();
          reject(new Error(msg.type === 'error' ? msg.message : msg.reason));
        }
      });
      this.send({ type: 'join', name });
    });
  }

  send(msg: ClientMessage) {
    this.channel.postMessage({ dir: 'c2s', from: this.playerId, msg } satisfies Envelope);
  }

  subscribe(cb: (msg: ServerMessage) => void) {
    return this.emitter.subscribe(cb);
  }

  close() {
    clearInterval(this.beat);
    this.channel.close();
  }
}
