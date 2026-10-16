import { describe, expect, it } from 'vitest';
import { decideBid, decideMove } from './ai';
import { Card, createDecks } from './cards';
import { GameState, dealNewGame, isOut, isTeammate, nextSeat, passTurn, placeBid, playCards, viewFor } from './engine';
import { analyze, beats, primaryPattern, resolvePlay } from './rules';

let uid = 0;
const c = (rank: number, suit: Card['suit'] = 'S'): Card => ({ id: `t${uid++}`, rank, suit, deck: 0 });
const cs = (...ranks: number[]) => ranks.map((r) => c(r));
const type = (cards: Card[]) => primaryPattern(cards)?.type ?? null;

describe('牌型识别', () => {
  it('基础牌型', () => {
    expect(type(cs(5))).toBe('single');
    expect(type(cs(5, 5))).toBe('pair');
    expect(type(cs(5, 5, 5))).toBe('triple');
    expect(type(cs(5, 5, 5, 9))).toBe('triple_one');
    expect(type(cs(5, 5, 5, 9, 9))).toBe('triple_two');
    expect(type(cs(5, 5, 5, 5))).toBe('bomb');
    expect(type(cs(3, 4, 5, 6, 7))).toBe('straight');
    expect(type(cs(10, 11, 12, 13, 14))).toBe('straight');
    expect(type(cs(3, 3, 4, 4, 5, 5))).toBe('pair_seq');
    expect(type(cs(3, 3, 3, 4, 4, 4))).toBe('plane');
    expect(type(cs(3, 3, 3, 4, 4, 4, 8, 9))).toBe('plane_single');
    expect(type(cs(3, 3, 3, 4, 4, 4, 8, 8, 9, 9))).toBe('plane_pair');
    expect(type([c(16, 'J'), c(17, 'J')])).toBe('rocket');
  });

  it('非法牌型', () => {
    expect(type(cs(5, 6))).toBeNull();
    expect(type(cs(11, 12, 13, 14, 15))).toBeNull(); // 顺子不能带 2
    expect(type(cs(3, 4, 5, 6))).toBeNull();
    expect(type(cs(3, 3, 4, 4))).toBeNull(); // 连对至少 3 对
  });

  it('多副牌的大炸弹', () => {
    const six = cs(7, 7, 7, 7, 7, 7);
    const four = cs(14, 14, 14, 14);
    expect(beats(primaryPattern(six)!, primaryPattern(four)!)).toBe(true);
  });

  it('一组牌有多种解释时可按目标牌型匹配', () => {
    const cards = cs(3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 6);
    const kinds = analyze(cards).map((p) => p.type);
    expect(kinds).toContain('plane');
    expect(kinds).toContain('plane_single');
  });

  it('压牌规则', () => {
    const target = primaryPattern(cs(9, 9))!;
    expect(resolvePlay(cs(10, 10), target)).not.toBeNull();
    expect(resolvePlay(cs(8, 8), target)).toBeNull();
    expect(resolvePlay(cs(10), target)).toBeNull();
    expect(resolvePlay(cs(4, 4, 4, 4), target)?.type).toBe('bomb');
    const straight = primaryPattern(cs(3, 4, 5, 6, 7))!;
    expect(resolvePlay(cs(4, 5, 6, 7, 8), straight)).not.toBeNull();
    expect(resolvePlay(cs(4, 5, 6, 7, 8, 9), straight)).toBeNull(); // 长度不同
    const rocket = primaryPattern([c(16, 'J'), c(17, 'J')])!;
    expect(beats(rocket, primaryPattern(cs(15, 15, 15, 15))!)).toBe(true);
  });
});

