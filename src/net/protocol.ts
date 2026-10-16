// 客户端 ⇄ 服务器 通信协议。
// 当前阶段由浏览器内的 RoomServer 实现（房主标签页充当服务器），
// 以后接入真正的 WebSocket 服务器时，消息格式保持不变即可。

import type { AILevel } from '../game/ai';
import type { GameView } from '../game/engine';
import type { GameMode } from '../game/rules';

export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 8;
export const MIN_CARDS_PER_PLAYER = 5;
/** 开局时洗牌、发牌动画的时长；在此之前不允许出牌，AI 也不会行动 */
export const DEAL_ANIMATION_MS = 8400;
/** 斗地主翻底牌动画时长 */
export const LANDLORD_REVEAL_MS = 2200;

export interface RoomConfig {
  mode: GameMode;
  aiLevel: AILevel;
  /** 座位数（参与牌局的总人数，含 AI） */
  seatCount: number;
  /** 根据真人数量自动调整座位数 */
  autoSeats: boolean;
  deckCount: number;
  /** 房主手动修改过牌副数后不再自动推荐 */
  deckManual: boolean;
  withJokers: boolean;
  /** 每回合思考时间（秒），0 表示不限时 */
  turnSeconds: number;
  /** 聊天：full 短语+表情+审核后的短文字；preset 仅短语和表情；off 关闭 */
  chat: ChatPolicy;
}

export type ChatPolicy = 'full' | 'preset' | 'off';

export interface ChatMessage {
  id: string;
  playerId: string;
  name: string;
  kind: 'phrase' | 'emoji' | 'text';
  content: string;
  at: number;
}

/** 被拦截的聊天（仅后台可见） */
export interface ModerationEntry {
  playerId: string;
  name: string;
  content: string;
  reason: string;
  at: number;
}

export type PlayerKind = 'human' | 'simulated' | 'ai';

export interface RoomPlayer {
  id: string;
  name: string;
  kind: PlayerKind;
  isHost: boolean;
  online: boolean;
  ready: boolean;
  /** 托管：由 AI 代打 */
  autoPlay: boolean;
  joinedAt: number;
  lastSeen: number;
  /** 网络延迟（ms），模拟显示 */
  latency: number;
}

export type RoomStatus = 'waiting' | 'playing' | 'finished';

export interface RoomState {
  code: string;
  hostId: string;
  createdAt: number;
  config: RoomConfig;
  /** 所有玩家，按座位顺序排列；AI 只在开局时加入 */
  players: RoomPlayer[];
  status: RoomStatus;
  round: number;
  lastWinnerId: string | null;
  /** 最近的聊天消息 */
  chat: ChatMessage[];
}

export interface ServerView {
  room: RoomState;
  game: GameView | null;
  you: string;
  serverTime: number;
  /** 状态版本号，内容没变时（如心跳回包）客户端可跳过渲染 */
  version: number;
}

export type ClientMessage =
  | { type: 'join'; name: string }
  | { type: 'leave' }
  | { type: 'heartbeat'; sentAt: number }
  | { type: 'ready'; ready: boolean }
  | { type: 'config'; patch: Partial<RoomConfig> }
  | { type: 'addSimulated' }
  | { type: 'kick'; targetId: string }
  | { type: 'start' }
  | { type: 'play'; cardIds: string[] }
  | { type: 'pass' }
  | { type: 'chat'; kind: ChatMessage['kind']; content: string }
  /** 斗地主：true 叫地主/抢地主，false 不叫/不抢 */
  | { type: 'bid'; call: boolean }
  | { type: 'autoPlay'; on: boolean }
  | { type: 'nextRound' }
  | { type: 'backToLobby' };

export type ServerMessage =
  | { type: 'state'; view: ServerView }
  | { type: 'error'; message: string }
  | { type: 'joined'; playerId: string; code: string }
  | { type: 'kicked'; reason: string }
  | { type: 'closed'; reason: string };

/** 房间概要（供大厅、后台管理使用） */
export interface RoomSummary {
  code: string;
  hostName: string;
  mode: GameMode;
  status: RoomStatus;
  round: number;
  seatCount: number;
  deckCount: number;
  withJokers: boolean;
  createdAt: number;
  updatedAt: number;
  players: Array<Pick<RoomPlayer, 'id' | 'name' | 'kind' | 'isHost' | 'online' | 'ready' | 'autoPlay' | 'latency'> & { cards: number | null }>;
  turnPlayer: string | null;
  totalPlays: number;
  chat: ChatMessage[];
  moderation: ModerationEntry[];
}

export function defaultConfig(): RoomConfig {
  return { mode: 'paodekuai', aiLevel: 'normal', seatCount: 3, autoSeats: true, deckCount: 1, deckManual: false, withJokers: true, turnSeconds: 30, chat: 'full' };
}
