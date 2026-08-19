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
    opClassForMethod: (method: string) => method === 'GET' ? 'READ' : 'WRITE',
    NitradoCircuitOpenError: class NitradoCircuitOpenError extends Error {},
  };
});

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { NitradoClient } from '../../src/modules/nitrado/nitradoClient';

const fullPath = '/logs/live.ADM';

function signedMetadata(url = 'https://download.example/signed') {
  return {
    status: 200,
    headers: {},
    data: { data: { token: { url, token: 'signed-secret' } } },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(global, 'setTimeout').mockImplementation(((handler: (...args: unknown[]) => void) => {
    handler();
    return {} as NodeJS.Timeout;
  }) as typeof setTimeout);
  requestMock.mockResolvedValue(signedMetadata());
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('Nitrado-1W signed download retry taxonomy', () => {
  it('retries 429 with Retry-After and recovers on the next signed hop', async () => {
    getMock
      .mockResolvedValueOnce({ status: 429, headers: { 'retry-after': '0' }, data: '' })
      .mockResolvedValueOnce({ status: 200, headers: {}, data: 'recovered' });

    const client = new NitradoClient('token-1234');
    await expect(client.downloadFile('123', fullPath)).resolves.toBe('recovered');
    expect(getMock).toHaveBeenCalledTimes(2);
  });

  it('preserves terminal signed-hop 429 after exactly three attempts', async () => {
    getMock.mockResolvedValue({ status: 429, headers: { 'retry-after': '0' }, data: '' });

    const client = new NitradoClient('token-1234');
    await expect(client.downloadFile('123', fullPath)).rejects.toMatchObject({
      name: 'NitradoApiError',
      status: 429,
      endpoint: fullPath,
    });
    expect(getMock).toHaveBeenCalledTimes(3);
  });

  it('retries signed-hop 5xx and recovers', async () => {
    getMock
      .mockResolvedValueOnce({ status: 503, headers: {}, data: '' })
      .mockResolvedValueOnce({ status: 200, headers: {}, data: 'new-bytes' });

    const client = new NitradoClient('token-1234');
    await expect(client.downloadFileRange('123', fullPath, 0, 1024)).resolves.toBe('new-bytes');
    expect(getMock).toHaveBeenCalledTimes(2);
  });

  it('preserves terminal signed-hop 5xx after exactly three attempts', async () => {
    getMock.mockResolvedValue({ status: 503, headers: {}, data: '' });

    const client = new NitradoClient('token-1234');
    await expect(client.downloadFile('123', fullPath)).rejects.toMatchObject({
      name: 'NitradoApiError',
      status: 503,
      endpoint: fullPath,
      message: 'Download HTTP 503',
    });
    expect(getMock).toHaveBeenCalledTimes(3);
  });

  it('retries a signed-hop transport timeout and recovers', async () => {
    getMock
      .mockRejectedValueOnce(Object.assign(new Error('signed timeout'), { code: 'ECONNABORTED' }))
      .mockResolvedValueOnce({ status: 200, headers: {}, data: 'recovered' });

    const client = new NitradoClient('token-1234');
    await expect(client.downloadFile('123', fullPath)).resolves.toBe('recovered');
    expect(getMock).toHaveBeenCalledTimes(2);
  });

  it('bounds persistent signed-hop transport failures and keeps the file path as endpoint', async () => {
    getMock.mockRejectedValue(Object.assign(new Error('signed timeout'), { code: 'ECONNABORTED' }));

    const client = new NitradoClient('token-1234');
    await expect(client.downloadFile('123', fullPath)).rejects.toMatchObject({
      name: 'NitradoApiError',
      status: null,
      endpoint: fullPath,
      message: 'signed timeout',
    });
    expect(getMock).toHaveBeenCalledTimes(3);
  });

  it('keeps permanent signed-hop 4xx fail-fast without retry', async () => {
    getMock.mockResolvedValue({ status: 404, headers: {}, data: '' });

    const client = new NitradoClient('token-1234');
    await expect(client.downloadFile('123', fullPath)).rejects.toMatchObject({
      name: 'NitradoApiError',
      status: 404,
      endpoint: fullPath,
      message: 'Download HTTP 404',
    });
    expect(getMock).toHaveBeenCalledTimes(1);
  });
});
