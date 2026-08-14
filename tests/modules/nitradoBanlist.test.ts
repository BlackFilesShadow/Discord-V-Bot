/**
 * Phase 7 Remote-Ban: DayZ-Playerlisten werden ueber das Gameserver-Setting
 * `general.bans` gelesen und per Read-Modify-Write geschrieben. Damit nutzt Ban
 * exakt denselben produktiv bewaehrten Mechanismus wie die Whitelist.
 */
const requestMock = jest.fn();
jest.mock('axios', () => ({
  __esModule: true,
  default: { create: () => ({ request: requestMock }), get: jest.fn() },
}));
jest.mock('../../src/modules/nitrado/circuitBreaker', () => {
  const b = { preflight: jest.fn(), recordFailure: jest.fn(), recordSuccess: jest.fn() };
  return {
    __esModule: true,
    getNitradoBreaker: () => b,
    opClassForMethod: (m: string) => (m === 'GET' ? 'READ' : 'WRITE'),
    NitradoCircuitOpenError: class NitradoCircuitOpenError extends Error {},
  };
});
jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import {
  NitradoClient,
  NitradoApiError,
  parseNitradoBanlistData,
} from '../../src/modules/nitrado/nitradoClient';

beforeEach(() => { jest.clearAllMocks(); });

function gameserverSettings(bans: unknown, whitelist: unknown = '') {
  return {
    status: 200,
    headers: {},
    data: { data: { gameserver: { settings: { general: { bans, whitelist } } } } },
  };
}

describe('parseNitradoBanlistData compatibility', () => {
  it('akzeptiert alten identifier- und neuen id-Vertrag und dedupliziert', () => {
    expect(parseNitradoBanlistData({
      banlist: [
        { identifier: 'player-a', added_at: '2026-08-14T00:00:00Z' },
        { id: 'player-b', name: 'Display B', id_type: 'identifier' },
        'player-c',
        { identifier: 'player-a' },
      ],
    })).toEqual([
      { identifier: 'player-a', added_at: '2026-08-14T00:00:00Z' },
      { identifier: 'player-b' },
      { identifier: 'player-c' },
    ]);
  });

  it('behandelt unbekannte Antwortformate niemals als leere Liste', () => {
    expect(() => parseNitradoBanlistData({ somethingElse: [] })).toThrow(NitradoApiError);
    expect(() => parseNitradoBanlistData(null)).toThrow(NitradoApiError);
  });
});

describe('NitradoClient DayZ ban settings', () => {
  it('liest general.bans und akzeptiert CRLF, LF und CR', async () => {
    requestMock.mockResolvedValueOnce(gameserverSettings('player-a\r\nplayer-b\rplayer-c\nplayer-a'));
    const client = new NitradoClient('token-1234');

    await expect(client.getBanlist('123')).resolves.toEqual([
      { identifier: 'player-a' },
      { identifier: 'player-b' },
      { identifier: 'player-c' },
      { identifier: 'player-a' },
    ]);
    expect(requestMock).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET',
      url: '/services/123/gameservers',
    }));
  });

  it('fuegt einen Bann hinzu ohne bestehende Banns zu verlieren', async () => {
    requestMock
      .mockResolvedValueOnce(gameserverSettings('player-a\r\nplayer-b'))
      .mockResolvedValueOnce({ status: 200, headers: {}, data: { data: {} } });
    const client = new NitradoClient('token-1234');

    await client.addToBanlist('123', 'player-c');

    expect(requestMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      method: 'POST',
      url: '/services/123/gameservers/settings',
      data: expect.stringContaining('key=bans'),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }));
    const post = requestMock.mock.calls[1][0] as { data: string };
    expect(new URLSearchParams(post.data).get('value')).toBe('player-a\r\nplayer-b\r\nplayer-c');
  });

  it('entfernt exakt einen Bann und erhaelt alle anderen', async () => {
    requestMock
      .mockResolvedValueOnce(gameserverSettings('player-a\r\nplayer-b\r\nplayer-c'))
      .mockResolvedValueOnce({ status: 200, headers: {}, data: { data: {} } });
    const client = new NitradoClient('token-1234');

    await client.removeFromBanlist('123', 'player-b');

    const post = requestMock.mock.calls[1][0] as { data: string };
    expect(new URLSearchParams(post.data).get('value')).toBe('player-a\r\nplayer-c');
  });

  it('schreibt bei bereits vorhandenem Bann nicht erneut', async () => {
    requestMock.mockResolvedValueOnce(gameserverSettings('player-a\r\nplayer-b'));
    const client = new NitradoClient('token-1234');

    await client.addToBanlist('123', 'player-b');

    expect(requestMock).toHaveBeenCalledTimes(1);
  });
});
