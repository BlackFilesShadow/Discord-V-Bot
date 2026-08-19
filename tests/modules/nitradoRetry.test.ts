/**
 * F-011 Regression: Der Nitrado-Client verliert nach dauerhaftem 429 NICHT mehr
 * den HTTP-Status. Retry-After wird als Sekunden UND HTTP-Datum interpretiert
 * und gedeckelt.
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
    nitradoBreaker: b,
    NitradoCircuitOpenError: class NitradoCircuitOpenError extends Error {},
  };
});
jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { NitradoClient, parseRetryAfterMs } from '../../src/modules/nitrado/nitradoClient';

beforeEach(() => { jest.clearAllMocks(); });

describe('F-011 — parseRetryAfterMs', () => {
  it('interpretiert Sekunden', () => {
    expect(parseRetryAfterMs('5')).toBe(5000);
  });
  it('interpretiert ein HTTP-Datum in der Zukunft', () => {
    const future = new Date(Date.now() + 4000).toUTCString();
    const ms = parseRetryAfterMs(future);
    expect(ms).toBeGreaterThan(1000);
    expect(ms).toBeLessThanOrEqual(5000);
  });
  it('deckelt auf capMs', () => {
    expect(parseRetryAfterMs('99999')).toBe(30_000);
  });
  it('klemmt negatives/vergangenes Datum auf 0', () => {
    const past = new Date(Date.now() - 10_000).toUTCString();
    expect(parseRetryAfterMs(past)).toBe(0);
  });
  it('faellt bei fehlendem Header auf Default', () => {
    expect(parseRetryAfterMs(undefined)).toBe(2000);
  });
});

describe('F-011 — Nitrado 429', () => {
  it('wirft NitradoApiError mit Status 429 nach dauerhaftem 429', async () => {
    requestMock.mockResolvedValue({ status: 429, headers: { 'retry-after': '0' }, data: {} });
    const client = new NitradoClient('token-1234');
    await expect(client.listServices()).rejects.toMatchObject({
      name: 'NitradoApiError',
      status: 429,
      endpoint: '/services',
    });
    expect(requestMock).toHaveBeenCalledTimes(3);
  });

  it('gibt nach einem 429 bei Folge-Erfolg das Ergebnis zurueck', async () => {
    requestMock
      .mockResolvedValueOnce({ status: 429, headers: { 'retry-after': '0' }, data: {} })
      .mockResolvedValueOnce({ status: 200, headers: {}, data: { data: { services: [] } } });
    const client = new NitradoClient('token-1234');
    await expect(client.listServices()).resolves.toEqual([]);
    expect(requestMock).toHaveBeenCalledTimes(2);
  });
});

describe('Nitrado-1V — canonical transport/timeout retry', () => {
  it('retryt einen ECONNABORTED-Timeout bei GET und kann danach erfolgreich lesen', async () => {
    jest.useFakeTimers();
    try {
      requestMock
        .mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }))
        .mockResolvedValueOnce({ status: 200, headers: {}, data: { data: { services: [] } } });

      const client = new NitradoClient('token-1234');
      const pending = client.listServices();
      await jest.advanceTimersByTimeAsync(500);

      await expect(pending).resolves.toEqual([]);
      expect(requestMock).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('begrenzt dauerhafte GET-ECONNABORTED-Timeouts auf drei Versuche und erhaelt status=null', async () => {
    jest.useFakeTimers();
    try {
      requestMock.mockRejectedValue(Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }));
      const client = new NitradoClient('token-1234');
      const pending = client.listServices();

      await jest.advanceTimersByTimeAsync(500);
      await jest.advanceTimersByTimeAsync(1000);

      await expect(pending).rejects.toMatchObject({
        name: 'NitradoApiError',
        status: null,
        endpoint: '/services',
        message: 'timeout',
      });
      expect(requestMock).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });

  it('replayt einen ambigen POST-Timeout nicht sofort innerhalb desselben Client-Aufrufs', async () => {
    requestMock
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        data: { data: { gameserver: { settings: { general: { whitelist: '' } } } } },
      })
      .mockRejectedValueOnce(Object.assign(new Error('write timeout'), { code: 'ECONNABORTED' }));

    const client = new NitradoClient('token-1234');
    await expect(client.addToWhitelist('123', 'player-1')).rejects.toMatchObject({
      name: 'NitradoApiError',
      status: null,
      endpoint: '/services/123/gameservers/settings',
      message: 'write timeout',
    });

    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(requestMock.mock.calls[1][0]).toEqual(expect.objectContaining({ method: 'POST' }));
  });
});
