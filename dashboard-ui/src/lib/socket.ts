import { io, Socket } from 'socket.io-client';

let guildSocket: Socket | null = null;
let devSocket: Socket | null = null;

export function getGuildSocket(): Socket {
  if (!guildSocket) {
    guildSocket = io('/guild', { withCredentials: true, transports: ['websocket', 'polling'] });
  }
  return guildSocket;
}

export function getDevSocket(): Socket {
  if (!devSocket) {
    devSocket = io('/dev', { withCredentials: true, transports: ['websocket', 'polling'] });
  }
  return devSocket;
}

export function disconnectDevSocket(): void {
  if (!devSocket) return;
  devSocket.removeAllListeners();
  devSocket.disconnect();
  devSocket = null;
}

export function joinGuildRoom(guildId: string): void {
  const s = getGuildSocket();
  s.emit('join', { guildId });
}

export function joinRadarRoom(guildId: string, nitradoConnId: string): void {
  const s = getGuildSocket();
  s.emit('join.radar', { guildId, nitradoConnId });
}
