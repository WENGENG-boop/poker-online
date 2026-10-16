// 数据持久化：使用 Node.js 内置 SQLite（node:sqlite），无需编译原生模块。
//  - meta        ：服务器密钥等配置
//  - rooms       ：房间快照，服务器重启后可恢复进行中的房间
//  - history     ：每局完整记录（后台历史与复盘）
//  - moderation  ：被拦截的聊天记录

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { GameRecord } from '../src/net/adminHistory';
import type { ModerationEntry } from '../src/net/protocol';
import type { RoomSnapshot } from '../src/net/roomServer';

export class Store {
  private db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, snapshot TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS history (
        id TEXT PRIMARY KEY,
        room_code TEXT NOT NULL,
        mode TEXT NOT NULL,
        ended_at INTEGER NOT NULL,
        players TEXT NOT NULL,
        record TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS history_ended ON history (ended_at DESC);
      CREATE TABLE IF NOT EXISTS moderation (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_code TEXT NOT NULL,
        player_id TEXT NOT NULL,
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        reason TEXT NOT NULL,
        at INTEGER NOT NULL
      );
    `);
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string) {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  // ---------------------------------------------------------------- 房间快照

  saveRoom(snap: RoomSnapshot) {
    this.db
      .prepare('INSERT INTO rooms (code, snapshot, updated_at) VALUES (?, ?, ?) ON CONFLICT(code) DO UPDATE SET snapshot = excluded.snapshot, updated_at = excluded.updated_at')
      .run(snap.room.code, JSON.stringify(snap), Date.now());
  }

  deleteRoom(code: string) {
    this.db.prepare('DELETE FROM rooms WHERE code = ?').run(code);
  }

  loadRooms(maxAgeMs: number): RoomSnapshot[] {
    this.db.prepare('DELETE FROM rooms WHERE updated_at < ?').run(Date.now() - maxAgeMs);
    const rows = this.db.prepare('SELECT snapshot FROM rooms').all() as Array<{ snapshot: string }>;
    return rows.map((r) => JSON.parse(r.snapshot) as RoomSnapshot);
  }

  // ---------------------------------------------------------------- 历史记录

  addHistory(record: GameRecord) {
    this.db
      .prepare('INSERT OR REPLACE INTO history (id, room_code, mode, ended_at, players, record) VALUES (?, ?, ?, ?, ?, ?)')
      .run(record.id, record.roomCode, record.mode, record.endedAt, record.players.map((p) => p.name).join(' '), JSON.stringify(record));
  }

  listHistory(limit = 500): GameRecord[] {
    const rows = this.db.prepare('SELECT record FROM history ORDER BY ended_at DESC LIMIT ?').all(limit) as Array<{ record: string }>;
    return rows.map((r) => JSON.parse(r.record) as GameRecord);
  }

  deleteHistory(id: string) {
    this.db.prepare('DELETE FROM history WHERE id = ?').run(id);
  }

  clearHistory() {
    this.db.exec('DELETE FROM history');
  }

  // ---------------------------------------------------------------- 审核记录

  addModeration(roomCode: string, entry: ModerationEntry) {
    this.db
      .prepare('INSERT INTO moderation (room_code, player_id, name, content, reason, at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(roomCode, entry.playerId, entry.name, entry.content, entry.reason, entry.at);
  }

  close() {
    this.db.close();
  }
}
