import { useState } from 'react';
import { ChatBubble, ChatButton, useChatBubbles, useChatSound } from '../components/Chat';
import { Avatar, KindTag, StatusDot } from '../components/common';
import { AILevel, AI_LEVEL_LABEL } from '../game/ai';
import { recommendedDecks } from '../game/cards';
import { GameMode, MODE_LABEL } from '../game/rules';
import { ChatPolicy, MAX_PLAYERS, MIN_PLAYERS, RoomConfig, ServerView } from '../net/protocol';
import { useRoom } from '../store/RoomContext';
import { useNow } from './GameTable';

const CHAT_LABEL: Record<ChatPolicy, string> = { full: '短语+表情+文字', preset: '仅短语和表情', off: '关闭' };

export function Lobby({ view }: { view: ServerView }) {
  const { send, leaveRoom, notify } = useRoom();
  const { room, you } = view;
  const now = useNow(500);
  const me = room.players.find((p) => p.id === you)!;
  const isHost = me?.isHost;
  const cfg = room.config;
  const ddz = cfg.mode === 'doudizhu';
  const humans = room.players.filter((p) => p.kind !== 'ai');
  const aiNeeded = Math.max(0, cfg.seatCount - humans.length);
  const notReady = humans.filter((p) => !p.ready && !p.isHost);
  const [copied, setCopied] = useState(false);
  const bubbles = useChatBubbles(room.chat, now);
  useChatSound(room.chat, you);

  const perDeck = cfg.withJokers ? 54 : 52;
  const total = perDeck * cfg.deckCount;
  const reserve = ddz ? (cfg.seatCount === 3 ? 3 : 8) : 0;
  const perPlayer = Math.floor((total - reserve) / cfg.seatCount);
  const leftover = total - perPlayer * cfg.seatCount;
  const maxSeats = ddz ? 4 : MAX_PLAYERS;

  const patch = (p: Partial<RoomConfig>) => send({ type: 'config', patch: p });

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      notify('复制失败，请手动复制', 'error');
    }
  };

  const inviteLink = `${location.origin}${location.pathname.replace(/\/admin\/?$/, '/')}?code=${room.code}`;

  return (
    <div className="lobby">
      <header className="topbar">
        <button className="btn btn--text" onClick={leaveRoom}>
          ← {isHost ? '解散房间' : '离开房间'}
        </button>
        <div className="topbar__title">
          {MODE_LABEL[cfg.mode]} · 房间 {room.code}
        </div>
        <ChatButton policy={cfg.chat} chat={room.chat} you={you} compact />
      </header>

      <section className="panel invite">
        <div>
          <div className="muted small">邀请码</div>
          <div className="invite__code">{room.code}</div>
        </div>
        <div className="invite__actions">
          <button className="btn btn--ghost" onClick={() => copy(room.code)}>
            {copied ? '已复制' : '复制邀请码'}
          </button>
          <button className="btn btn--ghost" onClick={() => copy(inviteLink)}>
            复制链接
          </button>
        </div>
      </section>

      <div className="lobby__grid">
        <section className="panel">
          <div className="panel__head">
            <h2>座位</h2>
            <span className="muted small">
              {humans.length} 名玩家 · {cfg.seatCount} 个座位
            </span>
          </div>
          <ul className="seats">
            {room.players.map((p, i) => (
              <li key={p.id} className={`seat-row ${p.id === you ? 'is-me' : ''}`}>
                <span className="seat-row__no">{i + 1}</span>
                <Avatar name={p.name} kind={p.kind} size={36} />
                <div className="seat-row__main">
                  <div className="seat-row__name">
                    {p.name}
                    {p.id === you && <span className="muted small">（你）</span>}
                    {p.isHost && <span className="tag tag--host">房主</span>}
                    <KindTag kind={p.kind} />
                  </div>
                  <div className="muted small">
                    <StatusDot online={p.online} /> {p.online ? '在线' : '离线'}
                    {p.kind === 'human' && !p.isHost && p.online && ` · ${p.latency || '-'}ms`}
                  </div>
                </div>
                <ChatBubble message={bubbles[p.id]} className="chat-bubble--row" />
                <span className={`ready ${p.ready || p.isHost ? 'ready--yes' : ''}`}>{p.isHost ? '房主' : p.ready ? '已准备' : '未准备'}</span>
                {isHost && !p.isHost && (
                  <button className="btn btn--icon" title="移出房间" onClick={() => send({ type: 'kick', targetId: p.id })}>
                    ✕
                  </button>
                )}
              </li>
            ))}
            {Array.from({ length: aiNeeded }, (_, i) => (
              <li key={'ai' + i} className="seat-row seat-row--empty">
                <span className="seat-row__no">{humans.length + i + 1}</span>
                <div className="avatar avatar--empty">+</div>
                <div className="seat-row__main">
                  <div className="seat-row__name muted">空座位</div>
                  <div className="muted small">开局时由 AI 自动补位</div>
                </div>
              </li>
            ))}
          </ul>
          {isHost && (
            <button className="btn btn--ghost btn--block" onClick={() => send({ type: 'addSimulated' })} disabled={humans.length >= maxSeats}>
              + 添加模拟玩家
            </button>
          )}
        </section>

        <section className="panel">
          <div className="panel__head">
            <h2>牌局设置</h2>
            {!isHost && <span className="muted small">仅房主可修改</span>}
          </div>
          <fieldset className="settings" disabled={!isHost}>
            <div className="setting setting--stack">
              <div>玩法</div>
              <div className="segmented">
                {(['paodekuai', 'doudizhu'] as GameMode[]).map((m) => (
                  <button key={m} className={cfg.mode === m ? 'is-active' : ''} onClick={() => patch({ mode: m })} disabled={m === 'doudizhu' && humans.length > 4}>
                    {MODE_LABEL[m]}
                  </button>
                ))}
              </div>
            </div>
            <div className="setting">
              <div>
                <div>玩家人数</div>
                <div className="muted small">
                  {ddz ? '斗地主支持 3 人或 4 人' : cfg.autoSeats ? '按真人数量自动调整（至少 3 人）' : '固定座位数，不足由 AI 补位'}
                </div>
              </div>
              <div className="stepper">
                <button onClick={() => patch({ seatCount: cfg.seatCount - 1 })} disabled={cfg.seatCount <= Math.max(MIN_PLAYERS, humans.length)}>
                  −
                </button>
                <span>{cfg.seatCount}</span>
                <button onClick={() => patch({ seatCount: cfg.seatCount + 1 })} disabled={cfg.seatCount >= maxSeats}>
                  +
                </button>
              </div>
            </div>
            <label className="setting setting--toggle">
              <span>自动座位数</span>
              <input type="checkbox" checked={cfg.autoSeats} onChange={(e) => patch({ autoSeats: e.target.checked })} />
            </label>
            {ddz ? (
              <div className="setting">
                <div>
                  <div>扑克牌</div>
                  <div className="muted small">斗地主固定：3 人 1 副、4 人 2 副，含大小王</div>
                </div>
                <span className="setting__value">{cfg.deckCount} 副</span>
              </div>
            ) : (
              <>
                <div className="setting">
                  <div>
                    <div>扑克牌副数</div>
                    <div className="muted small">
                      推荐 {recommendedDecks(cfg.seatCount)} 副
                      {cfg.deckManual && (
                        <button className="link-btn" onClick={() => patch({ deckManual: false })}>
                          恢复推荐
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="stepper">
                    <button onClick={() => patch({ deckCount: cfg.deckCount - 1 })} disabled={cfg.deckCount <= 1}>
                      −
                    </button>
                    <span>{cfg.deckCount}</span>
                    <button onClick={() => patch({ deckCount: cfg.deckCount + 1 })} disabled={cfg.deckCount >= 8}>
                      +
                    </button>
                  </div>
                </div>
                <label className="setting setting--toggle">
                  <span>
                    包含大小王 <span className="muted small">（每副 {cfg.withJokers ? 54 : 52} 张）</span>
                  </span>
                  <input type="checkbox" checked={cfg.withJokers} onChange={(e) => patch({ withJokers: e.target.checked })} />
                </label>
              </>
            )}
            <div className="setting">
              <div>
                <div>AI 难度</div>
                <div className="muted small">AI 在本地运行，无需额外配置</div>
              </div>
              <select value={cfg.aiLevel} onChange={(e) => patch({ aiLevel: e.target.value as AILevel })}>
                {(Object.keys(AI_LEVEL_LABEL) as AILevel[]).map((l) => (
                  <option key={l} value={l}>
                    {AI_LEVEL_LABEL[l]}
                  </option>
                ))}
              </select>
            </div>
            <div className="setting">
              <div>
                <div>出牌限时</div>
                <div className="muted small">超时自动托管</div>
              </div>
              <select value={cfg.turnSeconds} onChange={(e) => patch({ turnSeconds: Number(e.target.value) })}>
                {[0, 15, 20, 30, 45, 60].map((s) => (
                  <option key={s} value={s}>
                    {s ? `${s} 秒` : '不限时'}
                  </option>
                ))}
              </select>
            </div>
            <div className="setting">
              <div>
                <div>聊天</div>
                <div className="muted small">文字内容会自动审核</div>
              </div>
              <select value={cfg.chat} onChange={(e) => patch({ chat: e.target.value as ChatPolicy })}>
                {(Object.keys(CHAT_LABEL) as ChatPolicy[]).map((c) => (
                  <option key={c} value={c}>
                    {CHAT_LABEL[c]}
                  </option>
                ))}
              </select>
            </div>
          </fieldset>
          <div className="deal-summary">
            共 {total} 张 · 每人 {perPlayer} 张{leftover ? ` · ${ddz ? '底牌' : '余'} ${leftover} 张` : ''}
          </div>
          <details className="rules">
            <summary>{MODE_LABEL[cfg.mode]}规则</summary>
            {ddz ? (
              <ul>
                <li>发牌后从随机一位玩家开始轮流“叫地主 / 抢地主”，每人一次，最后叫或抢的人成为地主；无人叫则重新发牌。</li>
                <li>地主拿走底牌（公开）并先出，其余玩家为农民，农民之间是队友。</li>
                <li>牌型：单张、对子、三张、三带一、三带二、顺子（≥5）、连对（≥3 对）、飞机、四带二、炸弹、王炸。</li>
                <li>地主先出完则地主获胜；任一农民先出完则农民一方获胜，并列第一，其余按剩余牌数排名。</li>
              </ul>
            ) : (
              <ul>
                <li>大小：3 &lt; 4 &lt; … &lt; K &lt; A &lt; 2 &lt; 小王 &lt; 大王。</li>
                <li>牌型：单张、对子、三张、三带一、三带二、顺子（≥5）、连对（≥3 对）、飞机（可带单/对）、炸弹、王炸。</li>
                <li>跟牌需同牌型、同张数且更大；炸弹可压任意牌，张数多的炸弹更大。</li>
                <li>其他玩家都过牌后，最后出牌者重新领出；若其已出完，由下家接风。</li>
                <li>最先出完的是赢家，其余玩家继续打，依次决出第二名、第三名……</li>
              </ul>
            )}
          </details>
        </section>
      </div>

      <footer className="lobby__footer">
        {isHost ? (
          <>
            <span className="muted small">
              {notReady.length ? `等待 ${notReady.map((p) => p.name).join('、')} 准备` : aiNeeded ? `开局将加入 ${aiNeeded} 名 AI` : '全部就绪'}
            </span>
            <button className="btn btn--primary btn--lg" disabled={notReady.length > 0} onClick={() => send({ type: 'start' })}>
              开始游戏
            </button>
          </>
        ) : (
          <>
            <span className="muted small">{me.ready ? '等待房主开始游戏…' : '准备好后点击“准备”'}</span>
            <button className={`btn btn--lg ${me.ready ? 'btn--ghost' : 'btn--primary'}`} onClick={() => send({ type: 'ready', ready: !me.ready })}>
              {me.ready ? '取消准备' : '准备'}
            </button>
          </>
        )}
      </footer>
    </div>
  );
}
