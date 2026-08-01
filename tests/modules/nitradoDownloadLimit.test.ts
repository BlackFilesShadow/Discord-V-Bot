/**
 * NIT-011: Signed-URL-Downloads (ADM-/Log-Dateien) haben eine harte
 * Groessenobergrenze gegen Speicher-Erschoepfung.
 */
const requestMock = jest.fn();
const getMock = jest.fn();
jest.mock('axios', () => ({
  __esModule: true,
  default: { create: () => ({ request: requestMock }), get: (...a: unknown[]) => getMock(...a) },
}));
jest.mock('../../src/modules/nitrado/circuitBreaker', () => {
  const b = { preflight: jest.fn(), recordFailure: jest.fn(), recordSuccess: jest.fn() };
  return {
    __esModule: true,
    getNitradoBreaker: () => b,
    opClassForMethod: (m: string) => (m === 'GET' ? 'READ' : 'WRITE'),
    nitradoBreaker: b,
    NitradoCircuitOpenError: class extends Error {},
  };
});
jest.mock('../../src/utils/logger', () => ({ __esModule: true, logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() } }));

import { NitradoClient } from '../../src/modules/nitrado/nitradoClient';

beforeEach(() => { jest.clearAllMocks(); });

describe('NIT-011 — Download-Groessenlimit', () => {
  it('setzt maxContentLength/maxBodyLength beim signed-URL-Download', async () => {
    requestMock.mockResolvedValue({ status: 200, headers: {}, data: { data: { token: { url: 'https://dl.example/f.adm' } } } });
    getMock.mockResolvedValue({ data: 'log-content' });
    const client = new NitradoClient('token-1234');
    const content = await client.downloadFile('123', '/dir/f.adm');
    expect(content).toBe('log-content');
    const cap = 50 * 1024 * 1024;
    expect(getMock).toHaveBeenCalledWith(
      'https://dl.example/f.adm',
      expect.objectContaining({ maxContentLength: cap, maxBodyLength: cap }),
    );
  });
});
