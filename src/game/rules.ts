// 出牌规则，支持两种玩法与多副牌：
//  - paodekuai（跑得快）：最先出完者获胜
//  - doudizhu（斗地主）：在此基础上增加"四带二"牌型
//
// 牌型：单张、对子、三张、三带一、三带二（对）、顺子（≥5 张）、连对（≥3 对）、
//       飞机（≥2 组连续三张，可带同数量单张或对子）、炸弹（≥4 张同点）、王炸（大小王组合）。
// 点数：3 < 4 < … < K < A < 2 < 小王 < 大王；顺子、连对、飞机只能使用 3～A。
// 压牌：同牌型、同长度、主点数更大；炸弹可压任意非炸弹牌型；
//       炸弹之间张数多者大，张数相同比点数；王炸按王的张数折算为更高级的炸弹。

import { Card, RANK_BIG_JOKER, RANK_SMALL_JOKER, rankLabel } from './cards';

export type GameMode = 'paodekuai' | 'doudizhu';

export const MODE_LABEL: Record<GameMode, string> = { paodekuai: '跑得快', doudizhu: '斗地主' };

export type PatternType =
  | 'single'
  | 'pair'
  | 'triple'
  | 'triple_one'
  | 'triple_two'
  | 'straight'
  | 'pair_seq'
  | 'plane'
  | 'plane_single'
  | 'plane_pair'
  | 'four_two_single'
  | 'four_two_pair'
  | 'bomb'
  | 'rocket';

export interface Pattern {
  type: PatternType;
  /** 用来比较大小的主点数（顺子等取最高点） */
  mainRank: number;
  /** 组数：顺子张数 / 连对对数 / 飞机三张组数，其余为 1 */
  length: number;
  cardCount: number;
  /** 炸弹类的威力值，非炸弹为 0 */
  power: number;
}

export const PATTERN_LABEL: Record<PatternType, string> = {
  single: '单张',
  pair: '对子',
  triple: '三张',
  triple_one: '三带一',
  triple_two: '三带二',
  straight: '顺子',
  pair_seq: '连对',
  plane: '飞机',
  plane_single: '飞机带单',
  plane_pair: '飞机带对',
  four_two_single: '四带二',
  four_two_pair: '四带两对',
  bomb: '炸弹',
  rocket: '王炸',
};

export const MAX_SEQ_RANK = 14; // 顺子最高到 A

export function isBombLike(p: Pattern): boolean {
  return p.type === 'bomb' || p.type === 'rocket';
}

export function describePattern(p: Pattern): string {
  if (p.type === 'bomb') return `${p.cardCount}张${rankLabel(p.mainRank)}炸弹`;
  if (p.type === 'rocket') return p.cardCount > 2 ? `${p.cardCount}王炸` : '王炸';
  return PATTERN_LABEL[p.type];
}

export function countRanks(cards: readonly Card[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const c of cards) m.set(c.rank, (m.get(c.rank) ?? 0) + 1);
  return m;
}

function isConsecutive(ranks: number[]): boolean {
  for (let i = 1; i < ranks.length; i++) if (ranks[i] !== ranks[i - 1] + 1) return false;
  return true;
}

function make(type: PatternType, mainRank: number, length: number, cardCount: number, power = 0): Pattern {
  return { type, mainRank, length, cardCount, power };
}

export function bombPower(count: number, rank: number): number {
  return count * 100 + rank;
}

export function rocketPower(jokers: number): number {
  return (jokers * 2 + 1) * 100;
}

/**
 * 分析一组牌所有可能的牌型解释（例如 333444555666 既可视为四连飞机，也可视为三连飞机带单）。
 * 返回空数组表示不是合法牌型。按"优先解释"排序。
 */
