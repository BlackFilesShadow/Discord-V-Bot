const requestMock = jest.fn();
const getMock = jest.fn();

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    create: () => ({ request: requestMock }),
    get: (...args: unknown[]) => getMock(...args),
  },
}));

jest.mock('../../src/modules/nitrado/circuitBreaker', () => {
  const breaker = { preflight: jest.fn(), recordFailure: jest.fn(), recordSuccess: jest.fn() };
  return {
    __esModule: true,
    getNitradoBreaker: () => breaker,
    opClassForMethod: (method: string) => (method === 'GET' ? 'READ' : 'WRITE'),
    NitradoCircuitOpenError: class NitradoCircuitOpenError extends Error {},
  };
});

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { NitradoClient } from '../../src/modules/nitrado/nitradoClient';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('Nitrado-1W signed file hop retry matrix', () => {
  it('recovers from a signed seek timeout on the second bounded attempt', async () => {
    jest.useFakeTimers();
    try {
      requestMock.mockResolvedValueOnce({
        status: 200,
        headers: {},
        data: { data: { token: { url: 'https://download.example/seek', token: 'seek-secret' } } },
      });
      getMock
        .mockRejectedValueOnce(Object.assign(new Error('signed timeout'), { code: 'ECONNABORTED' }))
        .mockResolvedValueOnce({ data: 'recovered' });

      const client = new NitradoClient('token-1234');
      const pending = client.downloadFileRange('123', '/logs/live.ADM', 0, 4096);
      await jest.advanceTimersByTimeAsync(500);

      await expect(pending).resolves.toBe('recovered');
      expect(getMock).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('bounds signed 429 to three attempts and preserves status 429', async () => {
    requestMock.mockResolvedValueOnce({
      status: 200,
      headers: {},
      data: { data: { token: { url: 'https://download.example/file', token: 'signed-secret' } } },
    });
    const rateLimited = Object.assign(new Error('rate limited'), {
      response: { status: 429, headers: { 'retry-after': '0' } },
    });
    getMock.mockRejectedValue(rateLimited);

    const client = new NitradoClient('token-1234');
    await expect(client.downloadFile('123', '/logs/live.ADM')).rejects.toMatchObject({
      name: 'NitradoApiError',
      status: 429,
      endpoint: 'file_server',
    });
    expect(getMock).toHaveBeenCalledTimes(3);
  });

  it('retries signed 5xx but fails permanent signed 4xx immediately', async () => {
    jest.useFakeTimers();
    try {
      requestMock
        .mockResolvedValueOnce({
          status: 200,
          headers: {},
          data: { data: { token: { url: 'https://download.example/file', token: 'signed-secret' } } },
        })
        .mockResolvedValueOnce({
          status: 200,
          headers: {},
          data: { data: { token: { url: 'https://download.example/file2', token: 'signed-secret' } } },
        });
      getMock
        .mockRejectedValueOnce(Object.assign(new Error('server error'), { response: { status: 503, headers: {} } }))
        .mockResolvedValueOnce({ data: 'ok-after-503' });

      const client = new NitradoClient('token-1234');
      const recovered = client.downloadFile('123', '/logs/live.ADM');
      await jest.advanceTimersByTimeAsync(500);
      await expect(recovered).resolves.toBe('ok-after-503');

      getMock.mockRejectedValueOnce(Object.assign(new Error('forbidden'), { response: { status: 403, headers: {} } }));
      await expect(client.downloadFile('123', '/logs/live2.ADM')).rejects.toMatchObject({
        name: 'NitradoApiError',
        status: 403,
        endpoint: 'file_server',
      });
      expect(getMock).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });
});
