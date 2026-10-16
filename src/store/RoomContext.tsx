// 房间状态管理：持有当前连接，向组件提供最新的服务器视图与操作方法

import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { lobbyApi } from '../net/api';
import type { RoomConnection } from '../net/connection';
import type { ClientMessage, RoomConfig, ServerView } from '../net/protocol';
import { sessionStore } from '../net/storage';

export type LinkStatus = 'idle' | 'connecting' | 'connected' | 'lost';

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error' | 'success';
}

interface RoomContextValue {
  view: ServerView | null;
  link: LinkStatus;
  role: 'host' | 'guest' | null;
  toasts: Toast[];
  createRoom(name: string, config?: Partial<RoomConfig>): Promise<void>;
  joinRoom(code: string, name: string): Promise<void>;
  leaveRoom(): void;
  send(msg: ClientMessage): void;
  notify(text: string, tone?: Toast['tone']): void;
}

const Ctx = createContext<RoomContextValue | null>(null);

/** 超过该时间未收到服务器消息视为连接中断 */
const LOST_AFTER_MS = 7000;

export function RoomProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<ServerView | null>(null);
  const [link, setLink] = useState<LinkStatus>(() => (sessionStore.get() ? 'connecting' : 'idle'));
  const [toasts, setToasts] = useState<Toast[]>([]);
  const connRef = useRef<RoomConnection | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  const lastMsgAt = useRef(0);
  const toastId = useRef(0);
  const leaving = useRef(false);
  const lastVersion = useRef(-1);

  const notify = useCallback((text: string, tone: Toast['tone'] = 'info') => {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-3), { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200);
  }, []);

  const teardown = useCallback(() => {
    unsubRef.current?.();
    unsubRef.current = null;
    connRef.current?.close();
    connRef.current = null;
    setView(null);
    setLink('idle');
  }, []);

  const attach = useCallback(
    (conn: RoomConnection) => {
      unsubRef.current?.();
      lastVersion.current = -1;
      connRef.current = conn;
      lastMsgAt.current = Date.now();
      setLink('connected');
      unsubRef.current = conn.subscribe((msg) => {
        lastMsgAt.current = Date.now();
        switch (msg.type) {
          case 'state':
            // 内容未变化（心跳回包）时不重新渲染
            if (msg.view.version !== lastVersion.current) {
              lastVersion.current = msg.view.version;
              setView(msg.view);
            }
            setLink('connected');
            break;
          case 'error':
            notify(msg.message, 'error');
            break;
          case 'kicked':
          case 'closed':
            if (!leaving.current) notify(msg.reason, 'error');
            sessionStore.set(null);
            teardown();
            break;
        }
      });
    },
    [notify, teardown],
  );

  // 刷新页面后自动恢复会话
  useEffect(() => {
    const s = sessionStore.get();
    if (!s) return;
    let cancelled = false;
    lobbyApi
      .resume(s)
      .then((conn) => {
        if (cancelled) conn.close();
        else attach(conn);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        sessionStore.set(null);
        setLink('idle');
        notify(`无法恢复房间：${e.message}`, 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [attach, notify]);

  // 检测连接是否中断（访客端）
  useEffect(() => {
    const t = setInterval(() => {
      // 本地模式下房主自己就是服务器，不会断线；真实后端模式下所有人都要检测
      const conn = connRef.current;
      if (conn && (conn.role === 'guest' || lobbyApi.mode === 'remote') && Date.now() - lastMsgAt.current > LOST_AFTER_MS) setLink('lost');
    }, 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const onUnload = () => connRef.current?.close();
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, []);

  const createRoom = useCallback(
    async (name: string, config?: Partial<RoomConfig>) => {
      setLink('connecting');
      try {
        attach(await lobbyApi.createRoom(name, config));
      } catch (e) {
        setLink('idle');
        throw e;
      }
    },
    [attach],
  );

  const joinRoom = useCallback(
    async (code: string, name: string) => {
      setLink('connecting');
      try {
        attach(await lobbyApi.joinRoom(code, name));
      } catch (e) {
        setLink('idle');
        throw e;
      }
    },
    [attach],
  );

  const send = useCallback((msg: ClientMessage) => connRef.current?.send(msg), []);

  const leaveRoom = useCallback(() => {
    leaving.current = true;
    connRef.current?.send({ type: 'leave' });
    sessionStore.set(null);
    teardown();
    leaving.current = false;
  }, [teardown]);

  const value: RoomContextValue = {
    view,
    link,
    role: connRef.current?.role ?? null,
    toasts,
    createRoom,
    joinRoom,
    leaveRoom,
    send,
    notify,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRoom(): RoomContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useRoom 必须在 RoomProvider 内使用');
  return v;
}
