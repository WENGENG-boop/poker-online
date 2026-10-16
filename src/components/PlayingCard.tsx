import { CSSProperties, memo } from 'react';
import { Card, RANK_BIG_JOKER, SUIT_SYMBOL, isRed, rankLabel } from '../game/cards';

interface Props {
  card?: Card;
  /** 背面朝上 */
  back?: boolean;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  selected?: boolean;
  hinted?: boolean;
  className?: string;
  style?: CSSProperties;
}

export const PlayingCard = memo(function PlayingCard({ card, back, size = 'md', selected, hinted, className = '', style }: Props) {
  const cls = ['pcard', `pcard--${size}`, className];
  if (back || !card) {
    cls.push('pcard--back');
    return <div className={cls.join(' ')} style={style} aria-label="牌背" />;
  }
  if (isRed(card)) cls.push('pcard--red');
  if (selected) cls.push('is-selected');
  if (hinted) cls.push('is-hinted');

  if (card.suit === 'J') {
    cls.push('pcard--joker');
    const big = card.rank === RANK_BIG_JOKER;
    return (
      <div className={cls.join(' ')} style={style} aria-label={big ? '大王' : '小王'}>
        <span className="pcard__joker">JOKER</span>
        <span className="pcard__joker-mark">{big ? '★' : '☆'}</span>
      </div>
    );
  }

  const label = rankLabel(card.rank);
  const suit = SUIT_SYMBOL[card.suit];
  return (
    <div className={cls.join(' ')} style={style} aria-label={suit + label}>
      <span className="pcard__corner">
        <span className="pcard__rank">{label}</span>
        <span className="pcard__suit">{suit}</span>
      </span>
      <span className="pcard__pip">{suit}</span>
    </div>
  );
});
