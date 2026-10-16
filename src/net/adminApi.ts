// 后台管理 API：登录、房间监控、历史记录。
//
// 本地模拟模式：密码以 SHA-256 哈希与配置值比对，会话保存在当前标签页。
//   修改密码：npm run admin-hash -- 新密码，把输出写入 .env.local 的 VITE_ADMIN_PASSWORD_HASH。
//   注意：纯前端校验只能挡住普通访问，任何能拿到页面代码的人都可以绕过；
//   正式上线必须改用后端校验（RemoteAdminApi），历史记录也只存在服务器上。
//
// 后端接口（建议）：
//   POST   /admin/login          { password } -> { token }
//   GET    /admin/rooms          -> RoomSummary[]
//   GET    /admin/history        -> GameRecord[]
//   DELETE /admin/history/:id
//   DELETE /admin/history

import { GameRecord, adminHistoryStore } from './adminHistory';
import type { RoomSummary } from './protocol';
import { registry, removeSnapshot } from './storage';

export interface AdminApi {
  readonly mode: 'mock' | 'remote';
  isAuthed(): boolean;
  login(password: string): Promise<void>;
  logout(): void;
  listRooms(): Promise<RoomSummary[]>;
  purgeRoom(code: string): Promise<void>;
  listHistory(): Promise<GameRecord[]>;
  removeHistory(id: string): Promise<void>;
  clearHistory(): Promise<void>;
}

const env = import.meta.env as Record<string, string | undefined>;
/** 默认密码 admin888 的哈希 */
const DEFAULT_HASH = '611d7d6ad784bef363e5cf86165a1f2568fdfb476cdb7e5c7e0a5128e3b8da55';
const PASSWORD_HASH = (env.VITE_ADMIN_PASSWORD_HASH || DEFAULT_HASH).toLowerCase();
export const USING_DEFAULT_PASSWORD = !env.VITE_ADMIN_PASSWORD_HASH;

const SESSION_KEY = 'poker.admin.session';
const LOCK_KEY = 'poker.admin.lock';
const SESSION_MS = 2 * 3600 * 1000;
const MAX_FAILS = 5;
const LOCK_MS = 60 * 1000;

async function sha256(text: string): Promise<string> {
  if (!crypto?.subtle) throw new Error('当前环境不支持安全校验，请通过 https 或 localhost 访问');
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function readLock(): { fails: number; until: number } {
  try {
    return JSON.parse(localStorage.getItem(LOCK_KEY) ?? '') as { fails: number; until: number };
  } catch {
    return { fails: 0, until: 0 };
  }
}
function writeLock(v: { fails: number; until: number }) {
  try {
    localStorage.setItem(LOCK_KEY, JSON.stringify(v));
  } catch {
    /* 忽略 */
  }
}

class MockAdminApi implements AdminApi {
  readonly mode = 'mock' as const;

  isAuthed() {
    try {
      const s = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? 'null') as { exp: number; h: string } | null;
      return !!s && s.exp > Date.now() && s.h === PASSWORD_HASH.slice(0, 12);
    } catch {
      return false;
    }
  }

  async login(password: string) {
    const lock = readLock();
    if (lock.until > Date.now()) throw new Error(`尝试次数过多，请 ${Math.ceil((lock.until - Date.now()) / 1000)} 秒后再试`);
    const hash = await sha256('poker-admin:' + password);
    if (hash !== PASSWORD_HASH) {
      const fails = lock.fails + 1;
      writeLock(fails >= MAX_FAILS ? { fails: 0, until: Date.now() + LOCK_MS } : { fails, until: 0 });
      throw new Error(fails >= MAX_FAILS ? '密码错误次数过多，已锁定 60 秒' : `密码错误（还可尝试 ${MAX_FAILS - fails} 次）`);
    }
    writeLock({ fails: 0, until: 0 });
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ exp: Date.now() + SESSION_MS, h: PASSWORD_HASH.slice(0, 12) }));
  }

  logout() {
    sessionStorage.removeItem(SESSION_KEY);
  }

  private guard() {
    if (!this.isAuthed()) throw new Error('请先登录后台');
  }

  async listRooms() {
    this.guard();
    return Object.values(registry.all()).sort((a, b) => b.createdAt - a.createdAt);
  }
  async purgeRoom(code: string) {
    this.guard();
    registry.remove(code);
    removeSnapshot(code);
  }
  async listHistory() {
    this.guard();
    return adminHistoryStore.all();
  }
  async removeHistory(id: string) {
    this.guard();
    adminHistoryStore.remove(id);
  }
  async clearHistory() {
    this.guard();
    adminHistoryStore.clear();
  }
}

class RemoteAdminApi implements AdminApi {
  readonly mode = 'remote' as const;
  private token: string | null = sessionStorage.getItem(SESSION_KEY);
  constructor(private apiUrl: string) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.apiUrl + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && path !== '/admin/login') {
      this.logout();
      throw new Error('登录已过期，请重新登录');
    }
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error || `请求失败 (${res.status})`);
    }
    return (res.status === 204 ? undefined : res.json()) as Promise<T>;
  }

  isAuthed() {
    return !!this.token;
  }
  async login(password: string) {
    const r = await this.req<{ token: string }>('POST', '/admin/login', { password });
    this.token = r.token;
    sessionStorage.setItem(SESSION_KEY, r.token);
  }
  logout() {
    if (this.token) void fetch(this.apiUrl + '/admin/logout', { method: 'POST', headers: { Authorization: `Bearer ${this.token}` } }).catch(() => {});
    this.token = null;
    sessionStorage.removeItem(SESSION_KEY);
  }
  listRooms() {
    return this.req<RoomSummary[]>('GET', '/admin/rooms');
  }
  purgeRoom(code: string) {
    return this.req<void>('DELETE', `/admin/rooms/${code}`);
  }
  listHistory() {
    return this.req<GameRecord[]>('GET', '/admin/history');
  }
  removeHistory(id: string) {
    return this.req<void>('DELETE', `/admin/history/${encodeURIComponent(id)}`);
  }
  clearHistory() {
    return this.req<void>('DELETE', '/admin/history');
  }
}

export const adminApi: AdminApi = env.VITE_API_URL ? new RemoteAdminApi(env.VITE_API_URL) : new MockAdminApi();
