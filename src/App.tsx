import { useEffect, useState } from 'react';
import { LinkBanner, Toasts } from './components/common';
import { Admin } from './pages/Admin';
import { GameTable } from './pages/GameTable';
import { Home } from './pages/Home';
import { Lobby } from './pages/Lobby';
import { RoomProvider, useRoom } from './store/RoomContext';

function useHashRoute() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const fn = () => setHash(location.hash);
    window.addEventListener('hashchange', fn);
    return () => window.removeEventListener('hashchange', fn);
  }, []);
  return hash.replace(/^#\/?/, '');
}

function Screen() {
  const { view } = useRoom();
  const route = useHashRoute();
  // 后台入口：/admin 或 #/admin，前台页面不提供任何链接
  if (route === 'admin' || /\/admin\/?$/.test(location.pathname)) return <Admin />;
  if (!view) return <Home />;
  if (view.room.status === 'waiting' || !view.game) return <Lobby view={view} />;
  return <GameTable view={view} />;
}

export function App() {
  return (
    <RoomProvider>
      <Screen />
      <LinkBanner />
      <Toasts />
    </RoomProvider>
  );
}