describe('引擎', () => {
  const seats = [
    { id: 'a', name: 'A', isAI: false },
    { id: 'b', name: 'B', isAI: true },
    { id: 'c', name: 'C', isAI: true },
  ];

  it('发牌：张数正确且不重复', () => {
    const g = dealNewGame({ seats, deckCount: 1, withJokers: true, round: 1 });
    const all = Object.values(g.hands).flat();
    expect(all.length).toBe(54);
    expect(new Set(all.map((x) => x.id)).size).toBe(54);
    for (const s of seats) expect(g.hands[s.id].length).toBe(18);
    const g2 = dealNewGame({ seats: [...seats, { id: 'd', name: 'D', isAI: true }], deckCount: 2, withJokers: false, round: 1 });
    expect(g2.leftover.length).toBe(0);
    expect(g2.hands.a.length).toBe(26);
  });

  it('视图只暴露自己的手牌', () => {
    const g = dealNewGame({ seats, deckCount: 1, withJokers: true, round: 1 });
    const v = viewFor(g, 'a');
    expect(v.myHand.length).toBe(18);
    expect(JSON.stringify(v)).not.toContain(g.hands.b[0].id + '"');
    expect(v.revealedHands).toBeNull();
  });

  it('领出者不能过牌，非当前玩家不能出牌', () => {
    const g = dealNewGame({ seats, deckCount: 1, withJokers: true, round: 1 });
    const cur = g.seats[g.turn].id;
    expect(() => passTurn(g, cur)).toThrow();
    const other = g.seats[(g.turn + 1) % 3].id;
    expect(() => playCards(g, other, [g.hands[other][0].id])).toThrow();
  });

  it('跑得快：全部由 AI 打完，依次决出所有名次', () => {
    for (let round = 0; round < 40; round++) {
      const deckCount = 1 + (round % 3);
      const n = 3 + (round % 4);
      const ss = Array.from({ length: n }, (_, i) => ({ id: 'p' + i, name: 'P' + i, isAI: true }));
      let g = dealNewGame({ seats: ss, deckCount, withJokers: round % 2 === 0, round: 1 });
      let steps = 0;
      while (g.phase === 'playing') {
        g = autoStep(g);
        if (++steps > 8000) throw new Error('死循环');
      }
      expect(g.finishOrder.length).toBe(n - 1);
      expect(g.hands[g.seats[g.winnerSeat!].id].length).toBe(0);
      // 名次 1..n 各一个
      expect(g.settlement!.map((r) => r.rank).sort((x, y) => x - y)).toEqual(Array.from({ length: n }, (_, i) => i + 1));
      expect(g.settlement![0].playerId).toBe(g.seats[g.finishOrder[0]].id);
    }
  });

  it('跑得快：出完牌后无人能压时由下家接风', () => {
    const ss = ['a', 'b', 'c', 'd'].map((id) => ({ id, name: id, isAI: false }));
    let g = dealNewGame({ seats: ss, deckCount: 1, withJokers: false, round: 1 });
    // 构造：a 只剩一张 2
    g = { ...g, turn: 0, hands: { a: cs(15), b: cs(3, 4), c: cs(5, 6), d: cs(7, 8) } };
    g = playCards(g, 'a', [g.hands.a[0].id], g.turnStartedAt);
    expect(g.finishOrder).toEqual([0]);
    expect(g.phase).toBe('playing');
    expect(g.turn).toBe(1);
    g = passTurn(g, 'b');
    g = passTurn(g, 'c');
    g = passTurn(g, 'd');
    // a 已出完，由其下家 b 领出
    expect(g.lastPlay).toBeNull();
    expect(g.turn).toBe(1);
  });

  it('牌堆构建', () => {
    expect(createDecks(3, true).length).toBe(162);
  });
});

/** 由 AI 走一步（叫地主或出牌） */
function autoStep(g: GameState): GameState {
  const id = g.seats[g.turn].id;
  if (g.phase === 'bidding') return placeBid(g, id, decideBid(g.hands[id], g.bidding!.candidate !== null), g.turnStartedAt);
  const next = nextSeat(g, g.turn);
  const opponents = g.seats.map((_, i) => i).filter((i) => !isTeammate(g, i, g.turn) && !isOut(g, i));
  const move = decideMove({
    hand: g.hands[id],
    target: g.lastPlay?.pattern ?? null,
    minOpponentCards: Math.min(...opponents.map((i) => g.hands[g.seats[i].id].length)),
    nextPlayerCards: g.hands[g.seats[next].id].length,
    mode: g.mode,
    teammateOnTop: g.lastPlay !== null && g.lastPlay.seat !== g.turn && isTeammate(g, g.lastPlay.seat, g.turn),
    nextIsTeammate: isTeammate(g, next, g.turn),
  });
  return move ? playCards(g, id, move.map((x) => x.id), g.turnStartedAt) : passTurn(g, id, g.turnStartedAt);
}

