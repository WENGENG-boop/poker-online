// 游戏引擎：纯函数式的状态流转（洗牌、发牌、叫地主、出牌、过牌、回合、名次）
// 该模块不依赖 UI 与网络，后续可原样迁移到服务器端作为权威逻辑。
//
// 不计积分，只排名次：
//  - 跑得快：人人为敌。出完牌的玩家依次获得第 1、2、3… 名，其余玩家继续打，
//            直到只剩最后一人。出完牌后若无人能压，由其下家接风领出。
//  - 斗地主：3 人 1 副（每人 17 张 + 3 张底牌）或 4 人 2 副（每人 25 张 + 8 张底牌）。
//            轮流"叫地主 / 抢地主"一次，最后叫或抢的人成为地主，拿底牌先出。
//            地主或任一农民先出完，其所在一方获胜（并列第 1 名），其余按剩余牌数排名。

import { Card, compareCards, createDecks, shuffle, sortByRank } from './cards';
import { GameMode, Pattern, isBombLike, resolvePlay } from './rules';

export interface SeatInfo {
  id: string;
  name: string;
  isAI: boolean;
}

export type SeatAction =
  | { kind: 'play'; cards: Card[]; pattern: Pattern; at: number }
  | { kind: 'pass'; at: number }
  /** called：true 为叫地主/抢地主，false 为不叫/不抢 */
  | { kind: 'bid'; called: boolean; grab: boolean; at: number };

export interface LogEntry {
  seat: number;
  action: 'play' | 'pass';
  cards?: Card[];
  pattern?: Pattern;
  at: number;
}

export type Role = 'landlord' | 'farmer';

export interface Settlement {
  playerId: string;
  name: string;
  /** 结束时剩余手牌数 */
  remaining: number;
  /** 名次，从 1 开始；斗地主获胜一方并列第 1 */
  rank: number;
  role?: Role;
}

export interface BiddingState {
  /** 最后一个叫/抢地主的座位 */
  candidate: number | null;
  /** 每个座位的表态 */
  calls: Record<number, boolean>;
  count: number;
  /** 无人叫地主，需要重新发牌 */
  allPassed: boolean;
}

export interface GameState {
  mode: GameMode;
  round: number;
  phase: 'bidding' | 'playing' | 'finished';
  seats: SeatInfo[];
  hands: Record<string, Card[]>;
  /** 跑得快：未发出的余牌；斗地主：底牌 */
  leftover: Card[];
  turn: number;
  /** 本轮桌面上最大的一手牌 */
  lastPlay: { seat: number; cards: Card[]; pattern: Pattern } | null;
  /** 当前一轮中各座位最近的动作，用于在座位旁展示 */
  seatActions: Record<number, SeatAction | undefined>;
  passCount: number;
  bombs: number;
  log: LogEntry[];
  bidding: BiddingState | null;
  landlordSeat: number | null;
  /** 已出完牌的座位，按出完先后排列 */
  finishOrder: number[];
  /** 第一名（最先出完）的座位 */
  winnerSeat: number | null;
  /** 获胜的座位（斗地主为获胜一方） */
  winners: number[] | null;
  settlement: Settlement[] | null;
  startedAt: number;
  turnStartedAt: number;
  /** 本局因无人叫地主而重新发牌的次数 */
  redealt?: number;
}

export interface DealOptions {
  mode?: GameMode;
  seats: SeatInfo[];
  deckCount: number;
  withJokers: boolean;
  round: number;
  /** 上局赢家 id，存在则由其先出（斗地主中先叫地主） */
  previousWinnerId?: string | null;
}

export class GameError extends Error {}

/** 斗地主底牌张数 */
export function bottomCount(players: number): number {
  return players === 3 ? 3 : 8;
}

/** 洗牌 + 发牌，生成新一局 */
export function dealNewGame(opts: DealOptions, now = Date.now()): GameState {
  const { seats } = opts;
  const mode = opts.mode ?? 'paodekuai';
  if (seats.length < 3) throw new GameError('至少需要 3 名玩家');
  if (mode === 'doudizhu' && seats.length > 4) throw new GameError('斗地主支持 3～4 人');
  const deck = shuffle(createDecks(opts.deckCount, mode === 'doudizhu' ? true : opts.withJokers));
  const reserve = mode === 'doudizhu' ? bottomCount(seats.length) : 0;
  const perPlayer = Math.floor((deck.length - reserve) / seats.length);
  const hands: Record<string, Card[]> = {};
  seats.forEach((s) => (hands[s.id] = []));
  // 轮流发牌
  for (let i = 0; i < perPlayer * seats.length; i++) {
    hands[seats[i % seats.length].id].push(deck[i]);
  }
  for (const s of seats) hands[s.id] = sortByRank(hands[s.id]);
  const leftover = sortByRank(deck.slice(perPlayer * seats.length));

  let turn = seats.findIndex((s) => s.id === opts.previousWinnerId);
  if (turn < 0) {
    if (mode === 'doudizhu') {
      turn = Math.floor(Math.random() * seats.length);
    } else {
      // 第一局：持有最小牌的玩家先出
      let best: Card | null = null;
      seats.forEach((s, i) => {
        const c = hands[s.id][0];
        if (c && (!best || compareCards(c, best) < 0)) {
          best = c;
          turn = i;
        }
      });
    }
  }

  return {
    mode,
    round: opts.round,
    phase: mode === 'doudizhu' ? 'bidding' : 'playing',
    seats,
    hands,
    leftover,
    turn: Math.max(0, turn),
    lastPlay: null,
    seatActions: {},
    passCount: 0,
    bombs: 0,
    log: [],
    bidding: mode === 'doudizhu' ? { candidate: null, calls: {}, count: 0, allPassed: false } : null,
    landlordSeat: null,
    finishOrder: [],
    winnerSeat: null,
    winners: null,
    settlement: null,
    startedAt: now,
    turnStartedAt: now,
  };
}

