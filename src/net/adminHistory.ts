// 后台历史记录：由房间服务器在每局结束时写入，仅后台管理页可读取。
// 本地模拟模式下存放在 localStorage；接入真实后端后由服务器数据库保存（见 remote.ts）。

import type { Card } from '../game/cards';
import type { GameState, LogEntry, Settlement } from '../game/engine';
import type { GameMode } from '../game/rules';
import type { PlayerKind, RoomState } from './protocol';

export interface GameRecord {
  id: string;
  roomCode: string;
  mode: GameMode;
  round: number;
  startedAt: number;
  endedAt: number;
  deckCount: number;
  withJokers: boolean;
  players: Array<{ id: string; name: string; kind: PlayerKind }>;
  winnerSeat: number;
  winners: number[];
  /** 出完牌的先后顺序（座位） */
  finishOrder: number[];
  landlordSeat: number | null;
  bombs: number;
  settlement: Settlement[];
  /** 出牌阶段开始时每位玩家的手牌（斗地主地主含底牌） */
  initialHands: Record<string, Card[]>;
  /** 斗地主底牌 / 跑得快未发的余牌 */
  bottom: Card[];
  /** 斗地主叫地主表态 */
  calls: Record<number, boolean> | null;
  log: LogEntry[];
}

const KEY = 'poker.admin.history';
/** 本地模拟模式下 localStorage 容量有限（约 5MB），只保留最近 40 局；真实后端无此限制 */
const MAX_RECORDS = 40;

export function buildRecord(room: RoomState, g: GameState): GameRecord {
  const initialHands: Record<string, Card[]> = {};
  for (const s of g.seats) initialHands[s.id] = [...g.hands[s.id]];
  for (const l of g.log) if (l.action === 'play') initialHands[g.seats[l.seat].id].push(...l.cards!);
  return {
    id: `${room.code}-${g.round}-${g.startedAt}`,
    roomCode: room.code,
    mode: g.mode,
    round: g.round,
    startedAt: g.startedAt,
    endedAt: g.log[g.log.length - 1]?.at ?? Date.now(),
    deckCount: room.config.deckCount,
    withJokers: g.mode === 'doudizhu' ? true : room.config.withJokers,
    players: g.seats.map((s) => ({ id: s.id, name: s.name, kind: room.players.find((p) => p.id === s.id)?.kind ?? (s.isAI ? 'ai' : 'human') })),
    winnerSeat: g.winnerSeat!,
    winners: g.winners ?? [g.winnerSeat!],
    finishOrder: g.finishOrder,
    landlordSeat: g.landlordSeat,
    bombs: g.bombs,
    settlement: g.settlement!,
    initialHands,
    bottom: g.leftover,
    calls: g.bidding?.calls ?? null,
    log: g.log,
  };
}

function read(): GameRecord[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as GameRecord[];
  } catch {
    return [];
  }
}

function write(records: GameRecord[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(records));
  } catch {
    // 空间不足：只保留一半，最多重试一次
    try {
      localStorage.setItem(KEY, JSON.stringify(records.slice(0, Math.floor(records.length / 2))));
    } catch {
      /* 存储不可用 */
    }
  }
}

export const adminHistoryStore = {
  all: read,
  save(record: GameRecord) {
    write([record, ...read().filter((r) => r.id !== record.id)].slice(0, MAX_RECORDS));
  },
  remove(id: string) {
    write(read().filter((r) => r.id !== id));
  },
  clear() {
    write([]);
  },
};