describe('斗地主', () => {
  const three = ['a', 'b', 'c'].map((id) => ({ id, name: id, isAI: true }));

  it('四带二牌型', () => {
    expect(primaryPattern(cs(9, 9, 9, 9, 3, 5), 'doudizhu')?.type).toBe('four_two_single');
    expect(primaryPattern(cs(9, 9, 9, 9, 3, 3, 5, 5), 'doudizhu')?.type).toBe('four_two_pair');
    expect(primaryPattern(cs(9, 9, 9, 9, 3, 5), 'paodekuai')).toBeNull();
  });

  it('发牌：3 人每人 17 张 + 3 张底牌；4 人 2 副每人 25 张 + 8 张底牌', () => {
    const g = dealNewGame({ mode: 'doudizhu', seats: three, deckCount: 1, withJokers: true, round: 1 });
    expect(g.phase).toBe('bidding');
    for (const s of three) expect(g.hands[s.id].length).toBe(17);
    expect(g.leftover.length).toBe(3);
    expect(viewFor(g, 'a').leftover).toBeNull(); // 叫地主前看不到底牌
    const four = ['a', 'b', 'c', 'd'].map((id) => ({ id, name: id, isAI: true }));
    const g4 = dealNewGame({ mode: 'doudizhu', seats: four, deckCount: 2, withJokers: true, round: 1 });
    for (const s of four) expect(g4.hands[s.id].length).toBe(25);
    expect(g4.leftover.length).toBe(8);
  });

  it('叫地主 / 抢地主：最后叫或抢的人成为地主并拿到底牌', () => {
    let g = dealNewGame({ mode: 'doudizhu', seats: three, deckCount: 1, withJokers: true, round: 1 });
    g = { ...g, turn: 0 };
    g = placeBid(g, 'a', true, g.turnStartedAt);
    g = placeBid(g, 'b', true, g.turnStartedAt); // 抢地主
    expect(g.seatActions[1]).toMatchObject({ kind: 'bid', called: true, grab: true });
    g = placeBid(g, 'c', false, g.turnStartedAt);
    expect(g.phase).toBe('playing');
    expect(g.landlordSeat).toBe(1);
    expect(g.hands.b.length).toBe(20);
    expect(g.turn).toBe(1);
    expect(viewFor(g, 'a').leftover?.length).toBe(3);
  });

  it('无人叫地主时标记重新发牌', () => {
    let g = dealNewGame({ mode: 'doudizhu', seats: three, deckCount: 1, withJokers: true, round: 1 });
    for (let i = 0; i < 3; i++) g = placeBid(g, g.seats[g.turn].id, false, g.turnStartedAt);
    expect(g.bidding!.allPassed).toBe(true);
  });

  it('AI 对局能正常结束，获胜一方并列第一', () => {
    for (let round = 0; round < 30; round++) {
      const ss = round % 2 ? three : ['a', 'b', 'c', 'd'].map((id) => ({ id, name: id, isAI: true }));
      let g = dealNewGame({ mode: 'doudizhu', seats: ss, deckCount: ss.length === 3 ? 1 : 2, withJokers: true, round: 1 });
      let steps = 0;
      while (g.phase !== 'finished') {
        if (g.bidding?.allPassed) g = dealNewGame({ mode: 'doudizhu', seats: ss, deckCount: ss.length === 3 ? 1 : 2, withJokers: true, round: 1 });
        else g = autoStep(g);
        if (++steps > 8000) throw new Error('死循环');
      }
      const landlordWon = g.winnerSeat === g.landlordSeat;
      expect(g.winners!.length).toBe(landlordWon ? 1 : ss.length - 1);
      for (const w of g.winners!) expect(g.settlement!.find((r) => r.playerId === g.seats[w].id)!.rank).toBe(1);
    }
  });
});
