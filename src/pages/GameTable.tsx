import { CSSProperties, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ChatBubble, ChatButton, useChatBubbles, useChatSound } from '../components/Chat';
import { Modal } from '../components/common';
import { Dealer, Point } from '../components/Dealer';
import { Hand } from '../components/Hand';
import { PlayingCard } from '../components/PlayingCard';
import { ActionBubble, Seat, rankLabel } from '../components/Seat';
import { hintMoves } from '../game/ai';
import { Card, cardName, sortByGroup, sortByRank } from '../game/cards';
import { isTeammate } from '../game/engine';
import { MODE_LABEL, describePattern, resolvePlay } from '../game/rules';
import { LANDLORD_REVEAL_MS, ServerView } from '../net/protocol';
import { useRoom } from '../store/RoomContext';
import { playSound, soundSettings } from '../ui/sound';

export function useMuted() {
  return useSyncExternalStore(soundSettings.subscribe, () => soundSettings.muted);
}

type SortMode = 'desc' | 'asc' | 'group';
const SORT_LABEL: Record<SortMode, string> = { desc: '从大到小', asc: '从小到大', group: '按牌型' };
const SORT_NEXT: Record<SortMode, SortMode> = { desc: 'group', group: 'asc', asc: 'desc' };

/**
 * 对手座位位置（百分比）。k=1 为下家。
 *  - 2 名对手：右上、左上
 *  - 1 名对手：正上方
 *  - 3 名及以上：从右侧经上方排到左侧
 */
function seatPosition(k: number, opponents: number, compact: boolean): Point {
  const edge = compact ? 20 : 14;
  if (opponents === 1) return { x: 50, y: 20 };
  if (opponents === 2) return k === 1 ? { x: 100 - edge, y: 20 } : { x: edge, y: 20 };
  const angle = 4 + ((k - 1) * 172) / (opponents - 1);
  const rad = (angle * Math.PI) / 180;
  return { x: 50 + (50 - edge) * Math.cos(rad), y: 52 - 34 * Math.sin(rad) };
}

const ME_POS: Point = { x: 50, y: 115 };
const PILE_DEPTH = 8;

/** 根据序号生成稳定的随机偏移，让牌堆看起来自然叠放 */
function jitter(i: number) {
  return { rot: ((i * 37) % 23) - 11, dx: ((i * 53) % 41) - 20, dy: ((i * 29) % 25) - 12 };
}

export function useNow(interval = 250) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(t);
  }, [interval]);
  return now;
}

/** 到达指定时间点时精确切换为 true（不依赖低频的 useNow） */
function useReached(ts: number) {
  const [reached, setReached] = useState(() => Date.now() >= ts);
  useEffect(() => {
    const d = ts - Date.now();
    if (d <= 0) {
      setReached(true);
      return;
    }
    setReached(false);
    const t = setTimeout(() => setReached(true), d);
    return () => clearTimeout(t);
  }, [ts]);
  return reached;
}

function useMediaQuery(query: string) {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const fn = () => setMatch(mq.matches);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, [query]);
  return match;
}

