// 客户端消息校验：服务器不信任任何客户端输入，类型或范围不对的消息直接丢弃

import type { ChatMessage, ClientMessage, RoomConfig } from '../src/net/protocol';

const isStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isInt = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

/** 只保留已知字段且类型正确的配置 */
export function sanitizeConfig(raw: unknown): Partial<RoomConfig> {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const out: Partial<RoomConfig> = {};
  if (r.mode === 'paodekuai' || r.mode === 'doudizhu') out.mode = r.mode;
  if (r.aiLevel === 'easy' || r.aiLevel === 'normal' || r.aiLevel === 'hard') out.aiLevel = r.aiLevel;
  if (isInt(r.seatCount, 3, 8)) out.seatCount = r.seatCount;
  if (isBool(r.autoSeats)) out.autoSeats = r.autoSeats;
  if (isInt(r.deckCount, 1, 8)) out.deckCount = r.deckCount;
  if (isBool(r.deckManual)) out.deckManual = r.deckManual;
  if (isBool(r.withJokers)) out.withJokers = r.withJokers;
  if (isInt(r.turnSeconds, 0, 120)) out.turnSeconds = r.turnSeconds;
  if (r.chat === 'full' || r.chat === 'preset' || r.chat === 'off') out.chat = r.chat;
  return out;
}

const CHAT_KINDS: ChatMessage['kind'][] = ['phrase', 'emoji', 'text'];

export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case 'join':
      return isStr(m.name, 40) ? { type: 'join', name: m.name } : null;
    case 'leave':
    case 'addSimulated':
    case 'start':
    case 'pass':
    case 'nextRound':
    case 'backToLobby':
      return { type: m.type };
    case 'heartbeat':
      return { type: 'heartbeat', sentAt: typeof m.sentAt === 'number' && Number.isFinite(m.sentAt) ? m.sentAt : Date.now() };
    case 'ready':
      return isBool(m.ready) ? { type: 'ready', ready: m.ready } : null;
    case 'autoPlay':
      return isBool(m.on) ? { type: 'autoPlay', on: m.on } : null;
    case 'bid':
      return isBool(m.call) ? { type: 'bid', call: m.call } : null;
    case 'config': {
      const patch = sanitizeConfig(m.patch);
      return Object.keys(patch).length ? { type: 'config', patch } : null;
    }
    case 'kick':
      return isStr(m.targetId, 64) ? { type: 'kick', targetId: m.targetId } : null;
    case 'play':
      return Array.isArray(m.cardIds) && m.cardIds.length > 0 && m.cardIds.length <= 60 && m.cardIds.every((id) => isStr(id, 32))
        ? { type: 'play', cardIds: m.cardIds as string[] }
        : null;
    case 'chat':
      return CHAT_KINDS.includes(m.kind as ChatMessage['kind']) && isStr(m.content, 40)
        ? { type: 'chat', kind: m.kind as ChatMessage['kind'], content: m.content }
        : null;
    default:
      return null;
  }
}

export function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.normalize('NFKC').replace(/[\u0000-\u001f\u007f​-‏⁠﻿]/g, '').trim().slice(0, 12);
  return name || null;
}
