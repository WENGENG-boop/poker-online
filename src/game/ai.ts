// AI 出牌：枚举手牌可组成的牌型，按启发式代价选择出牌或过牌。
// 纯本地规则，不依赖任何外部服务；支持三档难度与斗地主的阵营配合。

import { Card, RANK_BIG_JOKER, RANK_SMALL_JOKER, RANK_TWO, sortByRank } from './cards';
import { GameMode, MAX_SEQ_RANK, Pattern, analyze, beats, isBombLike, primaryPattern } from './rules';

export type AILevel = 'easy' | 'normal' | 'hard';

export const AI_LEVEL_LABEL: Record<AILevel, string> = { easy: '简单', normal: '普通', hard: '困难' };

export interface Move {
  cards: Card[];
  pattern: Pattern;
}

export interface AIContext {
  hand: Card[];
  /** 需要压过的牌型，null 表示自己领出 */
  target: Pattern | null;
  /** 对手中最少的剩余手牌数（用于判断是否需要拦截） */
  minOpponentCards: number;
  /** 下家剩余手牌数 */
  nextPlayerCards: number;
  mode?: GameMode;
  level?: AILevel;
  /** 桌面最大牌是队友出的（斗地主农民） */
  teammateOnTop?: boolean;
  /** 下家是队友 */
  nextIsTeammate?: boolean;
}

function groupByRank(hand: Card[]): Map<number, Card[]> {
  const m = new Map<number, Card[]>();
  for (const c of sortByRank(hand)) {
    if (!m.has(c.rank)) m.set(c.rank, []);
    m.get(c.rank)!.push(c);
  }
  return m;
}

/** 枚举手牌中所有"有代表性"的出牌组合 */
export function generateMoves(hand: Card[], mode: GameMode = 'paodekuai'): Move[] {
  const groups = groupByRank(hand);
  const ranks = [...groups.keys()].sort((a, b) => a - b);
  const moves: Move[] = [];
  const push = (cards: Card[] | null) => {
    if (!cards) return;
    const pattern = primaryPattern(cards, mode);
    if (pattern) moves.push({ cards, pattern });
  };

  // 选取用于带牌的最小单张 / 对子（尽量不拆大组）
  const kickers = (exclude: Set<number>, size: 1 | 2, count: number): Card[] | null => {
    const pool = ranks
      .filter((r) => !exclude.has(r) && groups.get(r)!.length >= size && r < RANK_SMALL_JOKER)
      .sort((a, b) => groups.get(a)!.length - groups.get(b)!.length || a - b);
    if (pool.length < count) return null;
    return pool.slice(0, count).flatMap((r) => groups.get(r)!.slice(0, size));
  };

  for (const r of ranks) {
    const g = groups.get(r)!;
    push([g[0]]);
    if (g.length >= 2) push(g.slice(0, 2));
    if (g.length >= 3) {
      const t = g.slice(0, 3);
      push(t);
      const one = kickers(new Set([r]), 1, 1);
      if (one) push([...t, ...one]);
      const two = kickers(new Set([r]), 2, 1);
      if (two) push([...t, ...two]);
    }
    for (let size = 4; size <= g.length; size++) push(g.slice(0, size));
    if (mode === 'doudizhu' && g.length === 4) {
      const ones = kickers(new Set([r]), 1, 2);
      if (ones) push([...g, ...ones]);
      const twos = kickers(new Set([r]), 2, 2);
      if (twos) push([...g, ...twos]);
    }
  }

  // 顺子 / 连对 / 飞机
  const seqRanks = ranks.filter((r) => r <= MAX_SEQ_RANK);
  const runs = (minCount: number, minLen: number, take: number) => {
    for (let i = 0; i < seqRanks.length; i++) {
      const seq: number[] = [];
      for (let j = i; j < seqRanks.length; j++) {
        if (groups.get(seqRanks[j])!.length < minCount) break;
        if (seq.length && seqRanks[j] !== seq[seq.length - 1] + 1) break;
        seq.push(seqRanks[j]);
        if (seq.length >= minLen) {
          const base = seq.flatMap((r) => groups.get(r)!.slice(0, take));
          push(base);
          if (take === 3) {
            const ex = new Set(seq);
            const ones = kickers(ex, 1, seq.length);
            if (ones) push([...base, ...ones]);
            const twos = kickers(ex, 2, seq.length);
            if (twos) push([...base, ...twos]);
          }
        }
      }
    }
  };
  runs(1, 5, 1);
  runs(2, 3, 2);
  runs(3, 2, 3);

  // 王炸
  const jokers = hand.filter((c) => c.rank >= RANK_SMALL_JOKER);
  if (jokers.some((c) => c.rank === RANK_SMALL_JOKER) && jokers.some((c) => c.rank === RANK_BIG_JOKER)) {
    push(jokers);
  }
  return moves;
}

