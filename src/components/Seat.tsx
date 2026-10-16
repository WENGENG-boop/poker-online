import type { CSSProperties } from 'react';
import type { Role, SeatAction } from '../game/engine';
import type { ChatMessage, RoomPlayer } from '../net/protocol';
import { ChatBubble } from './Chat';
import { Avatar, KindTag, StatusDot } from './common';

interface SeatProps {
  player: RoomPlayer;
  cards: number;
  isTurn: boolean;
  /** 已出完牌时的名次 */
  rank: number | null;
  /** 斗地主身份 */
  role: Role | null;
  teammate: boolean;
  /** 剩余秒数，null 表示不限时 */
  remaining: number | null;
  totalSeconds: number;
  style?: CSSProperties;
  compact?: boolean;
  /** 发牌动画期间隐藏张数 */
  hideCount?: boolean;
  /** 由 AI 出牌（AI、模拟玩家、托管、掉线），轮到时显示"思考中" */
  thinking?: boolean;
  bidding?: boolean;
  chat?: ChatMessage;
}

export function rankLabel(rank: number) {
  return rank === 1 ? '赢家' : `第${['', '一', '二', '三', '四', '五', '六', '七', '八'][rank] ?? rank}名`;
}

export function Seat({ player, cards, isTurn, rank, role, teammate, remaining, totalSeconds, style, compact, hideCount, thinking, bidding, chat }: SeatProps) {
  const fan = Math.min(5, cards);
  const alert = !hideCount && rank === null && cards > 0 && cards <= 2 ? (cards === 1 ? '报单' : '报双') : null;
  return (
    <div
      className={`seat ${isTurn ? 'is-turn' : ''} ${rank !== null ? 'is-out' : ''} ${rank === 1 ? 'is-winner' : ''} ${role === 'landlord' ? 'is-landlord' : ''} ${compact ? 'seat--compact' : ''}`}
      style={style}
    >
      <div className="seat__top">
        <div className="seat__avatar">
          <Avatar name={player.name} kind={player.kind} size={compact ? 34 : 42} />
          <StatusDot online={player.online} />
          {role === 'landlord' && <span className="seat__crown">👑</span>}
        </div>
        <div className="seat__info">
          <div className="seat__name" title={player.name}>
            {player.name}
            <KindTag kind={player.kind} autoPlay={player.autoPlay} />
          </div>
          <div className="seat__meta">
            {role === 'landlord' && <span className="role role--landlord">地主</span>}
            {role === 'farmer' && <span className="role role--farmer">{teammate ? '农民 · 队友' : '农民'}</span>}
            {!role && <span className="muted">{player.online ? '在线' : '离线'}</span>}
          </div>
        </div>
      </div>
      {rank !== null ? (
        <div className={`seat__rank ${rank === 1 ? 'is-first' : ''}`}>{rank === 1 ? '🏆 赢家' : rankLabel(rank)}</div>
      ) : (
        <div className="seat__cards">
          <div className="seat__fan">
            {Array.from({ length: fan }, (_, i) => (
              <span key={i} className="seat__back" style={{ ['--i' as string]: i - (fan - 1) / 2 }} />
            ))}
          </div>
          <span className={`seat__count ${alert ? 'is-low' : ''}`}>{hideCount ? '…' : `${cards} 张`}</span>
        </div>
      )}
      {alert && <span className="seat__alert">{alert}</span>}
      {isTurn && (
        <div className="seat__turn">
          {remaining !== null && totalSeconds > 0 ? (
            <div className="timebar">
              <div className={`timebar__fill ${remaining <= 5 ? 'is-urgent' : ''}`} style={{ width: `${(remaining / totalSeconds) * 100}%` }} />
            </div>
          ) : null}
          {thinking ? (
            <span className="thinking">
              思考中
              <i />
              <i />
              <i />
            </span>
          ) : (
            <span>
              {bidding ? '叫地主中' : '出牌中'}
              {remaining !== null ? ` · ${Math.ceil(remaining)}s` : ''}
            </span>
          )}
        </div>
      )}
      <ChatBubble message={chat} className="chat-bubble--seat" />
    </div>
  );
}

export function ActionBubble({ action, style }: { action: SeatAction | undefined; style?: CSSProperties }) {
  if (!action || action.kind === 'play') return null;
  const text = action.kind === 'pass' ? '不要' : action.called ? (action.grab ? '抢地主' : '叫地主') : action.grab ? '不抢' : '不叫';
  const positive = action.kind === 'bid' && action.called;
  return (
    <div className={`pass-bubble ${positive ? 'pass-bubble--call' : ''}`} style={style} key={action.at}>
      {text}
    </div>
  );
}
