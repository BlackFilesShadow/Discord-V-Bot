/**
 * NIT-002: Circuit-Breaker je Operationsklasse. Ein offener WRITE-Breaker darf
 * den READ-Pfad NICHT blockieren (und umgekehrt).
 */
jest.mock('../../src/utils/logger', () => ({ __esModule: true, logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() } }));

import {
  getNitradoBreaker,
  opClassForMethod,
  resetAllNitradoBreakers,
  getNitradoBreakerStatus,
  NitradoCircuitOpenError,
} from '../../src/modules/nitrado/circuitBreaker';

beforeEach(() => { resetAllNitradoBreakers(); });

describe('NIT-002 — Breaker-Isolation READ/WRITE', () => {
  it('mappt Methoden auf Operationsklassen', () => {
    expect(opClassForMethod('GET')).toBe('READ');
    expect(opClassForMethod('POST')).toBe('WRITE');
    expect(opClassForMethod('DELETE')).toBe('WRITE');
  });

  it('offener WRITE-Breaker blockiert READ nicht', () => {
    const write = getNitradoBreaker('WRITE');
    for (let i = 0; i < 5; i++) write.recordFailure();
    expect(() => write.preflight()).toThrow(NitradoCircuitOpenError);

    const read = getNitradoBreaker('READ');
    expect(() => read.preflight()).not.toThrow();
    expect(getNitradoBreakerStatus().READ.state).toBe('CLOSED');
    expect(getNitradoBreakerStatus().WRITE.state).toBe('OPEN');
  });

  it('offener READ-Breaker blockiert WRITE nicht', () => {
    const read = getNitradoBreaker('READ');
    for (let i = 0; i < 5; i++) read.recordFailure();
    expect(() => read.preflight()).toThrow(NitradoCircuitOpenError);
    expect(() => getNitradoBreaker('WRITE').preflight()).not.toThrow();
  });
});
