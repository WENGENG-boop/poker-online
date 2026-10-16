// 大厅 API：创建房间、通过邀请码加入、恢复会话。（后台相关接口见 adminApi.ts）
// 前端只依赖 LobbyApi 接口；当前使用 MockLobbyApi（本地模拟），
// 配置 VITE_API_URL（以及可选的 VITE_WS_URL）后切换为 RemoteLobbyApi，连接 server/ 目录中的后端。

import { HostConnection, RoomConnection, TabConnection } from './connection';
import { RoomConfig } from './protocol';
import { generateInviteCode, normalizeCode } from './inviteCode';
import { RoomServer, randomId } from './roomServer';
import { Session, loadSnapshot, registry, sessionStore } from './storage';
import { containsBlocked } from './moderation';
import { RemoteLobbyApi } from './remote';

export interface LobbyApi {
  readonly mode: 'mock' | 'remote';
  createRoom(hostName: string, config?: Partial<RoomConfig>): Promise<RoomConnection>;
  joinRoom(code: string, name: string): Promise<RoomConnection>;
  /** 页面刷新后恢复之前的连接 */
  resume(session: Session): Promise<RoomConnection>;
}

export { generateInviteCode, normalizeCode } from './inviteCode';

class MockLobbyApi implements LobbyApi {
  readonly mode = 'mock' as const;

  async createRoom(hostName: string, config?: Partial<RoomConfig>): Promise<RoomConnection> {
    if (containsBlocked(hostName)) throw new Error('昵称包含不文明内容，请修改');
    const code = generateInviteCode((c) => registry.get(c) !== null);
    const hostId = randomId('host');
    const server = RoomServer.create(code, hostId, hostName.trim() || '房主', config);
    const conn = new HostConnection(server);
    sessionStore.set({ code, playerId: hostId, name: hostName, role: 'host' });
    return conn;
  }

  async joinRoom(rawCode: string, name: string): Promise<RoomConnection> {
    const code = normalizeCode(rawCode);
    if (code.length !== 6) throw new Error('邀请码为 6 位字母或数字');
    const summary = registry.get(code);
    if (!summary) throw new Error('房间不存在，请检查邀请码');
    if (!registry.isHostAlive(summary)) throw new Error('房主当前不在线，请稍后再试');
    const playerId = randomId('p');
    const conn = new TabConnection(code, playerId);
    try {
      await conn.handshake(name.trim() || '玩家');
    } catch (e) {
      conn.close();
      throw e;
    }
    sessionStore.set({ code, playerId, name, role: 'guest' });
    return conn;
  }

  async resume(s: Session): Promise<RoomConnection> {
    if (s.role === 'host') {
      const snap = loadSnapshot(s.code);
      if (!snap || snap.room.hostId !== s.playerId) throw new Error('房间已失效');
      const now = Date.now();
      for (const p of snap.room.players) p.lastSeen = now;
      if (snap.game) snap.game.turnStartedAt = now;
      return new HostConnection(new RoomServer(snap));
    }
    const conn = new TabConnection(s.code, s.playerId);
    try {
      await conn.handshake(s.name);
    } catch (e) {
      conn.close();
      throw e;
    }
    return conn;
  }
}

const env = import.meta.env as Record<string, string | undefined>;

/** 配置了 VITE_API_URL（例如 /api）时连接真实后端，否则使用浏览器内的本地模拟 */
export const lobbyApi: LobbyApi = env.VITE_API_URL ? new RemoteLobbyApi(env.VITE_API_URL, env.VITE_WS_URL) : new MockLobbyApi();