/** 出牌代价：越低越优先。拆炸弹、拆三张、出大牌都会增加代价 */
function moveCost(move: Move, hand: Card[]): number {
  const groups = groupByRank(hand);
  let cost = move.pattern.mainRank * 2;
  const used = new Map<number, number>();
  for (const c of move.cards) used.set(c.rank, (used.get(c.rank) ?? 0) + 1);
  for (const [r, n] of used) {
    const total = groups.get(r)!.length;
    if (n < total) {
      cost += total >= 4 ? 40 : total === 3 ? 8 : 4; // 拆牌惩罚
    }
  }
  if (isBombLike(move.pattern)) cost += 60 + move.pattern.power / 20;
  if (move.pattern.type === 'four_two_single' || move.pattern.type === 'four_two_pair') cost += 30;
  // 多出牌更好
  cost -= move.cards.length * 3;
  return cost;
}

function legalMoves(hand: Card[], target: Pattern, mode: GameMode): Move[] {
  return generateMoves(hand, mode)
    .map((m) => {
      const p = analyze(m.cards, mode).find((x) => beats(x, target));
      return p ? { cards: m.cards, pattern: p } : null;
    })
    .filter((m): m is Move => m !== null);
}

/** AI 决策：返回要出的牌，或 null 表示过牌 */
export function decideMove(ctx: AIContext): Card[] | null {
  const { hand, target } = ctx;
  const mode = ctx.mode ?? 'paodekuai';
  const level = ctx.level ?? 'normal';
  if (hand.length === 0) return null;

  // 一手能出完直接出
  const whole = analyze(hand, mode);
  if (whole.length && (!target || whole.some((p) => beats(p, target)))) return hand;

  const moves = generateMoves(hand, mode);
  const danger = ctx.minOpponentCards <= (level === 'hard' ? 3 : 2);

  if (!target) {
    let candidates = moves.filter((m) => !isBombLike(m.pattern));
    if (!candidates.length) candidates = moves;
    // 下家是队友且只剩 1 张：送一张最小单牌
    if (ctx.nextIsTeammate && ctx.nextPlayerCards === 1) return [sortByRank(hand)[0]];
    // 下家是对手且只剩 1 张时避免出小单张
    if (ctx.nextPlayerCards === 1 && !ctx.nextIsTeammate) {
      const nonSingle = candidates.filter((m) => m.pattern.type !== 'single');
      if (nonSingle.length) candidates = nonSingle;
      else return [sortByRank(hand)[hand.length - 1]];
    }
    if (level === 'easy' && Math.random() < 0.35) return candidates[Math.floor(Math.random() * candidates.length)].cards;
    candidates.sort((a, b) => moveCost(a, hand) - moveCost(b, hand));
    return candidates[0].cards;
  }

  // 队友的牌最大时不去压，除非对手快出完且队友的牌不够大
  if (ctx.teammateOnTop) {
    if (!(danger && target.mainRank < 12 && level === 'hard')) return null;
  }

  const legal = legalMoves(hand, target, mode);
  if (!legal.length) return null;

  if (level === 'easy' && Math.random() < 0.3) return null;

  const normal = legal.filter((m) => !isBombLike(m.pattern));
  if (normal.length) {
    normal.sort((a, b) => moveCost(a, hand) - moveCost(b, hand));
    const best = normal[0];
    // 压大牌（2 及以上）时如果局势不紧张、手牌还多，偶尔保留
    const holdChance = level === 'hard' ? 0.25 : 0.5;
    if (!danger && best.pattern.mainRank >= RANK_TWO && hand.length > 8 && Math.random() < holdChance) return null;
    return best.cards;
  }

  // 只能用炸弹：对手快出完了，或自己手牌不多时才炸
  const bombChance = level === 'easy' ? 0.1 : level === 'hard' ? 0.15 : 0.25;
  if (danger || hand.length <= 6 || Math.random() < bombChance) {
    legal.sort((a, b) => a.pattern.power - b.pattern.power);
    return legal[0].cards;
  }
  return null;
}

/** 手牌强度评估（用于叫地主） */
export function handStrength(hand: Card[]): number {
  const groups = groupByRank(hand);
  let score = 0;
  for (const [rank, cards] of groups) {
    if (rank === RANK_BIG_JOKER) score += 4 * cards.length;
    else if (rank === RANK_SMALL_JOKER) score += 3 * cards.length;
    else if (rank === RANK_TWO) score += 2 * cards.length;
    else if (rank === 14) score += cards.length;
    if (cards.length >= 4) score += 4;
  }
  if (groups.has(RANK_BIG_JOKER) && groups.has(RANK_SMALL_JOKER)) score += 2;
  return score;
}

/** AI 叫地主：someoneCalled 为 true 时表示是否"抢地主" */
export function decideBid(hand: Card[], someoneCalled: boolean, level: AILevel = 'normal'): boolean {
  const s = handStrength(hand) + (level === 'easy' ? Math.random() * 4 - 2 : 0);
  return someoneCalled ? s >= (level === 'hard' ? 8 : 9) : s >= 6;
}

/** 给真人玩家的"提示"：返回所有可压过 target 的出牌，按代价排序 */
export function hintMoves(hand: Card[], target: Pattern | null, mode: GameMode = 'paodekuai'): Card[][] {
  const moves = generateMoves(hand, mode);
  const legal = target ? moves.filter((m) => analyze(m.cards, mode).some((p) => beats(p, target))) : moves;
  const seen = new Set<string>();
  return legal
    .sort((a, b) => moveCost(a, hand) - moveCost(b, hand))
    .map((m) => m.cards)
    .filter((cards) => {
      const key = cards.map((c) => c.id).sort().join(',');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
