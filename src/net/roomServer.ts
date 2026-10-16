// 房间服务器：权威的房间与牌局逻辑。
// 第一阶段运行在房主的浏览器标签页中；后续可以几乎原样移植到 Node.js 后端。

import { decideBid, decideMove } from '../game/ai';
import { recommendedDecks } from '../game/cards';
import { GameError, GameState, dealNewGame, isOut, isTeammate, nextSeat, passTurn, placeBid, playCards, viewFor } from '../game/engine';
import { GameRecord, buildRecord } from './adminHistory';
import { EMOJIS, QUICK_PHRASES, checkText, containsBlocked } from './moderation';
import {
  ClientMessage,
  DEAL_ANIMATION_MS,
  LANDLORD_REVEAL_MS,
  MAX_PLAYERS,
  MIN_CARDS_PER_PLAYER,
  MIN_PLAYERS,
  ChatMessage,
  ModerationEntry,
  RoomConfig,
  RoomPlayer,
  RoomState,
  RoomSummary,
  ServerMessage,
  defaultConfig,
} from './protocol';

export type Listener = (msg: ServerMessage) => void;

const OFFLINE_AFTER_MS = 6000;
const OFFLINE_TURN_GRACE_MS = 3000;
const AI_NAMES = ['AI·小智', 'AI·阿尔法', 'AI·深蓝', 'AI·星火', 'AI·北斗', 'AI·极光', 'AI·青云'];
const SIM_NAMES = ['小明', '阿杰', '静静', '老王', '小美', 'Tony', '大熊', '橙子', '可乐'];
const CHAT_KEEP = 30;
const CHAT_MIN_INTERVAL_MS = 1500;
const CHAT_BURST = { count: 5, windowMs: 15000 };
const VIOLATIONS_TO_MUTE = 3;
const MUTE_MS = 2 * 60 * 1000;
/** 后端模式下房主离线超过该时间（且不在牌局中）自动移交给其他在线玩家 */
const HOST_HANDOVER_MS = 30 * 1000;

export function randomId(prefix = 'p'): string {
  return prefix + '_' + Math.random().toString(36).slice(2, 10);
}

export interface RoomSnapshot {
  room: RoomState;
  game: GameState | null;
}

export class RoomServer {
  room: RoomState;
  game: GameState | null;
  private listeners = new Map<string, Listener>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private pendingAutoAt: number | null = null;
  private version = 0;
  closed = false;
  /**
   * 房主是否就是"服务器"本身（本地模拟模式）。
   * 真实后端中房主只是普通客户端：同样按心跳判断在线，长时间离线会自动移交房主。
   */
  hostIsServer = true;
  /** 状态变更回调（持久化、更新房间列表） */
  onChange: ((server: RoomServer) => void) | null = null;
  /** 每局结束回调（写入后台历史记录） */
  onRoundFinished: ((record: GameRecord) => void) | null = null;
  /** 拦截到违规聊天时回调（后端写入数据库） */
  onModeration: ((entry: ModerationEntry) => void) | null = null;
  /** 被拦截的聊天记录（只进入后台概要，不推送给玩家） */
  moderation: ModerationEntry[] = [];
  private chatTimes = new Map<string, number[]>();
  private violations = new Map<string, number[]>();
  private mutedUntil = new Map<string, number>();

  constructor(snapshot: RoomSnapshot) {
    this.room = snapshot.room;
    // 兼容旧版本快照
    this.room.config = { ...defaultConfig(), ...this.room.config };
    delete (this.room as { history?: unknown }).history;
    delete (this.room as { scores?: unknown }).scores;
    this.room.chat ??= [];
    this.game = snapshot.game;
  }

  static create(code: string, hostId: string, hostName: string, config?: Partial<RoomConfig>): RoomServer {
    const now = Date.now();
    const room: RoomState = {
      code,
      hostId,
      createdAt: now,
      config: { ...defaultConfig(), ...config },
      players: [
        { id: hostId, name: hostName, kind: 'human', isHost: true, online: true, ready: true, autoPlay: false, joinedAt: now, lastSeen: now, latency: 0 },
      ],
      status: 'waiting',
      round: 0,
      lastWinnerId: null,
      chat: [],
    };
    const server = new RoomServer({ room, game: null });
    server.normalizeConfig();
    return server;
  }

