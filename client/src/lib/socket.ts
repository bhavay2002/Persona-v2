import { io, Socket } from 'socket.io-client';

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io(window.location.origin, {
      transports: ['polling', 'websocket'],
      path: '/socket.io',
      autoConnect: false,
    });
  }
  return socket;
}

export function connectSocket(userId?: number): Socket {
  const s = getSocket();
  if (!s.connected) {
    s.connect();
    const register = () => {
      if (userId) s.emit('register-user', userId);
    };
    s.once('connect', register);
    if (s.connected) register();
  }
  return s;
}

export function disconnectSocket(): void {
  if (socket?.connected) socket.disconnect();
}
