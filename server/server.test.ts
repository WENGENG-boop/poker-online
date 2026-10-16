// 后端端到端测试：真实 HTTP + WebSocket

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { ServerMessage, ServerView } from '../src/net/protocol';
import { App, createApp } from './app';

const dir = mkdtempSync(join(tmpdir(), 'poker-test-'));
const dbFile = join(dir, 'poker.db');
const ADMIN = 'test-admin-pass';
let app: App;

afterAll(async () => {
  await app?.close().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
});

const base = () => `http://127.0.0.1:${app.port}`;

async function post(path: string, body: unknown, token?: string) {
  const res = await fetch(base() + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, string> };
}

async function get(path: string, token: string) {
  const res = await fetch(base() + path, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, data: await res.json() };
}

class Client {
  ws: WebSocket;
  messages: ServerMessage[] = [];
  view: ServerView | null = null;
  constructor(code: string, playerId: string, token: string) {
    this.ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws/rooms/${code}?playerId=${playerId}&token=${token}`);
    this.ws.on('message', (d) => {
      const msg = JSON.parse(d.toString()) as ServerMessage;
      this.messages.push(msg);
      if (msg.type === 'state') this.view = msg.view;
    });
  }
  opened() {
    return new Promise<void>((ok, fail) => {
      this.ws.once('open', () => ok());
      this.ws.once('error', fail);
      this.ws.once('unexpected-response', () => fail(new Error('rejected')));
    });
  }
  send(msg: unknown) {
    this.ws.send(JSON.stringify(msg));
  }
  async waitFor(pred: (m: ServerMessage) => boolean, ms = 3000): Promise<ServerMessage> {
    const start = Date.now();
    for (;;) {
      const found = this.messages.find(pred);
      if (found) return found;
      if (Date.now() - start > ms) throw new Error('等待消息超时');
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  close() {
    this.ws.close();
  }
}

describe('后端', () => {
  let code = '';
  let hostId = '';
  let hostToken = '';
  let guestId = '';
  let guestToken = '';
  let host: Client;
  let guest: Client;

  it('启动服务', async () => {
    app = await createApp({ port: 0, host: '127.0.0.1', dbFile, adminPassword: ADMIN, quiet: true });
    const res = await fetch(base() + '/api/health');
    expect(res.status).toBe(200);
  });

  it('创建房间、昵称审核', async () => {
    expect((await post('/api/rooms', { hostName: '傻逼' })).status).toBe(400);
    expect((await post('/api/rooms', { hostName: '' })).status).toBe(400);
    const r = await post('/api/rooms', { hostName: '房主', config: { mode: 'paodekuai', evil: 1 } });
    expect(r.status).toBe(200);
    ({ code, playerId: hostId, token: hostToken } = r.data);
    expect(code).toMatch(/^[A-Z0-9]{6}$/);
  });

  it('伪造令牌无法连接', async () => {
    const bad = new Client(code, hostId, 'forged');
    await expect(bad.opened()).rejects.toThrow();
  });

  it('房主与访客通过 WebSocket 加入', async () => {
    host = new Client(code, hostId, hostToken);
    await host.opened();
    host.send({ type: 'join', name: '房主' });
    await host.waitFor((m) => m.type === 'joined');

    expect((await post(`/api/rooms/${code}/join`, { name: 'nmsl' })).status).toBe(400);
    expect((await post('/api/rooms/ZZZZZZ/join', { name: '小红' })).status).toBe(404);
    const r = await post(`/api/rooms/${code}/join`, { name: '小红' });
    ({ playerId: guestId, token: guestToken } = r.data);
    guest = new Client(code, guestId, guestToken);
    await guest.opened();
    guest.send({ type: 'join', name: '小红' });
    await guest.waitFor((m) => m.type === 'joined');
    await host.waitFor((m) => m.type === 'state' && m.view.room.players.length === 2);
  });

  it('非法消息被忽略，违规聊天被拦截并进入后台', async () => {
    guest.send({ type: 'play', cardIds: 'x' });
    guest.send('garbage');
    guest.send({ type: 'config', patch: { deckCount: 99 } });
    guest.send({ type: 'chat', kind: 'text', content: '你个垃圾' });
    await guest.waitFor((m) => m.type === 'error' && m.message.includes('拦截'));
    expect(host.messages.some((m) => m.type === 'state' && m.view.room.chat.some((c) => c.content.includes('垃圾')))).toBe(false);
    guest.send({ type: 'chat', kind: 'phrase', content: '好牌' });
    await host.waitFor((m) => m.type === 'state' && m.view.room.chat.some((c) => c.content === '好牌'));
  });

  it('开局：只能看到自己的手牌', async () => {
    guest.send({ type: 'ready', ready: true });
    await host.waitFor((m) => m.type === 'state' && m.view.room.players.find((p) => p.id === guestId)?.ready === true);
    host.send({ type: 'start' });
    await guest.waitFor((m) => m.type === 'state' && m.view.room.status === 'playing');
    const v = guest.view!;
    expect(v.game!.myHand.length).toBe(18);
    expect(v.game!.revealedHands).toBeNull();
    expect(JSON.stringify(v)).not.toContain('"hands"');
  });

  it('后台：密码错误被拒绝，登录后可查看房间', async () => {
    expect((await post('/api/admin/login', { password: 'wrong' })).status).toBe(401);
    expect((await get('/api/admin/rooms', 'nope')).status).toBe(401);
    const login = await post('/api/admin/login', { password: ADMIN });
    expect(login.status).toBe(200);
    const rooms = await get('/api/admin/rooms', login.data.token);
    expect(rooms.data[0].code).toBe(code);
    expect(rooms.data[0].moderation.length).toBe(1);
  });

  it('整局打完后写入数据库，后台可查到历史记录', async () => {
    const room = app.rooms.get(code)!;
    // 推进服务器时钟，让 AI 托管所有人直到结束
    let now = Date.now();
    for (let i = 0; i < 4000 && room.room.status === 'playing'; i++) room.tick((now += 2000));
    expect(room.room.status).toBe('finished');
    await host.waitFor((m) => m.type === 'state' && m.view.game?.phase === 'finished');
    const login = await post('/api/admin/login', { password: ADMIN });
    const history = await get('/api/admin/history', login.data.token);
    expect(history.data.length).toBe(1);
    expect(history.data[0].roomCode).toBe(code);
    expect(history.data[0].settlement.map((r: { rank: number }) => r.rank).sort()).toEqual([1, 2, 3]);
    // 快进时钟让访客被判为离线；发送心跳恢复在线后再来一局（离线玩家会被移出）
    guest.send({ type: 'heartbeat', sentAt: Date.now() });
    await host.waitFor((m) => m.type === 'state' && m.view.room.status === 'finished' && m.view.room.players.find((p) => p.id === guestId)?.online === true);
    host.send({ type: 'heartbeat', sentAt: Date.now() });
    host.send({ type: 'nextRound' });
    await guest.waitFor((m) => m.type === 'state' && m.view.room.round === 2);
  });

  it('服务器重启后房间恢复，玩家可用原令牌重连', async () => {
    host.close();
    guest.close();
    await app.close();
    app = await createApp({ port: 0, host: '127.0.0.1', dbFile, adminPassword: ADMIN, quiet: true });
    const again = new Client(code, guestId, guestToken);
    await again.opened();
    again.send({ type: 'join', name: '小红' });
    await again.waitFor((m) => m.type === 'joined');
    const st = (await again.waitFor((m) => m.type === 'state')) as Extract<ServerMessage, { type: 'state' }>;
    expect(st.view.game!.myHand.length).toBe(18);
    again.close();
  });
});
