/**
 * F-011 / Nitrado-1V Regression: Retry-Status bleibt erhalten und jeder echte
 * HTTP-Versuch wird durch den Circuit-Breaker gefencet. Terminale 5xx zaehlen
 * vollstaendig; erreichbare 4xx<>429 schliessen einen HALF_OPEN-Probe-Slot.
 */
const requestMock = jest.fn();
const mockBreaker = {
  preflight: jest.fn(),
  recordFailure: jest.fn(),
  recordSuccess: jest.fn(),
};

jest.mock('axios', () => ({
  __esModule: true,
  default: { create: () => ({ request: requestMock }) },
}));
jest.mock('../../src/modules/nitrado/circuitBreaker', () => ({
  __esModule: true,
  getNitradoBreaker: () => mockBreaker,
  opClassForMethod: (m: string) => (m === 'GET' ? 'READ' : 'WRITE'),
  nitradoBreaker: mockBreaker,
  NitradoCircuitOpenError: class NitradoCircuitOpenError extends Error {},
}));
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

describe('F-011 / Nitrado-1V — Retry + Circuit accounting', () => {
  it('wirft NitradoApiError mit Status 429 nach dauerhaftem 429', async () => {
    requestMock.mockResolvedValue({ status: 429, headers: { 'retry-after': '0' }, data: {} });
    const client = new NitradoClient('token-1234');
    await expect(client.listServices()).rejects.toMatchObject({
      name: 'NitradoApiError',
      status: 429,
      endpoint: '/services',
    });
    expect(requestMock).toHaveBeenCalledTimes(3);
    expect(mockBreaker.preflight).toHaveBeenCalledTimes(3);
    expect(mockBreaker.recordFailure).toHaveBeenCalledTimes(3);
  });

  it('gibt nach einem 429 bei Folge-Erfolg das Ergebnis zurueck', async () => {
    requestMock
      .mockResolvedValueOnce({ status: 429, headers: { 'retry-after': '0' }, data: {} })
      .mockResolvedValueOnce({ status: 200, headers: {}, data: { data: { services: [] } } });
    const client = new NitradoClient('token-1234');
    await expect(client.listServices()).resolves.toEqual([]);
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(mockBreaker.preflight).toHaveBeenCalledTimes(2);
    expect(mockBreaker.recordFailure).toHaveBeenCalledTimes(1);
    expect(mockBreaker.recordSuccess).toHaveBeenCalledTimes(1);
  });

  it('zaehlt auch den dritten/terminalen 5xx als Circuit-Failure', async () => {
    requestMock.mockResolvedValue({ status: 500, headers: {}, data: { message: 'upstream down' } });
    const client = new NitradoClient('token-1234');

    await expect(client.listServices()).rejects.toMatchObject({
      name: 'NitradoApiError',
      status: 500,
      endpoint: '/services',
    });

    expect(requestMock).toHaveBeenCalledTimes(3);
    expect(mockBreaker.preflight).toHaveBeenCalledTimes(3);
    expect(mockBreaker.recordFailure).toHaveBeenCalledTimes(3);
    expect(mockBreaker.recordSuccess).not.toHaveBeenCalled();
  });

  it('wertet nicht-retrybare 4xx als erreichbaren Server und schliesst den Probe-Slot', async () => {
    requestMock.mockResolvedValue({ status: 404, headers: {}, data: { message: 'not found' } });
    const client = new NitradoClient('token-1234');

    await expect(client.listServices()).rejects.toMatchObject({
      name: 'NitradoApiError',
      status: 404,
      endpoint: '/services',
    });

    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(mockBreaker.preflight).toHaveBeenCalledTimes(1);
    expect(mockBreaker.recordSuccess).toHaveBeenCalledTimes(1);
    expect(mockBreaker.recordFailure).not.toHaveBeenCalled();
  });
});
