// 我的手牌：点击或滑动选择，牌多时自动分两行

import { PointerEvent, memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Card } from '../game/cards';
import { PlayingCard } from './PlayingCard';

interface Props {
  cards: Card[];
  selected: Set<string>;
  onChange(next: Set<string>): void;
  /** 刚拿到的牌（如斗地主底牌），短暂高亮 */
  fresh?: Set<string>;
  /** 每局开局时变化，用于触发发牌入场动画 */
  dealKey: string;
}

const MIN_STEP = 16;

function cardWidthFor(width: number): number {
  if (width < 420) return 50;
  if (width < 720) return 60;
  if (width < 1100) return 72;
  return 82;
}

export const Hand = memo(function Hand({ cards, selected, onChange, dealKey, fresh }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const drag = useRef<{ mode: boolean; seen: Set<string>; next: Set<string> } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const cardW = cardWidthFor(width);
  const fits = (n: number) => (n <= 1 ? true : (width - cardW) / (n - 1) >= MIN_STEP);
  const rows: Card[][] = fits(cards.length) || cards.length < 2 ? [cards] : [cards.slice(0, Math.ceil(cards.length / 2)), cards.slice(Math.ceil(cards.length / 2))];
  const stepFor = (n: number) => (n <= 1 ? 0 : Math.min(cardW * 0.62, (width - cardW) / (n - 1)));

  const idAt = (x: number, y: number): string | null => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-card-id]');
    return el && ref.current?.contains(el) ? el.dataset.cardId! : null;
  };

  const apply = (id: string) => {
    const d = drag.current;
    if (!d || d.seen.has(id)) return;
    d.seen.add(id);
    if (d.mode) d.next.add(id);
    else d.next.delete(id);
    onChange(new Set(d.next));
  };

  const onDown = (e: PointerEvent) => {
    const id = idAt(e.clientX, e.clientY);
    if (!id) return;
    e.preventDefault();
    drag.current = { mode: !selected.has(id), seen: new Set(), next: new Set(selected) };
    apply(id);
  };
  const onMove = (e: PointerEvent) => {
    if (!drag.current) return;
    const id = idAt(e.clientX, e.clientY);
    if (id) apply(id);
  };

  useEffect(() => {
    const end = () => (drag.current = null);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
  }, []);

  let index = 0;
  return (
    <div
      ref={ref}
      className={`hand ${rows.length > 1 ? 'hand--two-rows' : ''}`}
      style={{ ['--card-w' as string]: `${cardW}px` }}
      onPointerDown={onDown}
      onPointerMove={onMove}
    >
      {rows.map((row, r) => {
        const step = stepFor(row.length);
        return (
          <div className="hand__row" key={r} style={{ width: cardW + step * Math.max(0, row.length - 1) }}>
            {row.map((card, i) => {
              const delay = index++ * 25;
              return (
                <div
                  key={`${dealKey}-${card.id}`}
                  data-card-id={card.id}
                  className={`hand__slot ${selected.has(card.id) ? 'is-selected' : ''} ${fresh?.has(card.id) ? 'is-fresh' : ''}`}
                  style={{ left: i * step, zIndex: i, animationDelay: `${delay}ms` }}
                >
                  <PlayingCard card={card} selected={selected.has(card.id)} style={{ ['--w' as string]: `${cardW}px` }} />
                </div>
              );
            })}
          </div>
        );
      })}
      {cards.length === 0 && <div className="hand__empty muted">手牌已出完</div>}
    </div>
  );
});
