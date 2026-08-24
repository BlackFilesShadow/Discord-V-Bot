/**
 * Production compatibility: DayZ Console bans use the live-proven
 * `settings.general.bans` string through the gameserver settings contract.
 * Missing/unknown shapes fail closed and every mutation is verified by a
 * fresh remote read. The unsupported generic games/banlist endpoint must not
 * be used by this path.
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
  it('akzeptiert identifier-, id-, name- und String-Eintraege und dedupliziert', () => {
    expect(parseNitradoBanlistData({
      banlist: [
        { identifier: 'player-a', added_at: '2026-08-14T00:00:00Z' },
        { id: 'player-b', name: 'Display B', id_type: 'identifier' },
        { name: 'player-c' },
        'player-d',
        { identifier: 'player-a' },
      ],
    })).toEqual([
      { identifier: 'player-a', added_at: '2026-08-14T00:00:00Z' },
      { identifier: 'player-b' },
      { identifier: 'player-c' },
      { identifier: 'player-d' },
    ]);
  });

  it('behandelt unbekannte Legacy-Antwortformate niemals als leere Liste', () => {
    expect(() => parseNitradoBanlistData({ somethingElse: [] })).toThrow(NitradoApiError);
    expect(() => parseNitradoBanlistData(null)).toThrow(NitradoApiError);
  });
});

describe('NitradoClient DayZ Console ban settings contract', () => {
  it('liest general.bans ueber /gameservers und akzeptiert CRLF/LF/CR', async () => {
    requestMock.mockResolvedValueOnce(gameserverSettings('player-a\r\nplayer-b\rplayer-c\n'));
    const client = new NitradoClient('token-1234');

    await expect(client.getBanlist('123')).resolves.toEqual([
      { identifier: 'player-a' },
      { identifier: 'player-b' },
      { identifier: 'player-c' },
    ]);
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET',
      url: '/services/123/gameservers',
    }));
  });

  it('failt geschlossen wenn general.bans fehlt oder kein String ist', async () => {
    requestMock
      .mockResolvedValueOnce({ status: 200, headers: {}, data: { data: { gameserver: { settings: { general: { whitelist: '' } } } } } })
      .mockResolvedValueOnce(gameserverSettings(false));
    const client = new NitradoClient('token-1234');

    await expect(client.getBanlist('123')).rejects.toThrow('Banlist-Setting fehlt');
    await expect(client.getBanlist('123')).rejects.toThrow('Unerwartetes Banlist-Settingformat');
  });

  it('fuegt einen Bann per Read-Modify-Write hinzu, erhaelt alle bestehenden Banns und bestaetigt frisch', async () => {
    requestMock
      .mockResolvedValueOnce(gameserverSettings('player-a\r\nplayer-b'))
      .mockResolvedValueOnce({ status: 200, headers: {}, data: { data: {} } })
      .mockResolvedValueOnce(gameserverSettings('player-a\r\nplayer-b\r\nplayer-c'));
    const client = new NitradoClient('token-1234');

    await client.addToBanlist('123', 'player-c');

    expect(requestMock).toHaveBeenCalledTimes(3);
    expect(requestMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      method: 'POST',
      url: '/services/123/gameservers/settings',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }));
    const post = requestMock.mock.calls[1][0] as { data: string };
    const form = new URLSearchParams(post.data);
    expect(form.get('category')).toBe('general');
    expect(form.get('key')).toBe('bans');
    expect(form.get('value')).toBe('player-a\r\nplayer-b\r\nplayer-c');
    expect(requestMock).toHaveBeenNthCalledWith(3, expect.objectContaining({
      method: 'GET',
      url: '/services/123/gameservers',
    }));
  });

  it('ist idempotent wenn derselbe Bann bereits remote existiert', async () => {
    requestMock
      .mockResolvedValueOnce(gameserverSettings('Player-C'))
      .mockResolvedValueOnce(gameserverSettings('Player-C'));
    const client = new NitradoClient('token-1234');

    await client.addToBanlist('123', 'player-c');

    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(requestMock.mock.calls.every(([call]) => call.method === 'GET')).toBe(true);
  });

  it('schlaegt fehl wenn ein Settings-Add remote auch nach bounded Re-Reads nicht sichtbar wird', async () => {
    requestMock
      .mockResolvedValueOnce(gameserverSettings(''))
      .mockResolvedValueOnce({ status: 200, headers: {}, data: { data: {} } })
      .mockResolvedValue(gameserverSettings(''));
    const client = new NitradoClient('token-1234');

    await expect(client.addToBanlist('123', 'player-c'))
      .rejects.toThrow('Banlist-Add konnte remote nicht bestaetigt werden');
    expect(requestMock).toHaveBeenCalledTimes(5);
  });

  it('entfernt exakt einen Bann per Read-Modify-Write und bestaetigt die Abwesenheit frisch', async () => {
    requestMock
      .mockResolvedValueOnce(gameserverSettings('player-a\r\nplayer-b\r\nplayer-c'))
      .mockResolvedValueOnce({ status: 200, headers: {}, data: { data: {} } })
      .mockResolvedValueOnce(gameserverSettings('player-a\r\nplayer-c'));
    const client = new NitradoClient('token-1234');

    await client.removeFromBanlist('123', 'PLAYER-B');

    expect(requestMock).toHaveBeenCalledTimes(3);
    const post = requestMock.mock.calls[1][0] as { method: string; url: string; data: string };
    expect(post.method).toBe('POST');
    expect(post.url).toBe('/services/123/gameservers/settings');
    const form = new URLSearchParams(post.data);
    expect(form.get('key')).toBe('bans');
    expect(form.get('value')).toBe('player-a\r\nplayer-c');
  });

  it('verwendet im DayZ-Console-Pfad niemals den nicht implementierten games/banlist-Endpunkt', async () => {
    requestMock.mockResolvedValue(gameserverSettings(''));
    const client = new NitradoClient('token-1234');

    await client.getBanlist('123');
    await client.addToBanlist('123', 'player-a');

    expect(requestMock.mock.calls.every(([call]) =>
      !String(call.url).includes('/gameservers/games/banlist'),
    )).toBe(true);
  });

  it('weist leere Identifier vor jedem Remote-Write ab', async () => {
    const client = new NitradoClient('token-1234');
    await expect(client.addToBanlist('123', '   ')).rejects.toThrow('Leerer Identifier');
    await expect(client.removeFromBanlist('123', '')).rejects.toThrow('Leerer Identifier');
    expect(requestMock).not.toHaveBeenCalled();
  });
});