export function seatIndexOf(state: GameState, playerId: string): number {
  return state.seats.findIndex((s) => s.id === playerId);
}

export function isOut(state: Pick<GameState, 'finishOrder'>, seat: number): boolean {
  return state.finishOrder.includes(seat);
}

/** 下一个还在牌局中的座位 */
export function nextSeat(state: GameState, seat: number): number {
  const n = state.seats.length;
  for (let k = 1; k <= n; k++) {
    const s = (seat + k) % n;
    if (!isOut(state, s)) return s;
  }
  return seat;
}

/** 当前出牌者是否为领出（可以出任意牌型、不能过牌） */
export function isLeading(state: GameState): boolean {
  return state.lastPlay === null;
}

/** 两个座位是否为同一阵营（斗地主中的农民之间） */
export function isTeammate(state: Pick<GameState, 'mode' | 'landlordSeat'>, a: number, b: number): boolean {
  if (a === b) return true;
  if (state.mode !== 'doudizhu' || state.landlordSeat === null) return false;
  return a !== state.landlordSeat && b !== state.landlordSeat;
}

// ---------------------------------------------------------------- 叫地主

export function placeBid(state: GameState, playerId: string, call: boolean, now = Date.now()): GameState {
  if (state.phase !== 'bidding' || !state.bidding) throw new GameError('当前不是叫地主阶段');
  const seat = seatIndexOf(state, playerId);
  if (seat !== state.turn) throw new GameError('还没轮到你');
  if (now < state.turnStartedAt) throw new GameError('正在发牌，请稍候');
  const b = state.bidding;
  const grab = b.candidate !== null;

  const bidding: BiddingState = {
    ...b,
    calls: { ...b.calls, [seat]: call },
    count: b.count + 1,
    candidate: call ? seat : b.candidate,
  };
  const next: GameState = {
    ...state,
    bidding,
    seatActions: { ...state.seatActions, [seat]: { kind: 'bid', called: call, grab, at: now } },
    turnStartedAt: now,
  };

  if (bidding.count >= state.seats.length) {
    if (bidding.candidate === null) return { ...next, bidding: { ...bidding, allPassed: true } };
    return assignLandlord(next, bidding.candidate, now);
  }
  next.turn = (seat + 1) % state.seats.length;
  return next;
}

function assignLandlord(state: GameState, seat: number, now: number): GameState {
  const id = state.seats[seat].id;
  return {
    ...state,
    phase: 'playing',
    landlordSeat: seat,
    hands: { ...state.hands, [id]: sortByRank([...state.hands[id], ...state.leftover]) },
    turn: seat,
    seatActions: {},
    turnStartedAt: now,
  };
}

// ---------------------------------------------------------------- 出牌

export function playCards(state: GameState, playerId: string, cardIds: string[], now = Date.now()): GameState {
  if (state.phase === 'bidding') throw new GameError('正在叫地主');
  if (state.phase !== 'playing') throw new GameError('本局已结束');
  const seat = seatIndexOf(state, playerId);
  if (seat !== state.turn) throw new GameError('还没轮到你出牌');
  if (now < state.turnStartedAt) throw new GameError('正在发牌，请稍候');
  if (!cardIds.length) throw new GameError('请选择要出的牌');

  const hand = state.hands[playerId];
  const idSet = new Set(cardIds);
  const cards = hand.filter((c) => idSet.has(c.id));
  if (cards.length !== idSet.size) throw new GameError('所选的牌不在手牌中');

  const pattern = resolvePlay(cards, state.lastPlay?.pattern ?? null, state.mode);
  if (!pattern) {
    throw new GameError(state.lastPlay ? '出牌必须是同牌型且更大，或使用炸弹' : '不是合法的牌型');
  }

  const rest = hand.filter((c) => !idSet.has(c.id));
  const sorted = sortByRank(cards);
  const next: GameState = {
    ...state,
    hands: { ...state.hands, [playerId]: rest },
    lastPlay: { seat, cards: sorted, pattern },
    seatActions: { ...state.seatActions, [seat]: { kind: 'play', cards: sorted, pattern, at: now } },
    passCount: 0,
    bombs: state.bombs + (isBombLike(pattern) ? 1 : 0),
    log: [...state.log, { seat, action: 'play', cards: sorted, pattern, at: now }],
    turnStartedAt: now,
  };

  if (rest.length === 0) {
    next.finishOrder = [...state.finishOrder, seat];
    if (next.winnerSeat === null) next.winnerSeat = seat;
    // 斗地主一方出完即结束；跑得快只剩一人时结束
    const active = state.seats.length - next.finishOrder.length;
    if (state.mode === 'doudizhu' || active <= 1) return finishGame(next);
  }

  next.turn = nextSeat(next, seat);
  // 轮到的下家清掉上一轮的展示
  next.seatActions = { ...next.seatActions, [next.turn]: undefined };
  return next;
}

