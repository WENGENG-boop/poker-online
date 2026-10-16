// 快捷聊天：预设短语、表情、审核后的短文字；支持屏蔽某位玩家

import { FormEvent, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { EMOJIS, MAX_TEXT_LENGTH, QUICK_PHRASES, checkText } from '../net/moderation';
import type { ChatMessage, ChatPolicy } from '../net/protocol';
import { useRoom } from '../store/RoomContext';
import { playSound } from '../ui/sound';

// ---------------------------------------------------------------- 屏蔽列表（仅当前标签页）

const blocked = new Set<string>();
const blockListeners = new Set<() => void>();
let blockVersion = 0;
export const blockStore = {
  toggle(id: string) {
    if (blocked.has(id)) blocked.delete(id);
    else blocked.add(id);
    blockVersion++;
    blockListeners.forEach((l) => l());
  },
  has: (id: string) => blocked.has(id),
  subscribe(l: () => void) {
    blockListeners.add(l);
    return () => void blockListeners.delete(l);
  },
};
export function useBlockVersion() {
  return useSyncExternalStore(blockStore.subscribe, () => blockVersion);
}

/** 每位玩家最近 4 秒内的一条消息，用于在座位旁显示气泡 */
export function useChatBubbles(chat: ChatMessage[], now: number): Record<string, ChatMessage> {
  useBlockVersion();
  const map: Record<string, ChatMessage> = {};
  for (const m of chat) if (now - m.at < 4000 && !blockStore.has(m.playerId)) map[m.playerId] = m;
  return map;
}

/** 新消息提示音（不含自己的消息） */
export function useChatSound(chat: ChatMessage[], you: string) {
  const last = useRef(chat[chat.length - 1]?.id);
  useEffect(() => {
    const m = chat[chat.length - 1];
    if (m && m.id !== last.current && m.playerId !== you && !blockStore.has(m.playerId)) playSound('select');
    last.current = m?.id;
  }, [chat, you]);
}

export function ChatBubble({ message, className = '' }: { message: ChatMessage | undefined; className?: string }) {
  if (!message) return null;
  return (
    <div key={message.id} className={`chat-bubble ${message.kind === 'emoji' ? 'chat-bubble--emoji' : ''} ${className}`}>
      {message.content}
    </div>
  );
}

// ---------------------------------------------------------------- 面板

export function ChatButton({ policy, chat, you, compact }: { policy: ChatPolicy; chat: ChatMessage[]; you: string; compact?: boolean }) {
  const { send, notify } = useRoom();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'phrase' | 'emoji' | 'log'>('phrase');
  const [text, setText] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useBlockVersion();

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);

  const precheck = useMemo(() => (text.trim() ? checkText(text) : null), [text]);

  if (policy === 'off') return null;

  const sendMsg = (kind: ChatMessage['kind'], content: string) => {
    send({ type: 'chat', kind, content });
    setOpen(false);
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!precheck) return;
    if (!precheck.ok) return notify(precheck.reason, 'error');
    sendMsg('text', precheck.text);
    setText('');
  };

  const others = chat.filter((m) => m.playerId !== you);

  return (
    <div className="chat" ref={ref}>
      <button className={`btn btn--sm btn--ghost ${compact ? 'btn--square' : ''}`} onClick={() => setOpen((o) => !o)} aria-expanded={open} title="快捷聊天">
        💬{!compact && ' 聊天'}
      </button>
      {open && (
        <div className="chat__panel" role="dialog" aria-label="快捷聊天">
          <div className="segmented chat__tabs">
            <button className={tab === 'phrase' ? 'is-active' : ''} onClick={() => setTab('phrase')}>
              短语
            </button>
            <button className={tab === 'emoji' ? 'is-active' : ''} onClick={() => setTab('emoji')}>
              表情
            </button>
            <button className={tab === 'log' ? 'is-active' : ''} onClick={() => setTab('log')}>
              消息{others.length ? ` ${Math.min(others.length, 99)}` : ''}
            </button>
          </div>

          {tab === 'phrase' && (
            <>
              <div className="chat__phrases">
                {QUICK_PHRASES.map((p) => (
                  <button key={p} onClick={() => sendMsg('phrase', p)}>
                    {p}
                  </button>
                ))}
              </div>
              {policy === 'full' && (
                <form className="chat__input" onSubmit={onSubmit}>
                  <input
                    value={text}
                    maxLength={MAX_TEXT_LENGTH + 2}
                    placeholder={`说点什么（${MAX_TEXT_LENGTH} 字内）`}
                    onChange={(e) => setText(e.target.value)}
                    aria-invalid={precheck ? !precheck.ok : undefined}
                  />
                  <button className="btn btn--primary btn--sm" disabled={!precheck?.ok}>
                    发送
                  </button>
                </form>
              )}
              {precheck && !precheck.ok && <div className="chat__warn">{precheck.reason}</div>}
              <div className="chat__note muted small">请文明交流，不当内容会被自动拦截，多次违规将被禁言。</div>
            </>
          )}

          {tab === 'emoji' && (
            <div className="chat__emojis">
              {EMOJIS.map((e) => (
                <button key={e} onClick={() => sendMsg('emoji', e)} aria-label={e}>
                  {e}
                </button>
              ))}
            </div>
          )}

          {tab === 'log' && (
            <ul className="chat__log">
              {chat.length === 0 && <li className="muted small">还没有消息</li>}
              {[...chat].reverse().map((m) => {
                const isBlocked = blockStore.has(m.playerId);
                return (
                  <li key={m.id}>
                    <b>{m.playerId === you ? '你' : m.name}</b>
                    <span className={isBlocked ? 'muted' : ''}>{isBlocked ? '（已屏蔽）' : m.content}</span>
                    {m.playerId !== you && (
                      <button className="link-btn" onClick={() => blockStore.toggle(m.playerId)}>
                        {isBlocked ? '取消屏蔽' : '屏蔽'}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
