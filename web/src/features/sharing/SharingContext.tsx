import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useIdentity } from '../../lib/identity/identity';
import { SessionSocket, type SocketEvent } from '../../lib/ws/socket';
import { sessionsApi } from './api';

interface SharingValue {
  api: ReturnType<typeof sessionsApi>;
  socket: SessionSocket;
}

const SharingContext = createContext<SharingValue | null>(null);

export function SharingProvider({
  children,
  socket: given,
  api: givenApi,
}: {
  children: ReactNode;
  socket?: SessionSocket;
  api?: ReturnType<typeof sessionsApi>;
}) {
  const { client } = useIdentity();
  const value = useMemo(
    () => ({ api: givenApi ?? sessionsApi(client), socket: given ?? new SessionSocket(client) }),
    [client, given, givenApi],
  );
  return <SharingContext.Provider value={value}>{children}</SharingContext.Provider>;
}

export function useSharing(): SharingValue {
  const v = useContext(SharingContext);
  if (!v) throw new Error('useSharing outside SharingProvider');
  return v;
}

/** Subscribes to socket events while mounted (opens the socket on first use). */
export function useSocketEvents(fn: (e: SocketEvent) => void, enabled = true) {
  const { socket } = useSharing();
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!enabled) return;
    return socket.subscribe((e) => ref.current(e));
  }, [socket, enabled]);
}