export function analyze(cards: readonly Card[], mode: GameMode = 'paodekuai'): Pattern[] {
  const n = cards.length;
  if (n === 0) return [];
  const counts = countRanks(cards);
  const ranks = [...counts.keys()].sort((a, b) => a - b);
  const result: Pattern[] = [];

  // 王炸：只由王组成，且大小王都有
  if (n >= 2 && ranks.every((r) => r >= RANK_SMALL_JOKER) && counts.has(RANK_SMALL_JOKER) && counts.has(RANK_BIG_JOKER)) {
    return [make('rocket', RANK_BIG_JOKER, 1, n, rocketPower(n))];
  }

  if (ranks.length === 1) {
    const r = ranks[0];
    if (n === 1) result.push(make('single', r, 1, 1));
    else if (n === 2) result.push(make('pair', r, 1, 2));
    else if (n === 3) result.push(make('triple', r, 1, 3));
    else result.push(make('bomb', r, 1, n, bombPower(n, r)));
    return result;
  }

  const values = ranks.map((r) => counts.get(r)!);

  // 三带一 / 三带二
  if (n === 4 && ranks.length === 2) {
    const t = ranks.find((r) => counts.get(r) === 3);
    if (t !== undefined) result.push(make('triple_one', t, 1, 4));
  }
  if (n === 5 && ranks.length === 2) {
    const t = ranks.find((r) => counts.get(r) === 3);
    const p = ranks.find((r) => counts.get(r) === 2);
    if (t !== undefined && p !== undefined) result.push(make('triple_two', t, 1, 5));
  }

  // 顺子
  if (n >= 5 && values.every((v) => v === 1) && ranks[ranks.length - 1] <= MAX_SEQ_RANK && isConsecutive(ranks)) {
    result.push(make('straight', ranks[ranks.length - 1], n, n));
  }

  // 连对
  if (n >= 6 && values.every((v) => v === 2) && ranks[ranks.length - 1] <= MAX_SEQ_RANK && isConsecutive(ranks)) {
    result.push(make('pair_seq', ranks[ranks.length - 1], n / 2, n));
  }

  // 斗地主：四带二（两张单牌，或两对）
  if (mode === 'doudizhu') {
    const quads = ranks.filter((r) => counts.get(r) === 4).sort((a, b) => b - a);
    for (const q of quads) {
      const rest = ranks.filter((r) => r !== q).map((r) => counts.get(r)!);
      if (n === 6) {
        result.push(make('four_two_single', q, 1, 6));
        break;
      }
      if (n === 8 && (rest.every((v) => v === 2) || (rest.length === 1 && rest[0] === 4))) {
        result.push(make('four_two_pair', q, 1, 8));
        break;
      }
    }
  }

  // 飞机：寻找连续的三张段，剩余牌作翅膀
  const tripleCandidates = ranks.filter((r) => counts.get(r)! >= 3 && r <= MAX_SEQ_RANK);
  for (let k = Math.floor(n / 3); k >= 2; k--) {
    const wings = n - 3 * k;
    let wingType: PatternType | null = null;
    if (wings === 0) wingType = 'plane';
    else if (wings === k) wingType = 'plane_single';
    else if (wings === 2 * k) wingType = 'plane_pair';
    if (!wingType) continue;
    // 从高到低找长度为 k 的连续三张段
    for (let i = tripleCandidates.length - k; i >= 0; i--) {
      const seq = tripleCandidates.slice(i, i + k);
      if (!isConsecutive(seq)) continue;
      const rest = new Map(counts);
      for (const r of seq) rest.set(r, rest.get(r)! - 3);
      if (wingType === 'plane' && [...rest.values()].some((v) => v > 0)) continue;
      if (wingType === 'plane_pair' && [...rest.values()].some((v) => v % 2 !== 0)) continue;
      result.push(make(wingType, seq[seq.length - 1], k, n));
      break;
    }
  }

  return result;
}

export function primaryPattern(cards: readonly Card[], mode: GameMode = 'paodekuai'): Pattern | null {
  return analyze(cards, mode)[0] ?? null;
}

/** pattern 是否能压过 target */
export function beats(p: Pattern, target: Pattern): boolean {
  if (isBombLike(p)) {
    if (!isBombLike(target)) return true;
    return p.power > target.power;
  }
  if (isBombLike(target)) return false;
  return p.type === target.type && p.length === target.length && p.cardCount === target.cardCount && p.mainRank > target.mainRank;
}

/**
 * 判断一手牌能否打出：
 *  - target 为空（自己领出）时只要是合法牌型即可；
 *  - 否则需要任意一种解释能压过 target。
 * 返回实际采用的牌型，不合法返回 null。
 */
export function resolvePlay(cards: readonly Card[], target: Pattern | null, mode: GameMode = 'paodekuai'): Pattern | null {
  const options = analyze(cards, mode);
  if (!target) return options[0] ?? null;
  return options.find((p) => beats(p, target)) ?? null;
}
