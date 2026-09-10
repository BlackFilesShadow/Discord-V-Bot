import { aggregatePlayerSessions, type SessionSourceEvent } from '../../src/modules/nitrado/adm/playerSessionService';

const scope = { guildId: 'guild-1', nitradoConnId: 'conn-1' };

function event(overrides: Partial<SessionSourceEvent> & Pick<SessionSourceEvent, 'id' | 'eventType'>): SessionSourceEvent {
  return {
    id: overrides.id,
    eventType: overrides.eventType,
    occurredAt: overrides.occurredAt ?? new Date('2026-09-10T12:00:00.000Z'),
    actorGameId: overrides.actorGameId ?? 'game-1',
    actorName: overrides.actorName ?? 'Player One',
    sourceByteStart: overrides.sourceByteStart ?? 1n,
  };
}

describe('PlayerSession terminal closure', () => {
  it('does not reopen an already persisted CLOSED session when the event stream still computes OPEN', async () => {
    const findMany = jest.fn().mockResolvedValue([
      event({ id: 'connect-1', eventType: 'PLAYER_CONNECTED' }),
    ]);
    const upsert = jest.fn().mockResolvedValue({});

    await aggregatePlayerSessions({
      admEvent: { findMany },
      playerSession: { upsert },
    }, scope);

    expect(upsert).toHaveBeenCalledTimes(1);
    const args = upsert.mock.calls[0][0];
    expect(args.create.status).toBe('OPEN');
    expect(args.update).toEqual({ playerName: 'Player One' });
    expect(args.update).not.toHaveProperty('status');
    expect(args.update).not.toHaveProperty('disconnectedAt');
  });

  it('still performs the normal monotonic OPEN to CLOSED update when a disconnect exists', async () => {
    const findMany = jest.fn().mockResolvedValue([
      event({ id: 'connect-1', eventType: 'PLAYER_CONNECTED', sourceByteStart: 1n }),
      event({
        id: 'disconnect-1',
        eventType: 'PLAYER_DISCONNECTED',
        occurredAt: new Date('2026-09-10T12:20:00.000Z'),
        sourceByteStart: 2n,
      }),
    ]);
    const upsert = jest.fn().mockResolvedValue({});

    await aggregatePlayerSessions({
      admEvent: { findMany },
      playerSession: { upsert },
    }, scope);

    const args = upsert.mock.calls[0][0];
    expect(args.update).toMatchObject({
      status: 'CLOSED',
      disconnectEventId: 'disconnect-1',
      durationSeconds: 1200,
      bucketsEarned: 2,
    });
  });
});
