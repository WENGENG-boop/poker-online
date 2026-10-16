// 房间管理：创建、查找、持久化、重启恢复、清理空闲房间

import { generateInviteCode } from '../src/net/inviteCode';
import type { RoomConfig, RoomSummary } from '../src/net/protocol';
import { RoomServer, randomId } from '../src/net/roomServer';
import type { Store } from './db';
import { log } from './log';

/** 无人在线超过该时间的房间会被清理 */
const IDLE_ROOM_MS = 30 * 60 * 1000;
/** 重启时只恢复最近这段时间内活跃过的房间 */
const RESTORE_MAX_AGE_MS = 6 * 3600 * 1000;
const PERSIST_DEBOUNCE_MS = 1000;

export class RoomManager {
  private rooms = new Map<string, RoomServer>();
  private idleSince = new Map<string, number>();
  private persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private sweepTimer: ReturnType<typeof setInterval>;

  constructor(
    private store: Store,
    private maxRooms: number,
  ) {
    this.restore();
    this.sweepTimer = setInterval(() => this.sweep(), 60 * 1000);
  }

  get size() {
    return this.rooms.size;
  }

  get(code: string): RoomServer | undefined {
    return this.rooms.get(code);
  }

  create(hostName: string, config: Partial<RoomConfig>): { code: string; hostId: string } {
    if (this.rooms.size >= this.maxRooms) throw new Error('服务器房间已满，请稍后再试');
    const code = generateInviteCode((c) => this.rooms.has(c));
    const hostId = randomId('host');
    const server = RoomServer.create(code, hostId, hostName, config);
    // 刚创建时房主还没连上 WebSocket，先视为在线，等心跳超时再判定
    this.wire(server);
    this.persist(server);
    log('房间创建', code, hostName);
    return { code, hostId };
  }

  summaries(): RoomSummary[] {
    return [...this.rooms.values()].filter((r) => !r.closed).map((r) => r.summary());
  }

  close(code: string, reason = '房间已被管理员关闭') {
    const server = this.rooms.get(code);
    if (!server) return false;
    server.destroy(reason);
    this.drop(code);
    return true;
  }

  private wire(server: RoomServer) {
    const code = server.room.code;
    server.hostIsServer = false;
    server.onChange = (s) => {
      if (s.closed) return this.drop(code);
      this.schedulePersist(s);
    };
    server.onRoundFinished = (record) => {
      try {
        this.store.addHistory(record);
      } catch (e) {
        log('保存历史记录失败', code, e);
      }
    };
    server.onModeration = (entry) => {
      log('拦截聊天', code, entry.name, entry.reason);
      this.store.addModeration(code, entry);
    };
    this.rooms.set(code, server);
    server.start();
  }

  private schedulePersist(server: RoomServer) {
    const code = server.room.code;
    if (this.persistTimers.has(code)) return;
    this.persistTimers.set(
      code,
      setTimeout(() => {
        this.persistTimers.delete(code);
        if (!server.closed) this.persist(server);
      }, PERSIST_DEBOUNCE_MS),
    );
  }

  private persist(server: RoomServer) {
    try {
      this.store.saveRoom(server.snapshot());
    } catch (e) {
      log('保存房间失败', server.room.code, e);
    }
  }

  private drop(code: string) {
    const t = this.persistTimers.get(code);
    if (t) clearTimeout(t);
    this.persistTimers.delete(code);
    this.rooms.get(code)?.stop();
    this.rooms.delete(code);
    this.idleSince.delete(code);
    this.store.deleteRoom(code);
    log('房间关闭', code);
  }

  /** 服务器重启后恢复房间：所有真人先标记为离线，等待重连 */
  private restore() {
    const now = Date.now();
    for (const snap of this.store.loadRooms(RESTORE_MAX_AGE_MS)) {
      for (const p of snap.room.players) {
        if (p.kind === 'human') {
          p.online = false;
          p.lastSeen = now;
        }
      }
      // 给玩家留出重连时间
      if (snap.game && snap.game.phase !== 'finished') snap.game.turnStartedAt = Math.max(snap.game.turnStartedAt, now + 5000);
      this.wire(new RoomServer(snap));
    }
    if (this.rooms.size) log(`已恢复 ${this.rooms.size} 个房间`);
  }

  private sweep() {
    const now = Date.now();
    for (const [code, server] of this.rooms) {
      if (!server.isIdle()) {
        this.idleSince.delete(code);
        continue;
      }
      const since = this.idleSince.get(code) ?? now;
      this.idleSince.set(code, since);
      if (now - since > IDLE_ROOM_MS) this.close(code, '房间长时间无人，已自动关闭');
    }
  }

  /** 关闭服务器前把所有房间写入数据库 */
  shutdown() {
    clearInterval(this.sweepTimer);
    for (const t of this.persistTimers.values()) clearTimeout(t);
    this.persistTimers.clear();
    for (const server of this.rooms.values()) {
      server.stop();
      if (!server.closed) this.persist(server);
    }
  }
}
