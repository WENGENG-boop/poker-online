// 扑克牌基础模型：牌面、整副牌生成、洗牌与排序

export type Suit = 'S' | 'H' | 'C' | 'D' | 'J';

/** 点数权重：3 最小 … A=14, 2=15, 小王=16, 大王=17 */
export type Rank = number;

export interface Card {
  /** 全局唯一 id，多副牌时也不会重复，例如 "d1-H-12" */
  id: string;
  suit: Suit;
  rank: Rank;
  /** 第几副牌（从 0 开始） */
  deck: number;
}

export const RANK_TWO = 15;
export const RANK_SMALL_JOKER = 16;
export const RANK_BIG_JOKER = 17;

const SUIT_ORDER: Record<Suit, number> = { D: 0, C: 1, H: 2, S: 3, J: 4 };

export const SUIT_SYMBOL: Record<Suit, string> = { S: '♠', H: '♥', C: '♣', D: '♦', J: '' };

export function rankLabel(rank: Rank): string {
  if (rank <= 10) return String(rank);
  return ({ 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2', 16: '小王', 17: '大王' } as Record<number, string>)[rank];
}

export function isRed(card: Card): boolean {
  return card.suit === 'H' || card.suit === 'D' || card.rank === RANK_BIG_JOKER;
}

export function cardName(card: Card): string {
  if (card.suit === 'J') return rankLabel(card.rank);
  return SUIT_SYMBOL[card.suit] + rankLabel(card.rank);
}

export function createDecks(deckCount: number, withJokers: boolean): Card[] {
  const cards: Card[] = [];
  for (let d = 0; d < deckCount; d++) {
    for (const suit of ['S', 'H', 'C', 'D'] as Suit[]) {
      for (let rank = 3; rank <= 15; rank++) {
        cards.push({ id: `d${d}-${suit}-${rank}`, suit, rank, deck: d });
      }
    }
    if (withJokers) {
      cards.push({ id: `d${d}-J-16`, suit: 'J', rank: RANK_SMALL_JOKER, deck: d });
      cards.push({ id: `d${d}-J-17`, suit: 'J', rank: RANK_BIG_JOKER, deck: d });
    }
  }
  return cards;
}

function randomInt(max: number): number {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return buf[0] % max;
  }
  return Math.floor(Math.random() * max);
}

/** Fisher–Yates 洗牌，返回新数组 */
export function shuffle<T>(items: readonly T[]): T[] {
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function compareCards(a: Card, b: Card): number {
  return a.rank - b.rank || SUIT_ORDER[a.suit] - SUIT_ORDER[b.suit] || a.deck - b.deck;
}

/** 按点数从小到大排序 */
export function sortByRank(cards: readonly Card[]): Card[] {
  return cards.slice().sort(compareCards);
}

/** 整理手牌：把相同点数多的牌放前面（炸弹、三张聚在一起），同数量再按点数 */
export function sortByGroup(cards: readonly Card[]): Card[] {
  const counts = new Map<number, number>();
  for (const c of cards) counts.set(c.rank, (counts.get(c.rank) ?? 0) + 1);
  return cards
    .slice()
    .sort((a, b) => (counts.get(b.rank)! - counts.get(a.rank)!) || compareCards(a, b));
}

/** 推荐的牌副数 */
export function recommendedDecks(players: number): number {
  if (players <= 3) return 1;
  if (players <= 5) return 2;
  return 3;
}
