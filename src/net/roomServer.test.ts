import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage, ServerView } from './protocol';
import { RoomServer } from './roomServer';
import type { GameRecord } from './adminHistory';

describe('RoomServer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup() {
    const server = RoomServer.create('ABCDEF', 'host', '房主');
    const views: Record<string, ServerView> = {};
    const errors: string[] = [];
    const listen = (id: string) =>
      server.connect(id, (m: ServerMessage) => {
        if (m.type === 'state') views[id] = m.view;
        if (m.type === 'error') errors.push(m.message);
      });
    listen('host');
    return { server, views, errors, listen };
  }

  it('2 名真人自动补 1 名 AI，并完成整局与再来一局', () => {
    const { server, views, errors, listen } = setup();
    const records: GameRecord[] = [];
    server.onRoundFinished = (r) => records.push(r);
    listen('g1');
    server.handle('g1', { type: 'join', name: '小红' });
    expect(views.host.room.players.length).toBe(2);

    server.handle('host', { type: 'start' });
    expect(errors.pop()).toContain('未准备');

    server.handle('g1', { type: 'ready', ready: true });
    server.handle('host', { type: 'start' });
    const room = views.host.room;
    expect(room.status).toBe('playing');
    expect(room.players.filter((p) => p.kind === 'ai').length).toBe(1);
    expect(views.g1.game!.myHand.length).toBe(18);
    // 看不到别人的手牌
    expect(views.g1.game!.revealedHands).toBeNull();

    server.handle('host', { type: 'autoPlay', on: true });
    server.handle('g1', { type: 'autoPlay', on: true });
    for (let i = 0; i < 2000 && server.room.status === 'playing'; i++) {
      vi.advanceTimersByTime(2000);
      server.handle('g1', { type: 'heartbeat', sentAt: Date.now() });
      server.tick();
    }
    expect(server.room.status).toBe('finished');
    expect(views.host.game!.settlement!.map((r) => r.rank)).toEqual([1, 2, 3]);

    // 后台历史记录：能还原每人初始手牌
    expect(records.length).toBe(1);
    const all = Object.values(records[0].initialHands).flat();
    expect(all.length).toBe(54);
    expect(new Set(all.map((c) => c.id)).size).toBe(54);
    for (const h of Object.values(records[0].initialHands)) expect(h.length).toBe(18);

    server.handle('host', { type: 'nextRound' });
    expect(server.room.status).toBe('playing');
    expect(server.room.round).toBe(2);
    // 上一局赢家先出
    expect(server.game!.seats[server.game!.turn].id).toBe(server.room.lastWinnerId);
  });

  it('房主配置：座位数与推荐牌副数', () => {
    const { server } = setup();
    for (let i = 0; i < 3; i++) server.handle('host', { type: 'addSimulated' });
    expect(server.room.config.seatCount).toBe(4);
    expect(server.room.config.deckCount).toBe(2);
    server.handle('host', { type: 'config', patch: { seatCount: 6 } });
    expect(server.room.config.deckCount).toBe(3);
    server.handle('host', { type: 'config', patch: { deckCount: 1 } });
    expect(server.room.config.deckCount).toBe(1);
    expect(server.room.config.deckManual).toBe(true);
  });

  it('非房主不能开局或修改设置', () => {
    const { server, errors, listen } = setup();
    listen('g1');
    server.handle('g1', { type: 'join', name: 'x' });
    server.handle('g1', { type: 'start' });
    server.handle('g1', { type: 'config', patch: { deckCount: 3 } });
    expect(errors.filter((e) => e.includes('房主')).length).toBe(2);
  });

  it('斗地主：叫地主、出牌直至结束', () => {
    const { server, views } = setup();
    server.handle('host', { type: 'config', patch: { mode: 'doudizhu' } });
    server.handle('host', { type: 'addSimulated' });
    expect(server.room.config.deckCount).toBe(1);
    vi.advanceTimersByTime(3000);
    server.tick();
    server.handle('host', { type: 'start' });
    expect(server.game!.phase).toBe('bidding');
    expect(views.host.game!.myHand.length).toBe(17);
    server.handle('host', { type: 'autoPlay', on: true });
    for (let i = 0; i < 3000 && server.room.status === 'playing'; i++) {
      vi.advanceTimersByTime(2000);
      server.tick();
    }
    expect(server.room.status).toBe('finished');
    const g = server.game!;
    expect(g.landlordSeat).not.toBeNull();
    expect(g.settlement!.filter((r) => r.rank === 1).length).toBe(g.winners!.length);
  });
});

describe('RoomServer 聊天', () => {
  it('短语与表情直接发送，违规文字被拦截且不广播，多次违规自动禁言', () => {
    vi.useFakeTimers();
    const server = RoomServer.create('ABCDEF', 'host', '房主');
    const errors: string[] = [];
    server.connect('host', (m) => m.type === 'error' && errors.push(m.message));
    server.handle('host', { type: 'chat', kind: 'phrase', content: '好牌' });
    vi.advanceTimersByTime(2000);
    server.handle('host', { type: 'chat', kind: 'emoji', content: '👍' });
    vi.advanceTimersByTime(2000);
    server.handle('host', { type: 'chat', kind: 'emoji', content: '🖕' });
    expect(errors.pop()).toContain('无效');
    expect(server.room.chat.map((c) => c.content)).toEqual(['好牌', '👍']);

    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(2000);
      server.handle('host', { type: 'chat', kind: 'text', content: '傻逼' });
    }
    expect(server.room.chat.length).toBe(2);
    expect(server.summary().moderation.length).toBe(3);
    expect(errors.pop()).toContain('禁言');
    vi.advanceTimersByTime(2000);
    server.handle('host', { type: 'chat', kind: 'phrase', content: '谢谢' });
    expect(errors.pop()).toContain('禁言');

    server.handle('host', { type: 'config', patch: { chat: 'preset' } });
    vi.advanceTimersByTime(3 * 60 * 1000);
    server.handle('host', { type: 'chat', kind: 'text', content: '你好' });
    expect(errors.pop()).toContain('只允许');
    vi.useRealTimers();
  });
});