export function GameTable({ view }: { view: ServerView }) {
  const { send, leaveRoom, notify } = useRoom();
  const game = view.game!;
  const { room, you } = view;
  // 倒计时只需按秒刷新；能否出牌由 useReached 精确控制
  const now = useNow(1000);
  const compact = useMediaQuery('(max-width: 640px)');
  const ddz = game.mode === 'doudizhu';

  const mySeat = game.seats.findIndex((s) => s.id === you);
  const n = game.seats.length;
  const me = room.players.find((p) => p.id === you)!;
  const isHost = me.isHost;
  const leading = game.lastPlay === null;
  const bidding = game.phase === 'bidding';
  const myRankIdx = game.finishOrder.indexOf(mySeat);
  const iAmOut = myRankIdx >= 0 && game.phase === 'playing';

  // ------------------------------------------------------------ 洗牌 / 发牌动画
  const dealKey = `${game.round}-${game.startedAt}`;
  const [dealing, setDealing] = useState(false);
  const [myProgress, setMyProgress] = useState(1);
  const seenDeal = useRef<string | null>(null);
  useEffect(() => {
    if (seenDeal.current === dealKey) return;
    seenDeal.current = dealKey;
    // 只在刚开局时播放；刷新重连时不再重复
    if (game.log.length === 0 && game.landlordSeat === null && Date.now() < game.turnStartedAt - 1500) {
      setDealing(true);
      setMyProgress(0);
    }
  }, [dealKey, game.log.length, game.turnStartedAt, game.landlordSeat]);

  // 无人叫地主，重新发牌
  const lastRedeal = useRef(game.redealt ?? 0);
  useEffect(() => {
    if ((game.redealt ?? 0) > lastRedeal.current) notify('无人叫地主，重新洗牌发牌', 'info');
    lastRedeal.current = game.redealt ?? 0;
  }, [game.redealt, notify]);

  // ------------------------------------------------------------ 翻底牌动画（斗地主）
  const [revealing, setRevealing] = useState(false);
  const seenReveal = useRef<string | null>(null);
  useEffect(() => {
    if (game.landlordSeat === null || seenReveal.current === dealKey) return;
    seenReveal.current = dealKey;
    if (game.log.length === 0 && Date.now() < game.turnStartedAt) {
      setRevealing(true);
      playSound('turn');
      const t = setTimeout(() => setRevealing(false), LANDLORD_REVEAL_MS - 100);
      return () => clearTimeout(t);
    }
  }, [game.landlordSeat, dealKey, game.log.length, game.turnStartedAt]);

  const startReached = useReached(game.turnStartedAt);
  const ready = !dealing && startReached;
  const isMyTurn = game.phase === 'playing' && game.turn === mySeat && ready;
  const myBidTurn = bidding && game.turn === mySeat && ready;
  const muted = useMuted();

  // ------------------------------------------------------------ 音效
  const prevLogLen = useRef(game.log.length);
  useEffect(() => {
    const len = game.log.length;
    if (len > prevLogLen.current) {
      const l = game.log[len - 1];
      if (l.action === 'pass') playSound('pass');
      else if (l.pattern?.type === 'bomb' || l.pattern?.type === 'rocket') playSound('bomb');
      else playSound('play');
    }
    prevLogLen.current = len;
  }, [game.log]);
  const wasMyTurn = useRef(false);
  useEffect(() => {
    const mine = isMyTurn || myBidTurn;
    if (mine && !wasMyTurn.current) {
      playSound('turn');
      navigator.vibrate?.(30);
    }
    wasMyTurn.current = mine;
  }, [isMyTurn, myBidTurn]);
  useChatSound(room.chat, you);
  const bubbles = useChatBubbles(room.chat, now);

  // ------------------------------------------------------------ 手牌与选择
  const [sortMode, setSortMode] = useState<SortMode>('desc');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [hintIdx, setHintIdx] = useState(0);
  const [shake, setShake] = useState(0);
  const [showLog, setShowLog] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);

  const hand = useMemo(() => {
    if (sortMode === 'asc') return sortByRank(game.myHand);
    if (sortMode === 'group') return sortByGroup(game.myHand);
    return sortByRank(game.myHand).reverse();
  }, [game.myHand, sortMode]);
  const visibleHand = dealing ? hand.slice(0, Math.round(hand.length * myProgress)) : hand;

  // 地主刚拿到的底牌高亮几秒
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (game.landlordSeat !== mySeat || !game.leftover || game.log.length > 0) return;
    setFresh(new Set(game.leftover.map((c) => c.id)));
    const t = setTimeout(() => setFresh(new Set()), 4000);
    return () => clearTimeout(t);
  }, [game.landlordSeat, mySeat, game.leftover, game.log.length]);

  useEffect(() => {
    const ids = new Set(game.myHand.map((c) => c.id));
    setSelected((s) => {
      const next = new Set([...s].filter((id) => ids.has(id)));
      return next.size === s.size ? s : next;
    });
  }, [game.myHand]);

  useEffect(() => setHintIdx(0), [game.log.length]);

  const selectedCards = hand.filter((c) => selected.has(c.id));
  const target = game.lastPlay?.pattern ?? null;
  const preview = selectedCards.length ? resolvePlay(selectedCards, target, game.mode) : null;
  // 只在手牌或桌面变化时重新计算提示
  const handKey = game.myHand.map((c) => c.id).join(',');
  const myHandRef = useRef(game.myHand);
  myHandRef.current = game.myHand;
  const targetRef = useRef(target);
  targetRef.current = target;
  const hints = useMemo(
    () => (isMyTurn ? hintMoves(myHandRef.current, targetRef.current, game.mode) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isMyTurn, handKey, game.log.length, game.mode],
  );
  const onSelect = useCallback((next: Set<string>) => {
    playSound('select');
    setSelected(next);
  }, []);
  const cannotBeat = isMyTurn && !leading && hints.length === 0;

  const doPlay = () => {
    if (!isMyTurn) return;
    if (!selectedCards.length) return notify('请先选择要出的牌', 'error');
    if (!preview) {
      setShake((x) => x + 1);
      return notify(leading ? '不是合法的牌型' : '需要同牌型且更大的牌，或使用炸弹', 'error');
    }
    send({ type: 'play', cardIds: selectedCards.map((c) => c.id) });
  };
  const doPass = () => {
    if (!isMyTurn || leading) return;
    setSelected(new Set());
    send({ type: 'pass' });
  };
  const doHint = () => {
    if (!hints.length) return notify('没有能压过上家的牌', 'info');
    setSelected(new Set(hints[hintIdx % hints.length].map((c) => c.id)));
    setHintIdx((i) => i + 1);
  };

  // 键盘快捷键：Enter 出牌、Space 不要、H 提示、Esc 取消选择
  const keyRef = useRef({ doPlay, doPass, doHint });
  keyRef.current = { doPlay, doPass, doHint };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      if (e.key === 'Enter') keyRef.current.doPlay();
      else if (e.key === ' ') {
        e.preventDefault();
        keyRef.current.doPass();
      } else if (e.key.toLowerCase() === 'h') keyRef.current.doHint();
      else if (e.key === 'Escape') setSelected(new Set());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ------------------------------------------------------------ 座位布局
  const positions = useMemo(() => {
    const map: Record<number, Point> = {};
    for (let k = 1; k < n; k++) map[(mySeat + k) % n] = seatPosition(k, n - 1, compact);
    map[mySeat] = ME_POS;
    return map;
  }, [mySeat, n, compact]);

  // 发牌顺序：从先行动的玩家开始轮流
  const dealOrder = useMemo(() => Array.from({ length: n }, (_, i) => (game.turn + i) % n), [game.turn, n]);
  const dealTargets = dealOrder.map((s) => (s === mySeat ? { x: 50, y: 104 } : positions[s]));

  const playerOf = (seat: number) => room.players.find((p) => p.id === game.seats[seat].id)!;
  const turnSeconds = room.config.turnSeconds;
  const elapsed = Math.max(0, (now - game.turnStartedAt) / 1000);
  const remaining = turnSeconds > 0 && game.phase !== 'finished' ? Math.max(0, turnSeconds - elapsed) : null;

  const totalCards = Object.values(game.handCounts).reduce((a, b) => a + b, 0);
  const playedCards = game.log.reduce((s, l) => s + (l.cards?.length ?? 0), 0);
  const progress = totalCards + playedCards ? playedCards / (totalCards + playedCards) : 0;
  const turnName = game.phase !== 'finished' ? (game.turn === mySeat ? '你' : game.seats[game.turn].name) : null;
  const roleOf = (seat: number) => (game.landlordSeat === null ? null : seat === game.landlordSeat ? 'landlord' : 'farmer');
  const rankOf = (seat: number) => {
    const i = game.finishOrder.indexOf(seat);
    return i >= 0 && !ddz ? i + 1 : null;
  };

  const pct = (p: Point): CSSProperties => ({ left: `${p.x}%`, top: `${p.y}%` });
  const bubblePos = (seat: number): Point => {
    if (seat === mySeat) return { x: 50, y: 88 };
    const p = positions[seat];
    return { x: p.x + (50 - p.x) * 0.3, y: p.y + (50 - p.y) * 0.45 };
  };

  // 中央牌堆：最近若干手出牌叠放，最新一手压在最上面
  const pile = useMemo(() => {
    const plays: { idx: number; seat: number; cards: Card[] }[] = [];
    game.log.forEach((l, idx) => l.action === 'play' && plays.push({ idx, seat: l.seat, cards: l.cards! }));
    return plays.slice(-PILE_DEPTH);
  }, [game.log]);
  const topIdx = game.lastPlay ? pile[pile.length - 1]?.idx : -1;
  const lp = game.lastPlay;
  const lastLog = game.log[game.log.length - 1];
  const overlap = compact ? -28 : -36;
  const someoneCalled = game.bidding?.candidate !== null && game.bidding?.candidate !== undefined;

  return (
    <div className="game">
      <header className="topbar topbar--game">
        <button className="btn btn--text" onClick={() => setConfirmLeave(true)}>
          ← 离开
        </button>
        <div className="game__status">
          <span className="chip chip--mode">{MODE_LABEL[game.mode]}</span>
          <span className="chip">第 {game.round} 局</span>
          <span className="chip chip--hide-sm">房间 {room.code}</span>
          {ddz && game.leftover && (
            <span className="chip chip--bottom" title="底牌">
              底牌
              {game.leftover.map((c) => (
                <PlayingCard key={c.id} card={c} size="xs" />
              ))}
            </span>
          )}
          {!ddz && game.leftoverCount > 0 && <span className="chip chip--hide-sm">余牌 {game.leftoverCount}</span>}
        </div>
        <div className="topbar__actions">
          <button className="btn btn--text" title={muted ? '开启音效' : '关闭音效'} onClick={() => soundSettings.setMuted(!muted)}>
            {muted ? '🔇' : '🔊'}
          </button>
          <button className="btn btn--text" onClick={() => setShowLog(true)}>
            记录
          </button>
        </div>
      </header>
      <div className="progress" title={`已出 ${Math.round(progress * 100)}%`}>
        <div className="progress__bar" style={{ width: `${progress * 100}%` }} />
      </div>

      <main className="table">
        <div className="table__spot" />

        {game.seats.map((s, i) => {
          if (i === mySeat) return null;
          const p = playerOf(i);
          return (
            <Seat
              key={s.id}
              player={p}
              cards={game.handCounts[s.id]}
              isTurn={game.phase !== 'finished' && game.turn === i && ready}
              rank={rankOf(i)}
              role={roleOf(i)}
              teammate={isTeammate(game, i, mySeat) && i !== mySeat && game.landlordSeat !== null}
              remaining={remaining}
              totalSeconds={turnSeconds}
              compact={compact || n > 5}
              hideCount={dealing}
              thinking={p.kind !== 'human' || p.autoPlay || !p.online}
              bidding={bidding}
              chat={bubbles[s.id]}
              style={pct(positions[i])}
            />
          );
        })}

        {game.seats.map((_, i) => (
          <ActionBubble key={i} action={game.seatActions[i]} style={pct(bubblePos(i))} />
        ))}

        {/* 中央牌堆 */}
        {!dealing && !revealing && (
          <div className="pile">
            {pile.map((p, depth) => {
              const isTop = p.idx === topIdx;
              const j = jitter(p.idx);
              const from = positions[p.seat];
              const age = pile.length - 1 - depth;
              return (
                <div
                  key={p.idx}
                  className={`pile__play ${isTop ? 'is-top' : ''}`}
                  style={{
                    zIndex: depth + 1,
                    ['--fx' as string]: String(from.x),
                    ['--fy' as string]: String(from.y),
                    ['--rot' as string]: isTop ? '0deg' : `${j.rot}deg`,
                    ['--dx' as string]: isTop ? '0px' : `${j.dx}px`,
                    ['--dy' as string]: isTop ? '0px' : `${j.dy}px`,
                    ['--scale' as string]: isTop ? 1 : 0.82,
                    ['--fade' as string]: isTop ? 1 : Math.max(0.35, 0.85 - age * 0.08),
                  }}
                >
                  {p.cards.map((c, k) => (
                    <PlayingCard key={c.id} card={c} size={compact ? 'sm' : 'md'} style={{ marginLeft: k ? overlap : 0 }} />
                  ))}
                </div>
              );
            })}

            {bidding && (
              <div className="bottom-cards">
                {Array.from({ length: game.leftoverCount }, (_, i) => (
                  <PlayingCard key={i} back size={compact ? 'sm' : 'md'} style={{ marginLeft: i ? (compact ? -20 : -26) : 0 }} />
                ))}
              </div>
            )}

            {lp && (
              <div key={`label-${topIdx}`} className="pile__label">
                {lp.seat === mySeat ? '你' : game.seats[lp.seat].name} · {describePattern(lp.pattern)}
              </div>
            )}
            {!lp && ready && game.phase === 'playing' && (
              <div className="pile__hint">{game.turn === mySeat ? '轮到你领出，可出任意牌型' : `等待 ${turnName} 领出`}</div>
            )}
            {bidding && ready && (
              <div className="pile__hint">
                {game.turn === mySeat ? (someoneCalled ? '有人叫地主了，要抢吗？' : '要叫地主吗？') : `等待 ${turnName} ${someoneCalled ? '抢地主' : '叫地主'}`}
              </div>
            )}
          </div>
        )}

        {/* 翻底牌：底牌翻开后飞向地主 */}
        {revealing && game.leftover && game.landlordSeat !== null && (
          <div
            className="reveal"
            style={{ ['--tx' as string]: String(positions[game.landlordSeat].x), ['--ty' as string]: String(Math.min(positions[game.landlordSeat].y, 100)) }}
          >
            <div className="reveal__cards">
              {game.leftover.map((c, i) => (
                <div key={c.id} className="flip" style={{ animationDelay: `${i * 90}ms` }}>
                  <div className="flip__inner" style={{ animationDelay: `${i * 90}ms` }}>
                    <PlayingCard back size="md" className="flip__back" />
                    <PlayingCard card={c} size="md" className="flip__front" />
                  </div>
                </div>
              ))}
            </div>
            <div className="reveal__label">
              👑 {game.landlordSeat === mySeat ? '你' : game.seats[game.landlordSeat].name} 成为地主
            </div>
          </div>
        )}

        {dealing && (
          <Dealer
            key={dealKey}
            targets={dealTargets}
            meIndex={dealOrder.indexOf(mySeat)}
            totalCards={totalCards + game.leftoverCount}
            onMyProgress={setMyProgress}
            onDone={() => {
              setDealing(false);
              setMyProgress(1);
            }}
          />
        )}
      </main>

      {/* 我的区域 */}
      <section className={`me ${isMyTurn || myBidTurn ? 'is-turn' : ''}`}>
        <ChatBubble message={bubbles[you]} className="chat-bubble--me" />
        <div className="me__bar">
          <div className="me__who">
            <span className="me__name">
              {roleOf(mySeat) === 'landlord' && '👑 '}
              {me.name}
            </span>
            {roleOf(mySeat) && <span className={`role role--${roleOf(mySeat)}`}>{roleOf(mySeat) === 'landlord' ? '地主' : '农民'}</span>}
            <span className="muted small">{visibleHand.length} 张</span>
            {me.autoPlay && <span className="tag tag--auto">托管中</span>}
          </div>
          <div className="me__turn">
            {dealing ? (
              <span className="muted small">发牌中…</span>
            ) : iAmOut ? (
              <span className="turn-flag turn-flag--done">{rankLabel(myRankIdx + 1)} · 等待其他玩家</span>
            ) : isMyTurn || myBidTurn ? (
              <span className="turn-flag">
                {myBidTurn ? (someoneCalled ? '要抢地主吗' : '要叫地主吗') : '轮到你出牌'}
                {remaining !== null && <b className={remaining <= 5 ? 'is-urgent' : ''}>{Math.ceil(remaining)}s</b>}
              </span>
            ) : game.phase !== 'finished' ? (
              <span className="muted small">
                等待 {turnName} {bidding ? '叫地主' : '出牌'}…
              </span>
            ) : null}
          </div>
          <div className="me__tools">
            <ChatButton policy={room.config.chat} chat={room.chat} you={you} compact={compact} />
            <button className="btn btn--sm btn--ghost" onClick={() => setSortMode(SORT_NEXT[sortMode])} title="整理手牌">
              {compact ? '整理' : `整理 · ${SORT_LABEL[sortMode]}`}
            </button>
            {!iAmOut && (
              <button className={`btn btn--sm ${me.autoPlay ? 'btn--warn' : 'btn--ghost'}`} onClick={() => send({ type: 'autoPlay', on: !me.autoPlay })}>
                {me.autoPlay ? '取消托管' : '托管'}
              </button>
            )}
          </div>
        </div>
        {(isMyTurn || myBidTurn) && remaining !== null && turnSeconds > 0 && (
          <div className="timebar timebar--me">
            <div className={`timebar__fill ${remaining <= 5 ? 'is-urgent' : ''}`} style={{ width: `${(remaining / turnSeconds) * 100}%` }} />
          </div>
        )}

        <div className="me__actions">
          {myBidTurn && !me.autoPlay ? (
            <>
              <button className="btn btn--ghost" onClick={() => send({ type: 'bid', call: false })}>
                {someoneCalled ? '不抢' : '不叫'}
              </button>
              <button className="btn btn--primary btn--call" onClick={() => send({ type: 'bid', call: true })}>
                {someoneCalled ? '抢地主' : '叫地主'}
              </button>
            </>
          ) : isMyTurn && !me.autoPlay ? (
            <>
              <button className={`btn ${cannotBeat ? 'btn--primary' : 'btn--ghost'}`} disabled={leading} onClick={doPass}>
                {cannotBeat ? '要不起' : '不要'}
              </button>
              <button className="btn btn--ghost" onClick={doHint} disabled={cannotBeat}>
                提示
              </button>
              <button key={shake} className={`btn btn--primary btn--play ${shake ? 'shake' : ''}`} disabled={!selectedCards.length} onClick={doPlay}>
                出牌
                {selectedCards.length > 0 && <span className="btn__sub">{preview ? describePattern(preview) : '不合法'}</span>}
              </button>
            </>
          ) : (
            selectedCards.length > 0 && (
              <button className="btn btn--sm btn--text" onClick={() => setSelected(new Set())}>
                取消选择（{selectedCards.length}）
              </button>
            )
          )}
        </div>

        <Hand
          cards={visibleHand}
          selected={selected}
          fresh={fresh}
          onChange={onSelect}
          dealKey={dealKey}
        />
      </section>

      {lastLog && lastLog.action === 'play' && lastLog.pattern && (lastLog.pattern.type === 'bomb' || lastLog.pattern.type === 'rocket') && (
        <div key={game.log.length} className="flash">
          {describePattern(lastLog.pattern)}！
        </div>
      )}

      {game.phase === 'finished' && <ResultModal view={view} isHost={isHost} onLeave={leaveRoom} send={send} />}

      {showLog && (
        <Modal onClose={() => setShowLog(false)}>
          <h2>本局出牌记录</h2>
          <ol className="log">
            {game.log.length === 0 && <li className="muted">还没有出牌</li>}
            {[...game.log].reverse().map((l, i) => (
              <li key={i}>
                <b>{l.seat === mySeat ? '你' : game.seats[l.seat].name}</b>
                {l.action === 'pass' ? (
                  <span className="muted">不要</span>
                ) : (
                  <span>
                    <span className="tag">{describePattern(l.pattern!)}</span> {l.cards!.map(cardName).join(' ')}
                  </span>
                )}
              </li>
            ))}
          </ol>
          <button className="btn btn--ghost btn--block" onClick={() => setShowLog(false)}>
            关闭
          </button>
        </Modal>
      )}

      {confirmLeave && (
        <Modal onClose={() => setConfirmLeave(false)}>
          <h2>{isHost ? '解散房间？' : '离开牌局？'}</h2>
          <p className="muted">{isHost ? '你是房主，离开后房间将被解散，所有玩家都会退出。' : '离开后本局将由 AI 托管你的手牌。'}</p>
          <div className="row-end">
            <button className="btn btn--ghost" onClick={() => setConfirmLeave(false)}>
              取消
            </button>
            <button className="btn btn--danger" onClick={leaveRoom}>
              {isHost ? '解散' : '离开'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function ResultModal({ view, isHost, onLeave, send }: { view: ServerView; isHost: boolean; onLeave(): void; send: ReturnType<typeof useRoom>['send'] }) {
  const game = view.game!;
  const { you } = view;
  const ddz = game.mode === 'doudizhu';
  const [hidden, setHidden] = useState(false);
  const mySeat = game.seats.findIndex((s) => s.id === you);
  const iWon = game.winners?.includes(mySeat) ?? false;
  const myRow = game.settlement!.find((r) => r.playerId === you);
  useEffect(() => playSound(iWon ? 'win' : 'lose'), [iWon]);

  const landlordWon = ddz && game.winnerSeat === game.landlordSeat;
  const winner = game.seats[game.winnerSeat!];
  const title = ddz
    ? `${landlordWon ? '👑 地主' : '🌾 农民'}获胜`
    : iWon
      ? '🎉 你是赢家！'
      : `${winner.name} 是赢家`;
  const subtitle = ddz ? (iWon ? '你所在的一方获胜！' : '你所在的一方落败') : myRow ? `你获得${rankLabel(myRow.rank)}` : '';

  if (hidden) {
    return (
      <button className="btn btn--primary result-reopen" onClick={() => setHidden(false)}>
        查看结果
      </button>
    );
  }

  return (
    <Modal wide>
      {iWon && <Confetti />}
      <div className={`result ${iWon ? 'result--win' : ''}`}>
        <div className="result__title">{title}</div>
        <div className="muted">
          {MODE_LABEL[game.mode]} · 第 {game.round} 局 · {subtitle}
        </div>
        <ol className="podium">
          {game.settlement!.map((r) => (
            <li key={r.playerId} className={`podium__row podium__row--${Math.min(r.rank, 4)} ${r.playerId === you ? 'is-me' : ''}`}>
              <span className="podium__rank">{r.rank === 1 ? '🏆' : r.rank === 2 ? '🥈' : r.rank === 3 ? '🥉' : r.rank}</span>
              <span className="podium__name">
                {r.name}
                {r.playerId === you && <span className="muted small">（你）</span>}
                {r.role && <span className={`role role--${r.role}`}>{r.role === 'landlord' ? '地主' : '农民'}</span>}
              </span>
              <span className="podium__label">{rankLabel(r.rank)}</span>
              <span className="muted small">{r.remaining ? `剩 ${r.remaining} 张` : '已出完'}</span>
            </li>
          ))}
        </ol>
        {game.revealedHands && (
          <div className="result__hands">
            {game.seats
              .filter((s) => game.revealedHands![s.id].length)
              .map((s) => (
                <div key={s.id} className="result__hand">
                  <span className="small">{s.id === you ? '你' : s.name}</span>
                  <div>
                    {sortByRank(game.revealedHands![s.id] as Card[])
                      .reverse()
                      .map((c, i) => (
                        <PlayingCard key={c.id} card={c} size="xs" style={{ marginLeft: i ? -20 : 0 }} />
                      ))}
                  </div>
                </div>
              ))}
          </div>
        )}
        <div className="row-end">
          <button className="btn btn--text" onClick={() => setHidden(true)}>
            查看牌桌
          </button>
          {isHost ? (
            <>
              <button className="btn btn--ghost" onClick={() => send({ type: 'backToLobby' })}>
                返回房间
              </button>
              <button className="btn btn--primary" onClick={() => send({ type: 'nextRound' })}>
                再来一局
              </button>
            </>
          ) : (
            <>
              <button className="btn btn--ghost" onClick={onLeave}>
                离开
              </button>
              <span className="muted small">等待房主开始下一局…</span>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

const CONFETTI_COLORS = ['#2f5bff', '#7a4dff', '#f59e0b', '#ef4444', '#16a34a', '#06b6d4'];

function Confetti() {
  const pieces = useMemo(
    () =>
      Array.from({ length: 70 }, (_, i) => ({
        left: Math.random() * 100,
        delay: Math.random() * 0.6,
        dur: 1.8 + Math.random() * 1.4,
        rot: Math.random() * 720 - 360,
        drift: Math.random() * 160 - 80,
        color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
        w: 6 + Math.random() * 6,
      })),
    [],
  );
  return (
    <div className="confetti" aria-hidden>
      {pieces.map((p, i) => (
        <span
          key={i}
          style={{
            left: `${p.left}%`,
            width: p.w,
            height: p.w * 0.45,
            background: p.color,
            animationDelay: `${p.delay}s`,
            animationDuration: `${p.dur}s`,
            ['--rot' as string]: `${p.rot}deg`,
            ['--drift' as string]: `${p.drift}px`,
          }}
        />
      ))}
    </div>
  );
}
