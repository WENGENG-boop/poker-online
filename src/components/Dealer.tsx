// 开局动画：牌堆落桌 → 展开验牌 → 交错洗牌 → 手洗 → 切牌 → 再交错 → 理齐 → 逐张发牌

import { CSSProperties, useEffect, useRef, useState } from 'react';
import { playSound } from '../ui/sound';
import { PlayingCard } from './PlayingCard';

export interface Point {
  x: number;
  y: number;
}

interface Props {
  /** 按发牌顺序排列的目标位置（百分比） */
  targets: Point[];
  /** targets 中哪一个是"我" */
  meIndex: number;
  totalCards: number;
  /** 发到我手里的进度 0~1 */
  onMyProgress(fraction: number): void;
  onDone(): void;
}

type Phase = 'drop' | 'fan' | 'fanBack' | 'split' | 'merge' | 'over0' | 'over1' | 'over2' | 'overBack' | 'cut' | 'cutStack' | 'square' | 'deal';

/** 动画时间线（毫秒）。总时长需与服务器端 DEAL_ANIMATION_MS 匹配 */
const TIMELINE: Array<[Phase, number]> = [
  ['drop', 800],
  ['fan', 550],
  ['fanBack', 350],
  ['split', 330],
  ['merge', 330],
  ['split', 330],
  ['merge', 330],
  ['over0', 300],
  ['over1', 300],
  ['over2', 300],
  ['overBack', 250],
  ['cut', 450],
  ['cutStack', 450],
  ['split', 330],
  ['merge', 330],
  ['square', 300],
];
const T_DEAL = 1700;
const FLY_MS = 480;
const STACK = 24;

const LABEL: Record<Phase, string> = {
  drop: '牌堆落桌',
  fan: '展开验牌',
  fanBack: '展开验牌',
  split: '交错洗牌',
  merge: '交错洗牌',
  over0: '手洗',
  over1: '手洗',
  over2: '手洗',
  overBack: '手洗',
  cut: '切牌',
  cutStack: '切牌',
  square: '理牌',
  deal: '发牌',
};

/** 每张牌在各阶段的位置 */
function cardStyle(phase: Phase, i: number, n: number): CSSProperties {
  const lift = -0.7 * i;
  const side = i % 2 ? 1 : -1;
  let transform = `translate(${-0.3 * i}px, ${lift}px)`;
  let duration = 0.3;
  let delay = i * 6;
  switch (phase) {
    case 'fan':
      transform = `translate(0, ${lift}px) rotate(${(i - (n - 1) / 2) * 6.5}deg)`;
      duration = 0.5;
      delay = i * 10;
      break;
    case 'split':
      transform = `translate(${side * 66}px, ${lift}px) rotate(${side * 8}deg)`;
      break;
    case 'merge':
      transform = `translate(${side * 4}px, ${lift - 6}px) rotate(${-side * 2}deg)`;
      delay = (n - i) * 7;
      break;
    case 'over0':
    case 'over1':
    case 'over2': {
      const k = Number(phase.slice(-1));
      const size = Math.ceil(n / 4);
      const start = n - (k + 1) * size;
      if (i >= start && i < start + size) transform = `translate(${k % 2 ? -80 : 80}px, ${lift - 48}px) rotate(${k % 2 ? -14 : 14}deg)`;
      delay = 0;
      break;
    }
    case 'cut': {
      const pile = Math.min(2, Math.floor((i * 3) / n));
      transform = `translate(${(pile - 1) * 88}px, ${-0.7 * (i - (pile * n) / 3)}px)`;
      delay = pile * 60;
      break;
    }
    case 'cutStack': {
      const pile = Math.min(2, Math.floor((i * 3) / n));
      delay = (2 - pile) * 90;
      break;
    }
  }
  return { transform, transition: `transform ${duration}s cubic-bezier(0.4, 0, 0.2, 1) ${delay}ms`, ['--i' as string]: i, ['--side' as string]: side };
}

export function Dealer({ targets, meIndex, totalCards, onMyProgress, onDone }: Props) {
  const [phase, setPhase] = useState<Phase>('drop');
  const [dealt, setDealt] = useState(0);
  const cb = useRef({ onMyProgress, onDone });
  cb.current = { onMyProgress, onDone };

  const n = targets.length;
  // 牌太多时一次飞行代表多张，保证发牌节奏一致
  const flights = Math.max(n, Math.min(totalCards, 72));

  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    let t = 0;
    TIMELINE.forEach(([p, dur], idx) => {
      if (idx > 0) {
        timers.push(
          setTimeout(() => {
            setPhase(p);
            if (p === 'split' || p === 'merge' || p === 'fan' || p.startsWith('over') || p === 'cutStack') playSound('shuffle');
          }, t),
        );
      }
      t += dur;
    });
    timers.push(setTimeout(() => setPhase('deal'), t));
    playSound('shuffle');
    return () => timers.forEach(clearTimeout);
  }, []);

  useEffect(() => {
    if (phase !== 'deal') return;
    const step = T_DEAL / flights;
    let i = 0;
    let lastMine = -1;
    const timer = setInterval(() => {
      i++;
      setDealt(i);
      if (i % 2 === 1) playSound('deal');
      const mine = Math.max(0, Math.floor((i - 1 - meIndex) / n) + 1);
      if (mine !== lastMine) {
        lastMine = mine;
        cb.current.onMyProgress(Math.min(1, mine / Math.ceil(flights / n)));
      }
      if (i >= flights) {
        clearInterval(timer);
        setTimeout(() => cb.current.onDone(), FLY_MS);
      }
    }, step);
    return () => clearInterval(timer);
  }, [phase, flights, meIndex, n]);

  const remainingStack = phase === 'deal' ? Math.ceil(STACK * (1 - dealt / flights)) : STACK;
  const flying: number[] = [];
  if (phase === 'deal') {
    const keep = Math.ceil(FLY_MS / (T_DEAL / flights)) + 1;
    for (let i = Math.max(0, dealt - keep); i < dealt; i++) flying.push(i);
  }

  const label = phase === 'deal' ? `发牌中 ${Math.min(dealt, flights)}/${flights}` : LABEL[phase];

  return (
    <div className="dealer" aria-hidden>
      <div className={`deck ${phase === 'drop' ? 'deck--drop' : ''}`}>
        {Array.from({ length: remainingStack }, (_, i) => (
          <PlayingCard key={i} back size="md" className="deck__card" style={cardStyle(phase, i, STACK)} />
        ))}
      </div>
      {flying.map((i) => {
        const to = targets[i % n];
        return (
          <PlayingCard
            key={i}
            back
            size="sm"
            className="fly-card"
            style={{ ['--tx' as string]: String(to.x), ['--ty' as string]: String(to.y), ['--rot' as string]: `${(i % 2 ? 1 : -1) * 200}deg` }}
          />
        );
      })}
      <div key={LABEL[phase]} className="dealer__label">
        {label}
      </div>
    </div>
  );
}
