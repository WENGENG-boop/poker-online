// 牌局复盘（后台）：按步重放每一手出牌，展示每位玩家当时的手牌

import { useEffect, useMemo, useState } from 'react';
import { Card, sortByRank } from '../game/cards';
import type { LogEntry } from '../game/engine';
import { MODE_LABEL, describePattern } from '../game/rules';
import type { GameRecord } from '../net/adminHistory';
import { Avatar, Modal } from './common';
import { PlayingCard } from './PlayingCard';
import { rankLabel } from './Seat';

export function Replay({ record, onClose }: { record: GameRecord; onClose(): void }) {
  const total = record.log.length;
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);

  useEffect(() => {
    if (!playing) return;
    if (step >= total) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setStep((s) => s + 1), 900 / speed);
    return () => clearTimeout(t);
  }, [playing, step, total, speed]);

  // 重放到第 step 手：每人手牌、已出完的座位、桌面最大牌
  const state = useMemo(() => {
    const played = new Set<string>();
    const out: number[] = [];
    let top: LogEntry | null = null;
    let passes = 0;
    const remaining = (seat: number) => record.initialHands[record.players[seat].id].filter((c) => !played.has(c.id)).length;
    for (let i = 0; i < step; i++) {
      const l = record.log[i];
      if (l.action === 'play') {
        l.cards!.forEach((c) => played.add(c.id));
        top = l;
        passes = 0;
        if (remaining(l.seat) === 0) out.push(l.seat);
      } else {
        passes++;
        const responders = record.players.filter((_, s) => s !== top?.seat && !out.includes(s)).length;
        if (passes >= responders) {
          top = null;
          passes = 0;
        }
      }
    }
    const hands: Record<string, Card[]> = {};
    for (const p of record.players) hands[p.id] = sortByRank(record.initialHands[p.id].filter((c) => !played.has(c.id))).reverse();
    return { hands, out, top };
  }, [record, step]);

  const current = step > 0 ? record.log[step - 1] : null;
  const finished = step >= total;
  const rankOf = (seat: number) => record.settlement.find((r) => r.playerId === record.players[seat].id)?.rank ?? null;

  return (
    <Modal wide onClose={onClose}>
      <div className="replay">
        <div className="replay__head">
          <h2>
            复盘 · {MODE_LABEL[record.mode]} · 房间 {record.roomCode} 第 {record.round} 局
          </h2>
          <span className="muted small">
            第 {step} / {total} 手
          </span>
        </div>

        {record.mode === 'doudizhu' && record.bottom.length > 0 && (
          <div className="replay__bottom small muted">
            底牌
            {record.bottom.map((c) => (
              <PlayingCard key={c.id} card={c} size="xs" />
            ))}
          </div>
        )}

        <div className="replay__table">
          {state.top ? (
            <div key={step} className="replay__top">
              <div className="replay__cards">
                {state.top.cards!.map((c, i) => (
                  <PlayingCard key={c.id} card={c} size="sm" style={{ marginLeft: i ? -26 : 0 }} />
                ))}
              </div>
              <span className="small muted">
                {record.players[state.top.seat].name} · {describePattern(state.top.pattern!)}
              </span>
            </div>
          ) : (
            <span className="muted small">{step === 0 ? '开局，等待第一手' : finished ? '牌局结束' : '新一轮，等待领出'}</span>
          )}
        </div>

        <ul className="replay__players">
          {record.players.map((p, seat) => {
            const active = current?.seat === seat;
            const outIdx = state.out.indexOf(seat);
            const finalRank = finished ? rankOf(seat) : null;
            return (
              <li key={p.id} className={`replay__player ${active ? 'is-active' : ''} ${finalRank === 1 ? 'is-winner' : ''}`}>
                <div className="replay__who">
                  <Avatar name={p.name} kind={p.kind} size={28} />
                  <span className="replay__name">
                    {seat === record.landlordSeat && '👑 '}
                    {p.name}
                  </span>
                  {record.landlordSeat !== null && (
                    <span className={`role role--${seat === record.landlordSeat ? 'landlord' : 'farmer'}`}>{seat === record.landlordSeat ? '地主' : '农民'}</span>
                  )}
                  <span className="muted small">{state.hands[p.id].length} 张</span>
                  {active && <span className={`tag ${current!.action === 'pass' ? '' : 'tag--ai'}`}>{current!.action === 'pass' ? '不要' : describePattern(current!.pattern!)}</span>}
                  {finalRank !== null ? (
                    <span className="tag tag--host">{rankLabel(finalRank)}</span>
                  ) : (
                    outIdx >= 0 && record.mode === 'paodekuai' && <span className="tag tag--host">{rankLabel(outIdx + 1)}</span>
                  )}
                </div>
                <div className="replay__hand">
                  {state.hands[p.id].map((c, i) => (
                    <PlayingCard key={c.id} card={c} size="xs" style={{ marginLeft: i ? -16 : 0 }} />
                  ))}
                </div>
              </li>
            );
          })}
        </ul>

        <input
          className="replay__slider"
          type="range"
          min={0}
          max={total}
          value={step}
          aria-label="复盘进度"
          onChange={(e) => {
            setPlaying(false);
            setStep(Number(e.target.value));
          }}
        />
        <div className="replay__controls">
          <button className="btn btn--ghost btn--sm" onClick={() => setStep(0)} disabled={step === 0} aria-label="回到开头">
            ⏮
          </button>
          <button className="btn btn--ghost btn--sm" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}>
            上一手
          </button>
          <button
            className="btn btn--primary btn--sm replay__play"
            onClick={() => {
              if (finished) setStep(0);
              setPlaying((p) => !p || finished);
            }}
          >
            {playing ? '暂停' : finished ? '重新播放' : '播放'}
          </button>
          <button className="btn btn--ghost btn--sm" onClick={() => setStep((s) => Math.min(total, s + 1))} disabled={finished}>
            下一手
          </button>
          <button className="btn btn--ghost btn--sm" onClick={() => setSpeed((s) => (s === 1 ? 2 : s === 2 ? 4 : 1))}>
            {speed}×
          </button>
        </div>
      </div>
    </Modal>
  );
}
