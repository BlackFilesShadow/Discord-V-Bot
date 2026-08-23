/**
 * Production compatibility: bans use Nitrado's dedicated gameserver banlist
 * endpoint. Unknown response shapes must fail closed and writes count as
 * successful only after a fresh remote read confirms the requested state.
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

function banlistResponse(entries: unknown[]) {
  return { status: 200, headers: {}, data: { data: { banlist: entries } } };
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

  it('behandelt unbekannte Antwortformate niemals als leere Liste', () => {
    expect(() => parseNitradoBanlistData({ somethingElse: [] })).toThrow(NitradoApiError);
    expect(() => parseNitradoBanlistData(null)).toThrow(NitradoApiError);
  });
});

describe('NitradoClient official gameserver banlist contract', () => {
  it('liest die Banlist ueber den dedizierten Nitrado-Endpunkt', async () => {
    requestMock.mockResolvedValueOnce(banlistResponse(['player-a', { identifier: 'player-b' }]));
    const client = new NitradoClient('token-1234');

    await expect(client.getBanlist('123')).resolves.toEqual([
      { identifier: 'player-a' },
      { identifier: 'player-b' },
    ]);
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET',
      url: '/services/123/gameservers/games/banlist',
    }));
  });

  it('wirft bei erfolgreicher HTTP-Antwort ohne data-Feld fail-closed', async () => {
    requestMock.mockResolvedValueOnce({ status: 200, headers: {}, data: { status: 'success' } });
    const client = new NitradoClient('token-1234');

    await expect(client.getBanlist('123')).rejects.toThrow('Banlist-Antwort ohne data-Feld');
  });

  it('fuegt einen Bann ueber POST hinzu und bestaetigt ihn mit frischem GET', async () => {
    requestMock
      .mockResolvedValueOnce({ status: 200, headers: {}, data: { data: {} } })
      .mockResolvedValueOnce(banlistResponse(['player-c']));
    const client = new NitradoClient('token-1234');

    await client.addToBanlist('123', 'player-c');

    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(requestMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      method: 'POST',
      url: '/services/123/gameservers/games/banlist',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }));
    const post = requestMock.mock.calls[0][0] as { data: string };
    expect(new URLSearchParams(post.data).get('identifier')).toBe('player-c');
    expect(requestMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      method: 'GET',
      url: '/services/123/gameservers/games/banlist',
    }));
  });

  it('entfernt einen Bann ueber DELETE und bestaetigt die Abwesenheit mit frischem GET', async () => {
    requestMock
      .mockResolvedValueOnce({ status: 200, headers: {}, data: { data: {} } })
      .mockResolvedValueOnce(banlistResponse([]));
    const client = new NitradoClient('token-1234');

    await client.removeFromBanlist('123', 'player-b');

    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(requestMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      method: 'DELETE',
      url: '/services/123/gameservers/games/banlist',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }));
    const del = requestMock.mock.calls[0][0] as { data: string };
    expect(new URLSearchParams(del.data).get('identifier')).toBe('player-b');
    expect(requestMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      method: 'GET',
      url: '/services/123/gameservers/games/banlist',
    }));
  });

  it('weist leere Identifier vor jedem Remote-Write ab', async () => {
    const client = new NitradoClient('token-1234');
    await expect(client.addToBanlist('123', '   ')).rejects.toThrow('Leerer Identifier');
    await expect(client.removeFromBanlist('123', '')).rejects.toThrow('Leerer Identifier');
    expect(requestMock).not.toHaveBeenCalled();
  });
});
