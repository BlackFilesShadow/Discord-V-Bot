/**
 * Phase 7 Remote-Ban: offizieller Nitrado Gameserver-Banlist-Vertrag.
 * GET wird fail-closed geparst; POST/DELETE schicken `identifier` form-urlencoded.
 */
const requestMock = jest.fn();
jest.mock('axios', () => ({
  __esModule: true,
  default: { create: () => ({ request: requestMock }) },
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

describe('parseNitradoBanlistData', () => {
  it('akzeptiert Objekt- und String-Eintraege und dedupliziert', () => {
    expect(parseNitradoBanlistData({
      banlist: [
        { identifier: 'player-a', added_at: '2026-08-14T00:00:00Z' },
        'player-b',
        { identifier: 'player-a' },
      ],
    })).toEqual([
      { identifier: 'player-a', added_at: '2026-08-14T00:00:00Z' },
      { identifier: 'player-b' },
    ]);
  });

  it('akzeptiert eine leere, bekannte Banlist', () => {
    expect(parseNitradoBanlistData({ banlist: [] })).toEqual([]);
  });

  it('behandelt unbekannte Antwortformate niemals als leere Liste', () => {
    expect(() => parseNitradoBanlistData({ somethingElse: [] })).toThrow(NitradoApiError);
    expect(() => parseNitradoBanlistData(null)).toThrow(NitradoApiError);
  });

  it('bricht bei Eintraegen ohne Identifier fail-closed ab', () => {
    expect(() => parseNitradoBanlistData({ banlist: [{ foo: 'bar' }] })).toThrow(NitradoApiError);
  });
});

describe('NitradoClient Banlist API', () => {
  it('liest GET /gameservers/games/banlist', async () => {
    requestMock.mockResolvedValue({
      status: 200,
      headers: {},
      data: { data: { banlist: [{ identifier: 'player-a' }] } },
    });
    const client = new NitradoClient('token-1234');

    await expect(client.getBanlist('123')).resolves.toEqual([{ identifier: 'player-a' }]);
    expect(requestMock).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET',
      url: '/services/123/gameservers/games/banlist',
    }));
  });

  it('sendet POST mit identifier als form-urlencoded', async () => {
    requestMock.mockResolvedValue({ status: 200, headers: {}, data: { data: {} } });
    const client = new NitradoClient('token-1234');

    await client.addToBanlist('123', 'player-a');
    expect(requestMock).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST',
      url: '/services/123/gameservers/games/banlist',
      data: 'identifier=player-a',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }));
  });

  it('sendet DELETE mit identifier als form-urlencoded', async () => {
    requestMock.mockResolvedValue({ status: 200, headers: {}, data: { data: {} } });
    const client = new NitradoClient('token-1234');

    await client.removeFromBanlist('123', 'player-a');
    expect(requestMock).toHaveBeenCalledWith(expect.objectContaining({
      method: 'DELETE',
      url: '/services/123/gameservers/games/banlist',
      data: 'identifier=player-a',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }));
  });
});
