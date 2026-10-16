import { FormEvent, useState } from 'react';
import { PlayingCard } from '../components/PlayingCard';
import { lobbyApi, normalizeCode } from '../net/api';
import { profileStore } from '../net/storage';
import { useRoom } from '../store/RoomContext';


const DEMO_CARDS = [
  { id: 'a', suit: 'S' as const, rank: 14, deck: 0 },
  { id: 'b', suit: 'H' as const, rank: 13, deck: 0 },
  { id: 'c', suit: 'J' as const, rank: 17, deck: 0 },
  { id: 'd', suit: 'D' as const, rank: 12, deck: 0 },
  { id: 'e', suit: 'C' as const, rank: 11, deck: 0 },
];

export function Home() {
  const { createRoom, joinRoom, link, notify, send } = useRoom();
  const initialCode = new URLSearchParams(location.search).get('code') ?? '';
  const [name, setName] = useState(() => profileStore.getName());
  const [code, setCode] = useState(normalizeCode(initialCode));
  const [busy, setBusy] = useState<'create' | 'join' | 'demo' | null>(null);
  const [tab, setTab] = useState<'join' | 'create'>(initialCode ? 'join' : 'create');

  const ensureName = () => {
    const n = name.trim();
    if (!n) {
      notify('请先输入昵称', 'error');
      return null;
    }
    profileStore.setName(n);
    return n;
  };

  const onCreate = async (demo = false) => {
    const n = ensureName();
    if (!n) return;
    setBusy(demo ? 'demo' : 'create');
    try {
      await createRoom(n);
      // 快速体验：加入 1 名模拟真人玩家，开局时自动由 AI 补满 3 人
      if (demo) send({ type: 'addSimulated' });
      history.replaceState(null, '', location.pathname + location.hash);
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const onJoin = async (e: FormEvent) => {
    e.preventDefault();
    const n = ensureName();
    if (!n) return;
    setBusy('join');
    try {
      await joinRoom(code, n);
      history.replaceState(null, '', location.pathname + location.hash);
    } catch (err) {
      notify((err as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  if (link === 'connecting') {
    return (
      <div className="center-screen">
        <div className="spinner" />
        <p className="muted">正在连接房间…</p>
      </div>
    );
  }

  return (
    <div className="home">
      <div className="home__hero">
        <div className="home__fan" aria-hidden>
          {DEMO_CARDS.map((c, i) => (
            <PlayingCard key={c.id} card={c} size="lg" style={{ ['--i' as string]: i - 2 }} className="home__fan-card" />
          ))}
        </div>
        <h1>在线牌局</h1>
        <p className="muted">跑得快 · 斗地主｜人数不足时 AI 自动补位</p>
      </div>

      <div className="panel home__panel">
        <label className="field">
          <span>昵称</span>
          <input value={name} maxLength={12} placeholder="输入你的昵称" onChange={(e) => setName(e.target.value)} />
        </label>

        <div className="segmented" role="tablist">
          <button role="tab" aria-selected={tab === 'create'} className={tab === 'create' ? 'is-active' : ''} onClick={() => setTab('create')}>
            创建房间
          </button>
          <button role="tab" aria-selected={tab === 'join'} className={tab === 'join' ? 'is-active' : ''} onClick={() => setTab('join')}>
            加入房间
          </button>
        </div>

        {tab === 'create' ? (
          <div className="stack">
            <p className="muted small">创建后获得 6 位邀请码，作为房主可设置人数、牌副数并开始游戏。</p>
            <button className="btn btn--primary btn--block" disabled={!!busy} onClick={() => onCreate(false)}>
              {busy === 'create' ? '创建中…' : '创建房间'}
            </button>
            <button className="btn btn--ghost btn--block" disabled={!!busy} onClick={() => onCreate(true)}>
              {busy === 'demo' ? '准备中…' : '快速体验（1 名模拟玩家 + AI 补位）'}
            </button>
          </div>
        ) : (
          <form className="stack" onSubmit={onJoin}>
            <input
              className="code-input"
              value={code}
              maxLength={6}
              placeholder="邀请码"
              autoCapitalize="characters"
              onChange={(e) => setCode(normalizeCode(e.target.value).slice(0, 6))}
            />
            <button className="btn btn--primary btn--block" disabled={!!busy || code.length !== 6}>
              {busy === 'join' ? '加入中…' : '加入房间'}
            </button>
          </form>
        )}
      </div>

      {lobbyApi.mode === 'mock' && (
        <p className="home__tip muted small">
          本地演示模式：在同一浏览器打开新标签页并输入邀请码，即可以另一位玩家身份加入。
        </p>
      )}
    </div>
  );
}
