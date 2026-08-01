/**
 * NIT-001 Regression: validateTokenDetailed liefert differenzierte Ergebnisse.
 * Nur INVALID (401/403 bzw. server-seitig ungueltig) rechtfertigt EXPIRED;
 * transiente Fehler (5xx/429/Netzwerk/Circuit-Open) bleiben transient.
 */
const requestMock = jest.fn();
jest.mock('axios', () => ({
  __esModule: true,
  default: { create: () => ({ request: requestMock }) },
}));

class FakeCircuitOpen extends Error {}
jest.mock('../../src/modules/nitrado/circuitBreaker', () => {
  const b = { preflight: jest.fn(), recordFailure: jest.fn(), recordSuccess: jest.fn() };
  return {
    __esModule: true,
    getNitradoBreaker: () => b,
    opClassForMethod: (m: string) => (m === 'GET' ? 'READ' : 'WRITE'),
    nitradoBreaker: b,
    NitradoCircuitOpenError: FakeCircuitOpen,
  };
});
jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { NitradoClient } from '../../src/modules/nitrado/nitradoClient';
import { nitradoBreaker } from '../../src/modules/nitrado/circuitBreaker';

beforeEach(() => { jest.clearAllMocks(); });

describe('NIT-001 — validateTokenDetailed', () => {
  it('VALID bei token.valid=true', async () => {
    requestMock.mockResolvedValue({ status: 200, headers: {}, data: { data: { token: { valid: true } } } });
    const r = await new NitradoClient('token-1234').validateTokenDetailed();
    expect(r.kind).toBe('VALID');
  });

  it('INVALID bei token.valid=false (200)', async () => {
    requestMock.mockResolvedValue({ status: 200, headers: {}, data: { data: { token: { valid: false } } } });
    const r = await new NitradoClient('token-1234').validateTokenDetailed();
    expect(r).toEqual({ kind: 'INVALID', status: null });
  });

  it('VALID bei 2xx auch ohne valid-Feld (robuste Antwortstruktur)', async () => {
    requestMock.mockResolvedValue({ status: 200, headers: {}, data: { data: { token: {} } } });
    const r = await new NitradoClient('token-1234').validateTokenDetailed();
    expect(r.kind).toBe('VALID');
  });

  it('INVALID mit Status 401', async () => {
    requestMock.mockResolvedValue({ status: 401, headers: {}, data: { message: 'unauthorized' } });
    const r = await new NitradoClient('token-1234').validateTokenDetailed();
    expect(r).toEqual({ kind: 'INVALID', status: 401 });
  });

  it('TRANSIENT_FAILURE bei dauerhaftem 500 (kein EXPIRED)', async () => {
    requestMock.mockResolvedValue({ status: 500, headers: {}, data: { message: 'server error' } });
    const r = await new NitradoClient('token-1234').validateTokenDetailed();
    expect(r.kind).toBe('TRANSIENT_FAILURE');
  });

  it('RATE_LIMITED bei dauerhaftem 429', async () => {
    requestMock.mockResolvedValue({ status: 429, headers: { 'retry-after': '0' }, data: {} });
    const r = await new NitradoClient('token-1234').validateTokenDetailed();
    expect(r.kind).toBe('RATE_LIMITED');
  });

  it('CIRCUIT_OPEN wenn der Breaker offen ist', async () => {
    (nitradoBreaker.preflight as jest.Mock).mockImplementationOnce(() => { throw new FakeCircuitOpen('open'); });
    const r = await new NitradoClient('token-1234').validateTokenDetailed();
    expect(r.kind).toBe('CIRCUIT_OPEN');
  });

  it('TRANSIENT_FAILURE bei Netzwerkfehler', async () => {
    requestMock.mockRejectedValue(new Error('ECONNRESET'));
    const r = await new NitradoClient('token-1234').validateTokenDetailed();
    expect(r.kind).toBe('TRANSIENT_FAILURE');
  });
});
