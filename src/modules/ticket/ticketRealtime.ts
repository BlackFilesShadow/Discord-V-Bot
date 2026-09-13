import { EventEmitter } from 'node:events';

export type TicketRealtimeKind = 'message' | 'status';

export interface TicketRealtimeEvent {
  ticketId: string;
  kind: TicketRealtimeKind;
  at: string;
}

const bus = new EventEmitter();
bus.setMaxListeners(0);

export function publishTicketRealtimeEvent(ticketId: string, kind: TicketRealtimeKind): void {
  bus.emit('ticket-update', {
    ticketId,
    kind,
    at: new Date().toISOString(),
  } satisfies TicketRealtimeEvent);
}

export function subscribeTicketRealtimeEvents(listener: (event: TicketRealtimeEvent) => void): () => void {
  bus.on('ticket-update', listener);
  return () => bus.off('ticket-update', listener);
}
