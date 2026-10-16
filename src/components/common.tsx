import { ReactNode } from 'react';
import type { PlayerKind } from '../net/protocol';
import { useRoom } from '../store/RoomContext';

export function Avatar({ name, kind, size = 40 }: { name: string; kind: PlayerKind; size?: number }) {
  const initial = kind === 'ai' ? 'AI' : [...name][0]?.toUpperCase() ?? '?';
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  return (
    <div
      className={`avatar avatar--${kind}`}
      style={{ width: size, height: size, fontSize: size * 0.4, ['--hue' as string]: hash }}
      aria-hidden
    >
      {initial}
    </div>
  );
}

export function StatusDot({ online, title }: { online: boolean; title?: string }) {
  return <span className={`dot ${online ? 'dot--on' : 'dot--off'}`} title={title ?? (online ? '在线' : '离线')} />;
}

export function KindTag({ kind, autoPlay }: { kind: PlayerKind; autoPlay?: boolean }) {
  if (kind === 'ai') return <span className="tag tag--ai">AI</span>;
  if (autoPlay) return <span className="tag tag--auto">托管</span>;
  if (kind === 'simulated') return <span className="tag tag--sim">模拟</span>;
  return null;
}

export function Toasts() {
  const { toasts } = useRoom();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.tone}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function Modal({ children, onClose, wide }: { children: ReactNode; onClose?: () => void; wide?: boolean }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className={`modal ${wide ? 'modal--wide' : ''}`} onClick={(e) => e.stopPropagation()} role="dialog">
        {children}
      </div>
    </div>
  );
}

export function LinkBanner() {
  const { link } = useRoom();
  if (link !== 'lost') return null;
  return <div className="link-banner">连接中断，正在重新连接…</div>;
}
