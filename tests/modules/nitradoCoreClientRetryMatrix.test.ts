const mockRequest = jest.fn();
const mockBreaker = {
  preflight: jest.fn(),
  recordFailure: jest.fn(),
  recordSuccess: jest.fn(),
};

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    create: () => ({ request: mockRequest }),
    get: jest.fn(),
  },
}));

jest.mock('../../src/modules/nitrado/circuitBreaker', () => ({
  __esModule: true,
  getNitradoBreaker: () => mockBreaker,
  opClassForMethod: (method: string) => method === 'GET' ? 'READ' : 'WRITE',
  NitradoCircuitOpenError: class NitradoCircuitOpenError extends Error {},
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { NitradoClient } from '../../src/modules/nitrado/nitradoClient';

function timeoutError(message = 'timeout') {
  return Object.assign(new Error(message), { code: 'ECONNABORTED' });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(global, 'setTimeout').mockImplementation(((handler: (...args: unknown[]) => void) => {
    handler();
    return {} as NodeJS.Timeout;
  }) as typeof setTimeout);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('Nitrado-1V core client transient failure matrix', () => {
  it('retries an Axios timeout and recovers on the next attempt', async () => {
    mockRequest
      .mockRejectedValueOnce(timeoutError())
      .mockResolvedValueOnce({ status: 200, headers: {}, data: { data: { services: [] } } });

    const client = new NitradoClient('token-1234');
    await expect(client.listServices()).resolves.toEqual([]);

    expect(mockRequest).toHaveBeenCalledTimes(2);
    expect(mockBreaker.preflight).toHaveBeenCalledTimes(2);
    expect(mockBreaker.recordFailure).toHaveBeenCalledTimes(1);
    expect(mockBreaker.recordSuccess).toHaveBeenCalledTimes(1);
  });

  it('bounds persistent Axios timeouts to three attempts and preserves transport classification', async () => {
    mockRequest.mockRejectedValue(timeoutError('socket timeout'));

    const client = new NitradoClient('token-1234');
    await expect(client.listServices()).rejects.toMatchObject({
      name: 'NitradoApiError',
      status: null,
      endpoint: '/services',
      message: 'socket timeout',
    });

    expect(mockRequest).toHaveBeenCalledTimes(3);
    expect(mockBreaker.preflight).toHaveBeenCalledTimes(3);
    expect(mockBreaker.recordFailure).toHaveBeenCalledTimes(3);
    expect(mockBreaker.recordSuccess).not.toHaveBeenCalled();
  });

  it('counts every 5xx attempt including the terminal attempt in the circuit breaker', async () => {
    mockRequest.mockResolvedValue({
      status: 500,
      headers: {},
      data: { message: 'upstream unavailable' },
    });

    const client = new NitradoClient('token-1234');
    await expect(client.listServices()).rejects.toMatchObject({
      name: 'NitradoApiError',
      status: 500,
      endpoint: '/services',
      message: 'upstream unavailable',
    });

    expect(mockRequest).toHaveBeenCalledTimes(3);
    expect(mockBreaker.preflight).toHaveBeenCalledTimes(3);
    expect(mockBreaker.recordFailure).toHaveBeenCalledTimes(3);
    expect(mockBreaker.recordSuccess).not.toHaveBeenCalled();
  });

  it('keeps permanent non-429 4xx fail-fast, outside failure accounting, and closes a probe slot', async () => {
    mockRequest.mockResolvedValue({ status: 404, headers: {}, data: { message: 'not found' } });

    const client = new NitradoClient('token-1234');
    await expect(client.listServices()).rejects.toMatchObject({
      name: 'NitradoApiError',
      status: 404,
      endpoint: '/services',
    });

    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(mockBreaker.preflight).toHaveBeenCalledTimes(1);
    expect(mockBreaker.recordFailure).not.toHaveBeenCalled();
    expect(mockBreaker.recordSuccess).toHaveBeenCalledTimes(1);
  });
});
