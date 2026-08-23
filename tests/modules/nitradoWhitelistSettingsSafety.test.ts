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

import { NitradoClient } from '../../src/modules/nitrado/nitradoClient';

beforeEach(() => { jest.clearAllMocks(); });

function settings(whitelist: unknown, includeKey = true) {
  const general = includeKey ? { whitelist } : {};
  return {
    status: 200,
    headers: {},
    data: { data: { gameserver: { settings: { general } } } },
  };
}

describe('NitradoClient whitelist settings safety', () => {
  it('behaelt den produktiv bestaetigten general.whitelist Read-Modify-Write-Pfad', async () => {
    requestMock
      .mockResolvedValueOnce(settings('player-a\r\nplayer-b'))
      .mockResolvedValueOnce({ status: 200, headers: {}, data: { data: {} } });
    const client = new NitradoClient('token-1234');

    await client.addToWhitelist('123', 'player-c');

    expect(requestMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      method: 'GET',
      url: '/services/123/gameservers',
    }));
    expect(requestMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      method: 'POST',
      url: '/services/123/gameservers/settings',
    }));
    const post = requestMock.mock.calls[1][0] as { data: string };
    expect(new URLSearchParams(post.data).get('key')).toBe('whitelist');
    expect(new URLSearchParams(post.data).get('value')).toBe('player-a\r\nplayer-b\r\nplayer-c');
  });

  it.each([true, false, 'true', 'false'])('interpretiert Default %p als leere Spieler-Liste', async value => {
    requestMock.mockResolvedValueOnce(settings(value));
    const client = new NitradoClient('token-1234');

    await expect(client.getWhitelist('123')).resolves.toEqual([]);
  });

  it('bricht bei fehlendem whitelist-Key ab statt Remote-Zustand als leer anzunehmen', async () => {
    requestMock.mockResolvedValueOnce(settings(undefined, false));
    const client = new NitradoClient('token-1234');

    await expect(client.addToWhitelist('123', 'player-a')).rejects.toThrow('Whitelist-Setting fehlt');
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('bricht bei unbekanntem whitelist-Shape vor jedem Write ab', async () => {
    requestMock.mockResolvedValueOnce(settings({ players: ['player-a'] }));
    const client = new NitradoClient('token-1234');

    await expect(client.removeFromWhitelist('123', 'player-a')).rejects.toThrow('Unerwartetes Whitelist-Settingformat');
    expect(requestMock).toHaveBeenCalledTimes(1);
  });
});
