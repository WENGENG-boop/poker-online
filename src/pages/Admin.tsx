// 后台管理（/admin，需要密码）：房间监控、聊天与拦截记录、历史对局与复盘

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { Avatar, KindTag, Modal, StatusDot } from '../components/common';
import { Replay } from '../components/Replay';
import { rankLabel } from '../components/Seat';
import { GameMode, MODE_LABEL } from '../game/rules';
import { USING_DEFAULT_PASSWORD, adminApi } from '../net/adminApi';
import type { GameRecord } from '../net/adminHistory';
import type { RoomSummary } from '../net/protocol';
import { registry } from '../net/storage';

const STATUS_LABEL = { waiting: '等待中', playing: '游戏中', finished: '已结束' } as const;

function ago(ts: number) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  return `${Math.round(s / 86400)} 天前`;
}

function formatTime(ts: number) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

function duration(ms: number) {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

export function Admin() {
  const [authed, setAuthed] = useState(() => adminApi.isAuthed());
  if (!authed) return <AdminLogin onSuccess={() => setAuthed(true)} />;
  return (
    <AdminConsole
      onLogout={() => {
        adminApi.logout();
        setAuthed(false);
      }}
    />
  );
}

function AdminLogin({ onSuccess }: { onSuccess(): void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await adminApi.login(password);
      onSuccess();
    } catch (err) {
      setError((err as Error).message);
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center-screen admin-login">
      <form className="panel admin-login__panel" onSubmit={submit}>
        <div className="admin-login__icon">🔒</div>
        <h1>后台管理</h1>
        <p className="muted small">请输入管理员密码</p>
        <input type="password" value={password} autoFocus autoComplete="current-password" placeholder="密码" onChange={(e) => setPassword(e.target.value)} />
        {error && <div className="admin-login__error">{error}</div>}
        <button className="btn btn--primary btn--block" disabled={busy || !password}>
          {busy ? '验证中…' : '登录'}
        </button>
      </form>
    </div>
  );
}

function AdminConsole({ onLogout }: { onLogout(): void }) {
  const [tab, setTab] = useState<'rooms' | 'history'>('rooms');
  return (
    <div className="admin">
      <header className="topbar">
        <span className="topbar__title">后台管理</span>
        <div className="segmented admin__tabs">
          <button className={tab === 'rooms' ? 'is-active' : ''} onClick={() => setTab('rooms')}>
            房间监控
          </button>
          <button className={tab === 'history' ? 'is-active' : ''} onClick={() => setTab('history')}>
            历史记录
          </button>
        </div>
        <button className="btn btn--text" onClick={onLogout}>
          退出
        </button>
      </header>
      {adminApi.mode === 'mock' && USING_DEFAULT_PASSWORD && (
        <div className="admin__warn small">
          当前使用默认密码。上线前请运行 <code>npm run admin-hash -- 新密码</code>，并把结果写入 <code>.env.local</code> 的 <code>VITE_ADMIN_PASSWORD_HASH</code>。
        </div>
      )}
      {tab === 'rooms' ? <RoomsTab /> : <HistoryTab />}
    </div>
  );
}

// ---------------------------------------------------------------- 房间监控

function RoomsTab() {
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'live' | 'playing'>('all');

  useEffect(() => {
    const load = () => adminApi.listRooms().then(setRooms).catch(() => {});
    load();
    const t = setInterval(load, 1000);
    window.addEventListener('storage', load);
    return () => {
      clearInterval(t);
      window.removeEventListener('storage', load);
    };
  }, []);

  const live = rooms.filter((r) => registry.isHostAlive(r));
  const shown = rooms.filter((r) => (filter === 'all' ? true : filter === 'live' ? registry.isHostAlive(r) : r.status === 'playing'));
  const onlinePlayers = live.reduce((s, r) => s + r.players.filter((p) => p.kind !== 'ai' && p.online).length, 0);
  const blocked = rooms.reduce((s, r) => s + (r.moderation?.length ?? 0), 0);

  return (
    <>
      <div className="stats">
        <Stat value={rooms.length} label="房间总数" />
        <Stat value={live.length} label="房主在线" />
        <Stat value={onlinePlayers} label="在线玩家" />
        <Stat value={blocked} label="拦截消息" tone={blocked ? 'warn' : undefined} />
      </div>

      <div className="segmented admin__filter">
        {(['all', 'live', 'playing'] as const).map((f) => (
          <button key={f} className={filter === f ? 'is-active' : ''} onClick={() => setFilter(f)}>
            {{ all: '全部', live: '在线', playing: '游戏中' }[f]}
          </button>
        ))}
      </div>

      {shown.length === 0 && <div className="panel muted center">暂无房间</div>}

      <div className="admin__list">
        {shown.map((r) => {
          const alive = registry.isHostAlive(r);
          const humans = r.players.filter((p) => p.kind !== 'ai');
          const expanded = open === r.code;
          return (
            <div key={r.code} className={`panel room-card ${alive ? '' : 'is-stale'}`}>
              <button className="room-card__head" onClick={() => setOpen(expanded ? null : r.code)}>
                <span className="room-card__code">{r.code}</span>
                <span className="badge badge--mode">{MODE_LABEL[r.mode ?? 'paodekuai']}</span>
                <span className={`badge badge--${r.status}`}>{STATUS_LABEL[r.status]}</span>
                {r.moderation?.length > 0 && <span className="badge badge--warn">拦截 {r.moderation.length}</span>}
                <span className="muted small room-card__meta">
                  房主 {r.hostName} · {humans.length} 人 / {r.seatCount} 座 · {r.deckCount} 副牌
                  {r.round > 0 && ` · 第 ${r.round} 局`}
                </span>
                <span className="room-card__conn small">
                  <StatusDot online={alive} /> {alive ? '连接正常' : `房主离线（${ago(r.updatedAt)}）`}
                </span>
              </button>
              {expanded && (
                <div className="room-card__body">
                  <div className="muted small">
                    创建于 {new Date(r.createdAt).toLocaleString()} · 最后同步 {ago(r.updatedAt)}
                    {r.status === 'playing' && ` · 已出牌 ${r.totalPlays} 手 · 当前：${r.turnPlayer ?? '-'}`}
                  </div>
                  <table className="admin__table">
                    <thead>
                      <tr>
                        <th>玩家</th>
                        <th>状态</th>
                        <th>准备</th>
                        <th>延迟</th>
                        <th>手牌</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.players.map((p) => (
                        <tr key={p.id}>
                          <td>
                            <span className="admin__player">
                              <Avatar name={p.name} kind={p.kind} size={24} />
                              {p.name}
                              {p.isHost && <span className="tag tag--host">房主</span>}
                              <KindTag kind={p.kind} autoPlay={p.autoPlay} />
                            </span>
                          </td>
                          <td>
                            <StatusDot online={p.online && alive} /> {p.online && alive ? '在线' : '离线'}
                          </td>
                          <td>{p.ready || p.isHost ? '✓' : '—'}</td>
                          <td>{p.kind === 'ai' ? '—' : `${p.latency || 0}ms`}</td>
                          <td>{p.cards ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  <div className="admin__cols">
                    <div>
                      <h3>最近聊天</h3>
                      {r.chat?.length ? (
                        <ul className="admin__chat">
                          {[...r.chat].reverse().map((m) => (
                            <li key={m.id}>
                              <span className="muted small">{formatTime(m.at)}</span>
                              <b>{m.name}</b>
                              <span>{m.content}</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="muted small">暂无</p>
                      )}
                    </div>
                    <div>
                      <h3>拦截记录</h3>
                      {r.moderation?.length ? (
                        <ul className="admin__chat admin__chat--blocked">
                          {r.moderation.map((m, i) => (
                            <li key={i}>
                              <span className="muted small">{formatTime(m.at)}</span>
                              <b>{m.name}</b>
                              <span className="blocked-text">{m.content}</span>
                              <span className="muted small">{m.reason}</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="muted small">无违规消息</p>
                      )}
                    </div>
                  </div>

                  {!alive && (
                    <button className="btn btn--danger btn--sm" onClick={() => adminApi.purgeRoom(r.code)}>
                      清理该房间
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

function Stat({ value, label, tone }: { value: string | number; label: string; tone?: 'warn' }) {
  return (
    <div className="stat">
      <div className={`stat__value ${tone === 'warn' ? 'neg' : ''}`}>{value}</div>
      <div className="muted small">{label}</div>
    </div>
  );
}

// ---------------------------------------------------------------- 历史记录

function HistoryTab() {
  const [records, setRecords] = useState<GameRecord[]>([]);
  const [mode, setMode] = useState<'all' | GameMode>('all');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [replay, setReplay] = useState<GameRecord | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const load = useCallback(() => {
    adminApi.listHistory().then(setRecords).catch(() => {});
  }, []);
  useEffect(() => {
    load();
    window.addEventListener('storage', load);
    const t = setInterval(load, 5000);
    return () => {
      window.removeEventListener('storage', load);
      clearInterval(t);
    };
  }, [load]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return records.filter(
      (r) => (mode === 'all' || r.mode === mode) && (!q || r.roomCode.toLowerCase().includes(q) || r.players.some((p) => p.name.toLowerCase().includes(q))),
    );
  }, [records, mode, query]);

  const stats = useMemo(() => {
    const today = new Date().toDateString();
    const ddz = records.filter((r) => r.mode === 'doudizhu');
    const landlordWins = ddz.filter((r) => r.winnerSeat === r.landlordSeat).length;
    const avg = records.length ? records.reduce((s, r) => s + (r.endedAt - r.startedAt), 0) / records.length : 0;
    return {
      total: records.length,
      today: records.filter((r) => new Date(r.endedAt).toDateString() === today).length,
      ddz: ddz.length,
      pdk: records.length - ddz.length,
      landlordRate: ddz.length ? Math.round((landlordWins / ddz.length) * 100) : null,
      avg,
      bombs: records.reduce((s, r) => s + r.bombs, 0),
    };
  }, [records]);

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(shown, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `poker-history-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <>
      <div className="stats">
        <Stat value={stats.total} label={`总局数 · 今日 ${stats.today}`} />
        <Stat value={`${stats.pdk} / ${stats.ddz}`} label="跑得快 / 斗地主" />
        <Stat value={stats.landlordRate === null ? '—' : `${stats.landlordRate}%`} label="斗地主地主胜率" />
        <Stat value={stats.total ? duration(stats.avg) : '—'} label={`平均时长 · 炸弹 ${stats.bombs}`} />
      </div>

      <div className="history__bar">
        <div className="segmented history__filter">
          {(['all', 'paodekuai', 'doudizhu'] as const).map((m) => (
            <button key={m} className={mode === m ? 'is-active' : ''} onClick={() => setMode(m)}>
              {m === 'all' ? '全部' : MODE_LABEL[m]}
            </button>
          ))}
        </div>
        <input className="history__search" value={query} placeholder="搜索房间号或玩家" onChange={(e) => setQuery(e.target.value)} />
        <button className="btn btn--ghost btn--sm" onClick={exportJson} disabled={!shown.length}>
          导出
        </button>
        <button className="btn btn--text btn--sm" onClick={() => setConfirmClear(true)} disabled={!records.length}>
          清空
        </button>
      </div>

      {shown.length === 0 && (
        <div className="panel empty">
          <div className="empty__icon">🂠</div>
          <div>{records.length ? '没有符合条件的记录' : '还没有对局记录'}</div>
        </div>
      )}

      <div className="history__list">
        {shown.map((r) => {
          const expanded = open === r.id;
          const winners = r.winners.map((w) => r.players[w]?.name).join('、');
          const landlordWon = r.mode === 'doudizhu' && r.winnerSeat === r.landlordSeat;
          return (
            <div key={r.id} className="panel record">
              <button className="record__head" onClick={() => setOpen(expanded ? null : r.id)}>
                <span className={`record__badge ${r.mode === 'doudizhu' ? 'is-ddz' : ''}`}>{r.mode === 'doudizhu' ? '斗' : '跑'}</span>
                <span className="record__main">
                  <span className="record__title">
                    {r.mode === 'doudizhu' ? `${landlordWon ? '地主' : '农民'}获胜：${winners}` : `赢家：${winners}`}
                  </span>
                  <span className="muted small">
                    {formatTime(r.endedAt)} · 房间 {r.roomCode} 第 {r.round} 局 · {r.players.length} 人 · {r.deckCount} 副 · 用时 {duration(r.endedAt - r.startedAt)}
                  </span>
                </span>
                <span className="muted small">{expanded ? '收起' : '详情'}</span>
              </button>
              {expanded && (
                <div className="record__body">
                  <ol className="podium podium--compact">
                    {r.settlement.map((s) => {
                      const p = r.players.find((x) => x.id === s.playerId);
                      return (
                        <li key={s.playerId} className={`podium__row podium__row--${Math.min(s.rank, 4)}`}>
                          <span className="podium__rank">{s.rank === 1 ? '🏆' : s.rank === 2 ? '🥈' : s.rank === 3 ? '🥉' : s.rank}</span>
                          <span className="podium__name">
                            <Avatar name={s.name} kind={p?.kind ?? 'human'} size={22} />
                            {s.name}
                            <KindTag kind={p?.kind ?? 'human'} />
                            {s.role && <span className={`role role--${s.role}`}>{s.role === 'landlord' ? '地主' : '农民'}</span>}
                          </span>
                          <span className="podium__label">{rankLabel(s.rank)}</span>
                          <span className="muted small">{s.remaining ? `剩 ${s.remaining} 张` : '已出完'}</span>
                        </li>
                      );
                    })}
                  </ol>
                  <div className="record__actions">
                    <span className="muted small">
                      共 {r.log.filter((l) => l.action === 'play').length} 手出牌 · 炸弹 {r.bombs} 个
                    </span>
                    <span className="row-gap">
                      <button className="btn btn--text btn--sm" onClick={() => adminApi.removeHistory(r.id).then(load)}>
                        删除
                      </button>
                      <button className="btn btn--primary btn--sm" onClick={() => setReplay(r)}>
                        ▶ 复盘
                      </button>
                    </span>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {replay && <Replay record={replay} onClose={() => setReplay(null)} />}

      {confirmClear && (
        <Modal onClose={() => setConfirmClear(false)}>
          <h2>清空全部历史记录？</h2>
          <p className="muted">将删除 {records.length} 局记录，无法恢复。建议先导出备份。</p>
          <div className="row-end">
            <button className="btn btn--ghost" onClick={() => setConfirmClear(false)}>
              取消
            </button>
            <button
              className="btn btn--danger"
              onClick={() => {
                adminApi.clearHistory().then(load);
                setConfirmClear(false);
              }}
            >
              清空
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
