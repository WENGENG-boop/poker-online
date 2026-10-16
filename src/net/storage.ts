// 本地存储：模拟服务器端的房间表与会话（localStorage 在同一浏览器的所有标签页共享）

import type { RoomSummary } from './protocol';
import type { RoomSnapshot } from './roomServer';

const ROOMS_KEY = 'poker.rooms';
const SNAPSHOT_PREFIX = 'poker.snapshot.';
const SESSION_KEY = 'poker.session';
const PROFILE_KEY = 'poker.profile';

/** 房主超过该时间未刷新房间概要，视为离线 */
export const HOST_STALE_MS = 7000;
const EXPIRE_MS = 6 * 3600 * 1000;

function readJSON<T>(storage: Storage | undefined, key: string): T | null {
  try {
    const raw = storage?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJSON(storage: Storage | undefined, key: string, value: unknown) {
  try {
    if (value === null) storage?.removeItem(key);
    else storage?.setItem(key, JSON.stringify(value));
  } catch {
    /* 存储不可用时忽略 */
  }
}

const local = typeof localStorage !== 'undefined' ? localStorage : undefined;
const session = typeof sessionStorage !== 'undefined' ? sessionStorage : undefined;

export const registry = {
  all(): Record<string, RoomSummary> {
    const rooms = readJSON<Record<string, RoomSummary>>(local, ROOMS_KEY) ?? {};
    const now = Date.now();
    for (const [code, r] of Object.entries(rooms)) {
      if (now - r.updatedAt > EXPIRE_MS) delete rooms[code];
    }
    return rooms;
  },
  get(code: string): RoomSummary | null {
    return this.all()[code] ?? null;
  },
  put(summary: RoomSummary) {
    const rooms = this.all();
    rooms[summary.code] = summary;
    writeJSON(local, ROOMS_KEY, rooms);
  },
  remove(code: string) {
    const rooms = this.all();
    delete rooms[code];
    writeJSON(local, ROOMS_KEY, rooms);
  },
  isHostAlive(summary: RoomSummary): boolean {
    return Date.now() - summary.updatedAt < HOST_STALE_MS;
  },
};

export function saveSnapshot(snap: RoomSnapshot) {
  writeJSON(local, SNAPSHOT_PREFIX + snap.room.code, snap);
}

export function loadSnapshot(code: string): RoomSnapshot | null {
  return readJSON<RoomSnapshot>(local, SNAPSHOT_PREFIX + code);
}

export function removeSnapshot(code: string) {
  writeJSON(local, SNAPSHOT_PREFIX + code, null);
}

/** 当前标签页的会话（刷新后用于自动重连） */
export interface Session {
  code: string;
  playerId: string;
  name: string;
  role: 'host' | 'guest';
  /** 真实后端模式下的鉴权令牌 */
  token?: string;
}

export const sessionStore = {
  get: () => readJSON<Session>(session, SESSION_KEY),
  set: (s: Session | null) => writeJSON(session, SESSION_KEY, s),
};

export const profileStore = {
  getName: () => readJSON<{ name: string }>(local, PROFILE_KEY)?.name ?? '',
  setName: (name: string) => writeJSON(local, PROFILE_KEY, { name }),
};