  start(): void {
    if (!this.timer) this.timer = setInterval(() => this.tick(), 400);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  destroy(reason = '房间已关闭'): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const l of this.listeners.values()) l({ type: 'closed', reason });
    this.listeners.clear();
  }

  snapshot(): RoomSnapshot {
    return { room: this.room, game: this.game };
  }

  /** 玩家连接（收到推送）。返回断开函数 */
  connect(playerId: string, listener: Listener): () => void {
    this.listeners.set(playerId, listener);
    this.sendState(playerId);
    return () => {
      if (this.listeners.get(playerId) === listener) this.listeners.delete(playerId);
    };
  }

  isMember(playerId: string): boolean {
    return this.room.players.some((p) => p.id === playerId);
  }

  // ---------------------------------------------------------------- 消息处理

  handle(playerId: string, msg: ClientMessage): void {
    try {
      this.dispatch(playerId, msg);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.listeners.get(playerId)?.({ type: 'error', message });
    }
  }

  private dispatch(playerId: string, msg: ClientMessage): void {
    const now = Date.now();
    if (msg.type === 'join') return this.join(playerId, msg.name);

    const me = this.room.players.find((p) => p.id === playerId);
    if (!me) throw new GameError('你不在该房间中');
    me.lastSeen = now;
    const wasOffline = !me.online;
    me.online = true;
    const isHost = playerId === this.room.hostId;

    switch (msg.type) {
      case 'heartbeat':
        me.latency = Math.max(1, now - msg.sentAt);
        // 心跳回包：让客户端确认与服务器的连接仍然正常
        if (wasOffline) this.changed();
        else this.sendState(playerId);
        return;
      case 'leave':
        return this.leave(me);
      case 'ready':
        if (this.room.status === 'playing') throw new GameError('游戏进行中');
        me.ready = isHost ? true : msg.ready;
        return this.changed();
      case 'config':
        this.requireHost(isHost);
        if (this.room.status === 'playing') throw new GameError('游戏进行中不能修改设置');
        this.room.config = { ...this.room.config, ...msg.patch };
        if (msg.patch.deckCount !== undefined) this.room.config.deckManual = true;
        if (msg.patch.seatCount !== undefined) this.room.config.autoSeats = false;
        this.normalizeConfig();
        return this.changed();
      case 'addSimulated':
        this.requireHost(isHost);
        return this.addSimulated();
      case 'kick': {
        this.requireHost(isHost);
        if (this.room.status === 'playing') throw new GameError('游戏进行中不能移除玩家');
        const target = this.room.players.find((p) => p.id === msg.targetId);
        if (!target || target.isHost) throw new GameError('无法移除该玩家');
        this.room.players = this.room.players.filter((p) => p !== target);
        this.listeners.get(target.id)?.({ type: 'kicked', reason: '你已被房主移出房间' });
        this.listeners.delete(target.id);
        this.normalizeConfig();
        return this.changed();
      }
      case 'start':
        this.requireHost(isHost);
        if (this.room.status !== 'waiting') throw new GameError('游戏已经开始');
        return this.startRound();
      case 'nextRound':
        this.requireHost(isHost);
        if (this.room.status !== 'finished') throw new GameError('本局尚未结束');
        return this.startRound();
      case 'backToLobby':
        this.requireHost(isHost);
        if (this.room.status === 'playing') throw new GameError('游戏进行中');
        this.room.status = 'waiting';
        this.game = null;
        this.room.players = this.room.players.filter((p) => p.kind !== 'ai');
        for (const p of this.room.players) if (p.kind === 'human' && !p.isHost) p.ready = false;
        this.normalizeConfig();
        return this.changed();
      case 'play':
        this.requireGame();
        this.game = playCards(this.game!, playerId, msg.cardIds);
        return this.afterMove();
      case 'pass':
        this.requireGame();
        this.game = passTurn(this.game!, playerId);
        return this.afterMove();
      case 'bid':
        this.requireGame();
        this.game = placeBid(this.game!, playerId, msg.call);
        return this.afterMove('bidding');
      case 'autoPlay':
        me.autoPlay = msg.on;
        return this.changed();
      case 'chat':
        return this.chat(me, msg.kind, msg.content, now);
    }
  }

  // ---------------------------------------------------------------- 聊天

  private chat(me: RoomPlayer, kind: ChatMessage['kind'], content: string, now: number): void {
    const policy = this.room.config.chat;
    if (policy === 'off') throw new GameError('房主已关闭聊天');
    const muted = this.mutedUntil.get(me.id) ?? 0;
    if (now < muted) throw new GameError(`你已被禁言，${Math.ceil((muted - now) / 1000)} 秒后可再次发言`);

    // 频率限制
    const times = (this.chatTimes.get(me.id) ?? []).filter((t) => now - t < CHAT_BURST.windowMs);
    if (times.length && now - times[times.length - 1] < CHAT_MIN_INTERVAL_MS) throw new GameError('发言太快了，请稍后再试');
    if (times.length >= CHAT_BURST.count) throw new GameError('发言太频繁，请稍后再试');

    let text: string;
    if (kind === 'phrase') {
      if (!(QUICK_PHRASES as readonly string[]).includes(content)) throw new GameError('无效的短语');
      text = content;
    } else if (kind === 'emoji') {
      if (!(EMOJIS as readonly string[]).includes(content)) throw new GameError('无效的表情');
      text = content;
    } else {
      if (policy !== 'full') throw new GameError('房主只允许发送快捷短语和表情');
      const result = checkText(content);
      if (!result.ok) {
        this.recordViolation(me, content, result.reason, now);
        const mutedNow = (this.mutedUntil.get(me.id) ?? 0) > now;
        throw new GameError(mutedNow ? `${result.reason}。多次违规，已被禁言 2 分钟` : result.reason);
      }
      text = result.text;
    }

    this.chatTimes.set(me.id, [...times, now]);
    this.room.chat = [...this.room.chat, { id: randomId('m'), playerId: me.id, name: me.name, kind, content: text, at: now }].slice(-CHAT_KEEP);
    this.changed();
  }

  private recordViolation(me: RoomPlayer, content: string, reason: string, now: number) {
    this.moderation = [{ playerId: me.id, name: me.name, content: content.slice(0, 40), reason, at: now }, ...this.moderation].slice(0, 50);
    const recent = [...(this.violations.get(me.id) ?? []).filter((t) => now - t < 5 * 60 * 1000), now];
    this.violations.set(me.id, recent);
    if (recent.length >= VIOLATIONS_TO_MUTE) {
      this.mutedUntil.set(me.id, now + MUTE_MS);
      this.violations.set(me.id, []);
      this.moderation[0].reason += '（已自动禁言 2 分钟）';
    }
    this.onModeration?.(this.moderation[0]);
    this.onChange?.(this);
  }

  private requireHost(isHost: boolean) {
    if (!isHost) throw new GameError('只有房主可以执行此操作');
  }

  private requireGame() {
    if (!this.game || this.room.status !== 'playing') throw new GameError('游戏未开始');
  }

  private humans(): RoomPlayer[] {
    return this.room.players.filter((p) => p.kind !== 'ai');
  }

  private capacity(): number {
    const max = this.room.config.mode === 'doudizhu' ? 4 : MAX_PLAYERS;
    return this.room.config.autoSeats ? max : Math.min(max, this.room.config.seatCount);
  }

  private join(playerId: string, name: string): void {
    const now = Date.now();
    const existing = this.room.players.find((p) => p.id === playerId);
    if (existing) {
      // 断线重连
      existing.online = true;
      existing.lastSeen = now;
      this.listeners.get(playerId)?.({ type: 'joined', playerId, code: this.room.code });
      return this.changed();
    }
    if (this.room.status !== 'waiting') throw new GameError('游戏进行中，暂时无法加入');
    if (this.humans().length >= this.capacity()) throw new GameError('房间已满');
    const clean = name.trim().slice(0, 12) || '玩家';
    if (containsBlocked(clean)) throw new GameError('昵称包含不文明内容，请修改后再加入');
    this.room.players.push({
      id: playerId,
      name: this.uniqueName(clean),
      kind: 'human',
      isHost: false,
      online: true,
      ready: false,
      autoPlay: false,
      joinedAt: now,
      lastSeen: now,
      latency: 0,
    });
    this.normalizeConfig();
    this.listeners.get(playerId)?.({ type: 'joined', playerId, code: this.room.code });
    this.changed();
  }

  private leave(me: RoomPlayer): void {
    if (me.isHost) {
      this.destroy('房主已解散房间');
      this.onChange?.(this);
      return;
    }
    this.listeners.delete(me.id);
    if (this.room.status === 'playing') {
      me.online = false;
      me.autoPlay = true;
    } else {
      this.room.players = this.room.players.filter((p) => p !== me);
      this.normalizeConfig();
    }
    this.changed();
  }

  private uniqueName(name: string): string {
    const names = new Set(this.room.players.map((p) => p.name));
    if (!names.has(name)) return name;
    for (let i = 2; ; i++) if (!names.has(`${name}${i}`)) return `${name}${i}`;
  }

  private addSimulated(): void {
    if (this.room.status === 'playing') throw new GameError('游戏进行中');
    if (this.humans().length >= this.capacity()) throw new GameError('房间已满');
    const used = new Set(this.room.players.map((p) => p.name));
    const name = SIM_NAMES.find((n) => !used.has(n)) ?? this.uniqueName('模拟玩家');
    const now = Date.now();
    const id = randomId('sim');
    this.room.players.push({
      id,
      name,
      kind: 'simulated',
      isHost: false,
      online: true,
      ready: false,
      autoPlay: false,
      // 模拟玩家在加入 0.6~2 秒后自动准备
      joinedAt: now + 600 + Math.random() * 1400,
      lastSeen: now,
      latency: 20 + Math.round(Math.random() * 60),
    });
    this.normalizeConfig();
    this.changed();
  }

  /** 修正配置：座位数、推荐牌副数、最少手牌数 */
  private normalizeConfig(): void {
    const c = this.room.config;
    const humans = this.humans().length;
    if (c.mode === 'doudizhu') {
      // 斗地主：3 人 1 副或 4 人 2 副，固定带大小王
      if (humans > 4) c.mode = 'paodekuai';
      else {
        c.seatCount = c.autoSeats ? Math.max(3, humans) : Math.min(4, Math.max(3, humans, Math.round(c.seatCount)));
        c.deckCount = c.seatCount === 3 ? 1 : 2;
        c.withJokers = true;
        c.turnSeconds = Math.max(0, Math.min(120, Math.round(c.turnSeconds)));
        return;
      }
    }
    if (c.autoSeats) c.seatCount = Math.max(MIN_PLAYERS, humans);
    c.seatCount = Math.min(MAX_PLAYERS, Math.max(MIN_PLAYERS, humans, Math.round(c.seatCount)));
    if (!c.deckManual) c.deckCount = recommendedDecks(c.seatCount);
    const perDeck = c.withJokers ? 54 : 52;
    const minDecks = Math.ceil((c.seatCount * MIN_CARDS_PER_PLAYER) / perDeck);
    c.deckCount = Math.min(8, Math.max(minDecks, 1, Math.round(c.deckCount)));
    c.turnSeconds = Math.max(0, Math.min(120, Math.round(c.turnSeconds)));
  }

  private startRound(): void {
    const notReady = this.humans().filter((p) => !p.ready && !p.isHost);
    if (notReady.length) throw new GameError(`还有玩家未准备：${notReady.map((p) => p.name).join('、')}`);

    // 再来一局时移除已离线的真人玩家，保留原有 AI，不足的座位再用 AI 补位
    if (this.room.status === 'finished') {
      this.room.players = this.room.players.filter((p) => p.kind === 'ai' || p.online || p.isHost);
    }
    this.normalizeConfig();
    let seatsNeeded = this.room.config.seatCount - this.humans().length;
    this.room.players = this.room.players.filter((p) => p.kind !== 'ai' || seatsNeeded-- > 0);
    const usedNames = new Set(this.room.players.map((p) => p.name));
    const aiNames = AI_NAMES.filter((n) => !usedNames.has(n));
    for (let i = 0; i < seatsNeeded; i++) {
      const id = randomId('ai');
      const now = Date.now();
      this.room.players.push({
        id,
        name: aiNames[i] ?? `AI·${i + 1}`,
        kind: 'ai',
        isHost: false,
        online: true,
        ready: true,
        autoPlay: false,
        joinedAt: now,
        lastSeen: now,
        latency: 0,
      });
    }

    this.room.round += 1;
    this.deal();
    this.room.status = 'playing';
    this.changed();
  }

  private deal(): void {
    this.game = dealNewGame({
      mode: this.room.config.mode,
      seats: this.room.players.map((p) => ({ id: p.id, name: p.name, isAI: p.kind === 'ai' })),
      deckCount: this.room.config.deckCount,
      withJokers: this.room.config.withJokers,
      round: this.room.round,
      previousWinnerId: this.room.lastWinnerId,
    });
    // 等待客户端播放完洗牌、发牌动画后才开始计时
    this.game.turnStartedAt = Date.now() + DEAL_ANIMATION_MS;
    this.pendingAutoAt = null;
  }

  private afterMove(prevPhase?: GameState['phase']): void {
    this.pendingAutoAt = null;
    const g = this.game!;
    if (g.bidding?.allPassed) {
      // 无人叫地主：重新洗牌发牌
      this.deal();
      this.game!.redealt = (g.redealt ?? 0) + 1;
    } else if (prevPhase === 'bidding' && g.phase === 'playing') {
      // 叫完地主：留出翻底牌动画时间
      g.turnStartedAt = Date.now() + LANDLORD_REVEAL_MS;
    }
    if (g.phase === 'finished' && g.settlement) {
      this.room.status = 'finished';
      this.room.lastWinnerId = g.seats[g.winnerSeat!].id;
      this.onRoundFinished?.(buildRecord(this.room, g));
    }
    this.changed();
  }

  // ---------------------------------------------------------------- 定时任务

  tick(now = Date.now()): void {
    let dirty = false;
    for (const p of this.room.players) {
      if (p.kind === 'human' && (!p.isHost || !this.hostIsServer) && p.online && now - p.lastSeen > OFFLINE_AFTER_MS) {
        p.online = false;
        dirty = true;
      }
      if (p.kind === 'simulated' && !p.ready && now >= p.joinedAt) {
        p.ready = true;
        dirty = true;
      }
    }
    if (!this.hostIsServer && this.room.status !== 'playing') dirty = this.handoverHost(now) || dirty;
    if (this.room.status === 'playing' && this.game) {
      if (this.runAutomation(now)) return; // 内部已广播
    }
    if (dirty) this.changed();
  }

  private handoverHost(now: number): boolean {
    const host = this.room.players.find((p) => p.isHost);
    if (!host || host.online || now - host.lastSeen < HOST_HANDOVER_MS) return false;
    const next = this.room.players.find((p) => p.kind === 'human' && p.online && !p.isHost);
    if (!next) return false;
    host.isHost = false;
    next.isHost = true;
    next.ready = true;
    this.room.hostId = next.id;
    return true;
  }

  /** 是否已经没有任何真人在线（用于后端清理空房间） */
  isIdle(): boolean {
    return !this.room.players.some((p) => p.kind === 'human' && p.online);
  }

  /** 需要由 AI 代替出牌的情况：AI、模拟玩家、托管、超时、掉线 */
  private runAutomation(now: number): boolean {
    const g = this.game!;
    const seat = g.seats[g.turn];
    const player = this.room.players.find((p) => p.id === seat.id);
    if (!player || now < g.turnStartedAt) return false;

    let delay: number | null = null;
    if (player.kind === 'ai' || player.kind === 'simulated') delay = 700 + Math.random() * 900;
    else if (player.autoPlay) delay = 600;
    else if (!player.online) delay = OFFLINE_TURN_GRACE_MS;
    else if (this.room.config.turnSeconds > 0 && now - g.turnStartedAt > this.room.config.turnSeconds * 1000) {
      player.autoPlay = true; // 超时自动托管
      delay = 0;
    }
    if (delay === null) return false;

    if (this.pendingAutoAt === null) this.pendingAutoAt = now + delay;
    if (now < this.pendingAutoAt) return false;

    this.pendingAutoAt = null;
    const level = this.room.config.aiLevel;
    const prevPhase = g.phase;

    if (g.phase === 'bidding') {
      this.game = placeBid(g, seat.id, decideBid(g.hands[seat.id], g.bidding!.candidate !== null, level), now);
      this.afterMove(prevPhase);
      return true;
    }

    const next = nextSeat(g, g.turn);
    const opponents = g.seats.map((_, i) => i).filter((i) => !isTeammate(g, i, g.turn) && !isOut(g, i));
    const cards = decideMove({
      hand: g.hands[seat.id],
      target: g.lastPlay?.pattern ?? null,
      minOpponentCards: opponents.length ? Math.min(...opponents.map((i) => g.hands[g.seats[i].id].length)) : 99,
      nextPlayerCards: g.hands[g.seats[next].id].length,
      mode: g.mode,
      level,
      teammateOnTop: g.lastPlay !== null && g.lastPlay.seat !== g.turn && isTeammate(g, g.lastPlay.seat, g.turn),
      nextIsTeammate: isTeammate(g, next, g.turn),
    });
    try {
      this.game = cards ? playCards(g, seat.id, cards.map((c) => c.id), now) : passTurn(g, seat.id, now);
    } catch {
      // 兜底：AI 给出了不合法的牌，领出时出最小单张，否则过牌
      this.game = g.lastPlay ? passTurn(g, seat.id, now) : playCards(g, seat.id, [g.hands[seat.id][0].id], now);
    }
    this.afterMove(prevPhase);
    return true;
  }

  // ---------------------------------------------------------------- 推送

  private changed(): void {
    this.version++;
    for (const id of this.listeners.keys()) this.sendState(id);
    this.onChange?.(this);
  }

  private sendState(playerId: string): void {
    const listener = this.listeners.get(playerId);
    if (!listener) return;
    listener({
      type: 'state',
      view: {
        room: this.room,
        game: this.game ? viewFor(this.game, playerId) : null,
        you: playerId,
        serverTime: Date.now(),
        version: this.version,
      },
    });
  }

  summary(): RoomSummary {
    const r = this.room;
    const g = this.game;
    const host = r.players.find((p) => p.isHost);
    return {
      code: r.code,
      hostName: host?.name ?? '-',
      mode: r.config.mode,
      status: r.status,
      round: r.round,
      seatCount: r.config.seatCount,
      deckCount: r.config.deckCount,
      withJokers: r.config.withJokers,
      createdAt: r.createdAt,
      updatedAt: Date.now(),
      players: r.players.map((p) => ({
        id: p.id,
        name: p.name,
        kind: p.kind,
        isHost: p.isHost,
        online: p.online,
        ready: p.ready,
        autoPlay: p.autoPlay,
        latency: p.latency,
        cards: g ? g.hands[p.id]?.length ?? null : null,
      })),
      turnPlayer: g && g.phase !== 'finished' ? g.seats[g.turn].name : null,
      totalPlays: g ? g.log.filter((l) => l.action === 'play').length : 0,
      chat: r.chat.slice(-15),
      moderation: this.moderation.slice(0, 20),
    };
  }
}