export function passTurn(state: GameState, playerId: string, now = Date.now()): GameState {
  if (state.phase !== 'playing') throw new GameError(state.phase === 'bidding' ? '正在叫地主' : '本局已结束');
  const seat = seatIndexOf(state, playerId);
  if (seat !== state.turn) throw new GameError('还没轮到你');
  if (!state.lastPlay) throw new GameError('你是本轮首个出牌者，不能过牌');

  const passCount = state.passCount + 1;
  const next: GameState = {
    ...state,
    passCount,
    seatActions: { ...state.seatActions, [seat]: { kind: 'pass', at: now } },
    log: [...state.log, { seat, action: 'pass', at: now }],
    turnStartedAt: now,
  };

  // 需要表态的人数：除最后出牌者外、仍在牌局中的玩家
  const owner = state.lastPlay.seat;
  const responders = state.seats.filter((_, i) => i !== owner && !isOut(state, i)).length;
  if (passCount >= responders) {
    // 其他人都过了，最后出牌的人重新领出；若其已出完，则由其下家接风
    next.turn = isOut(state, owner) ? nextSeat(state, owner) : owner;
    next.lastPlay = null;
    next.passCount = 0;
    next.seatActions = {};
  } else {
    next.turn = nextSeat(state, seat);
    next.seatActions = { ...next.seatActions, [next.turn]: undefined };
  }
  return next;
}

// ---------------------------------------------------------------- 名次

function finishGame(state: GameState): GameState {
  const n = state.seats.length;
  let winners: number[];
  const rankOf: Record<number, number> = {};

  if (state.mode === 'doudizhu') {
    const landlord = state.landlordSeat!;
    const farmers = state.seats.map((_, i) => i).filter((i) => i !== landlord);
    winners = state.winnerSeat === landlord ? [landlord] : farmers;
    winners.forEach((w) => (rankOf[w] = 1));
    // 失败一方按剩余牌数排名
    const losers = state.seats
      .map((_, i) => i)
      .filter((i) => !winners.includes(i))
      .sort((a, b) => state.hands[state.seats[a].id].length - state.hands[state.seats[b].id].length);
    let r = 2;
    losers.forEach((l) => (rankOf[l] = r++));
  } else {
    winners = [state.finishOrder[0]];
    state.finishOrder.forEach((s, i) => (rankOf[s] = i + 1));
    // 最后剩下的玩家
    for (let i = 0; i < n; i++) if (rankOf[i] === undefined) rankOf[i] = n;
  }

  const rows: Settlement[] = state.seats.map((s, i) => ({
    playerId: s.id,
    name: s.name,
    remaining: state.hands[s.id].length,
    rank: rankOf[i],
    role: state.mode === 'doudizhu' ? (i === state.landlordSeat ? 'landlord' : 'farmer') : undefined,
  }));
  rows.sort((a, b) => a.rank - b.rank || a.remaining - b.remaining);
  return { ...state, phase: 'finished', winners, settlement: rows, turn: state.winnerSeat ?? state.turn };
}

// ---------------------------------------------------------------- 视图

/** 生成某个玩家视角下的游戏状态：只能看到自己的手牌，其他人只有张数 */
export interface GameView extends Omit<GameState, 'hands' | 'leftover'> {
  myHand: Card[];
  handCounts: Record<string, number>;
  /** 结束后公开所有人手牌 */
  revealedHands: Record<string, Card[]> | null;
  leftoverCount: number;
  /** 跑得快在结束后公开；斗地主在叫完地主后公开底牌 */
  leftover: Card[] | null;
}

export function viewFor(state: GameState, playerId: string | null): GameView {
  const { hands, leftover, ...rest } = state;
  const handCounts: Record<string, number> = {};
  for (const s of state.seats) handCounts[s.id] = hands[s.id].length;
  const finished = state.phase === 'finished';
  const showBottom = finished || (state.mode === 'doudizhu' && state.phase !== 'bidding');
  return {
    ...rest,
    myHand: playerId ? hands[playerId] ?? [] : [],
    handCounts,
    revealedHands: finished ? hands : null,
    leftoverCount: leftover.length,
    leftover: showBottom ? leftover : null,
  };
}
