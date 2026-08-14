import type { Server as IOServer } from 'socket.io';
import {
  emitServerGameplayEvent,
  serverRoomName,
  setIo,
} from '../../src/dashboard/socket/emitter';
import { serverFeedPermissionAllows } from '../../src/dashboard/socket/guild';

describe('server-scoped gameplay socket emitter', () => {
  afterEach(() => setIo(null));

  it('bildet Guild + Connection deterministisch auf genau einen Server-Room ab', () => {
    expect(serverRoomName('123456789012345678', 'conn-a'))
      .toBe('gs:123456789012345678:conn-a');
    expect(serverRoomName('123456789012345678', 'conn-b'))
      .not.toBe(serverRoomName('123456789012345678', 'conn-a'));
  });

  it('emittiert Gameplay nicht in den Guild-Room, sondern nur in den exakten Gameserver-Room', () => {
    const emit = jest.fn();
    const to = jest.fn(() => ({ emit }));
    const of = jest.fn(() => ({ to }));
    setIo({ of } as unknown as IOServer);

    const payload = {
      guildId: '123456789012345678',
      nitradoConnId: 'conn-a',
      eventId: 'event-1',
      source: 'ADM_V2' as const,
      eventType: 'PLAYER_KILLED',
      occurredAt: '2026-08-14T18:00:00.000Z',
      actorName: 'Victim',
      targetName: 'Killer',
    };
    emitServerGameplayEvent(payload);

    expect(of).toHaveBeenCalledWith('/guild');
    expect(to).toHaveBeenCalledTimes(1);
    expect(to).toHaveBeenCalledWith('gs:123456789012345678:conn-a');
    expect(to).not.toHaveBeenCalledWith('g:123456789012345678');
    expect(emit).toHaveBeenCalledWith('server.gameplay.event', payload);
  });

  it('ist ohne initialisierte Socket-Runtime ein sauberer No-op', () => {
    setIo(null);
    expect(() => emitServerGameplayEvent({
      guildId: '123456789012345678',
      nitradoConnId: 'conn-a',
      source: 'ADM_V2',
      eventType: 'PLAYER_CONNECTED',
      occurredAt: null,
    })).not.toThrow();
  });
});

describe('server gameplay permission', () => {
  it('Owner darf den Feed sehen', () => {
    expect(serverFeedPermissionAllows(true, [])).toBe(true);
  });

  it.each(['killfeed.view', 'killfeed.manage', 'dashboard.access'])(
    'akzeptiert den explizit passenden Scope %s',
    (permission) => {
      expect(serverFeedPermissionAllows(false, [permission])).toBe(true);
    },
  );

  it('lehnt beliebige andere Guild-Scopes ab', () => {
    expect(serverFeedPermissionAllows(false, ['economy.view', 'whitelist.view'])).toBe(false);
    expect(serverFeedPermissionAllows(false, [])).toBe(false);
  });
});
