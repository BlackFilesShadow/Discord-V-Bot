/**
 * Live-ADM reads must use the Nitrado signed token and file_server/seek so a
 * growing ADM file can be consumed incrementally.
 */
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

import { NitradoClient, NitradoApiError } from '../../src/modules/nitrado/nitradoClient';

beforeEach(() => { jest.clearAllMocks(); });

describe('Nitrado signed file reads', () => {
  it('reicht den separaten Download-Token an die signed URL weiter', async () => {
    requestMock.mockResolvedValueOnce({
      status: 200,
      headers: {},
      data: { data: { token: { url: 'https://download.example/file', token: 'signed-secret' } } },
    });
    getMock.mockResolvedValueOnce({ data: 'abc' });
    const client = new NitradoClient('token-1234');

    await expect(client.downloadFile('123', '/logs/live.ADM')).resolves.toBe('abc');
    expect(getMock).toHaveBeenCalledWith(
      'https://download.example/file',
      expect.objectContaining({ params: { token: 'signed-secret' } }),
    );
  });

  it('liest einen Bereich ueber file_server/seek mit Offset und Laenge', async () => {
    requestMock.mockResolvedValueOnce({
      status: 200,
      headers: {},
      data: { data: { token: { url: 'https://download.example/seek', token: 'seek-secret' } } },
    });
    getMock.mockResolvedValueOnce({ data: 'new-bytes' });
    const client = new NitradoClient('token-1234');

    await expect(client.downloadFileRange('123', '/logs/live.ADM', 4096, 8192)).resolves.toBe('new-bytes');
    expect(requestMock).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET',
      url: '/services/123/gameservers/file_server/seek',
      params: { file: '/logs/live.ADM', offset: 4096, length: 8192, mode: 'raw' },
    }));
    expect(getMock).toHaveBeenCalledWith(
      'https://download.example/seek',
      expect.objectContaining({ params: { token: 'seek-secret' } }),
    );
  });

  it('verweigert uebergrosse Seek-Requests fail-closed', async () => {
    const client = new NitradoClient('token-1234');
    await expect(client.downloadFileRange('123', '/logs/live.ADM', 0, 3 * 1024 * 1024)).rejects.toBeInstanceOf(NitradoApiError);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('retryt einen Timeout im signierten Seek-Hop bounded und liefert danach Daten', async () => {
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

  it('erhaelt 429 am signierten Hop nach drei Versuchen und respektiert Retry-After', async () => {
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

  it('retryt 5xx am signierten Hop und bricht permanente 4xx sofort ab', async () => {
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
