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
});
