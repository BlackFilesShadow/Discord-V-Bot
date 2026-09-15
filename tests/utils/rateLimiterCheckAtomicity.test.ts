const mockUpdateMany = jest.fn();
const mockFindUnique = jest.fn();
const mockUpsert = jest.fn();

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    rateLimitEntry: {
      updateMany: (...a: unknown[]) => mockUpdateMany(...a),
      findUnique: (...a: unknown[]) => mockFindUnique(...a),
      upsert: (...a: unknown[]) => mockUpsert(...a),
    },
  },
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  logSecurity: jest.fn(),
}));

import { checkRateLimit } from '../../src/utils/rateLimiter';

describe('checkRateLimit (Regressionsschutz: atomarer Increment statt TOCTOU-Race)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('erhoeht atomar per bedingtem updateMany, nicht per read-then-write', async () => {
    mockUpdateMany.mockResolvedValueOnce({ count: 1 });
    mockFindUnique.mockResolvedValueOnce({ count: 5, windowStart: new Date() });

    const result = await checkRateLimit('user-1', 'ai');

    expect(result.allowed).toBe(true);
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    const call = mockUpdateMany.mock.calls[0][0] as { where: { count: { lt: number } }; data: { count: { increment: number } } };
    expect(call.data).toEqual({ count: { increment: 1 } });
    expect(call.where.count).toEqual({ lt: 20 });
  });

  it('lehnt ab, wenn das Fenster aktiv ist und das Limit bereits erreicht wurde', async () => {
    mockUpdateMany.mockResolvedValueOnce({ count: 0 });
    mockFindUnique.mockResolvedValueOnce({ count: 20, windowStart: new Date() });

    const result = await checkRateLimit('user-1', 'ai');

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('behandelt den Race-Grenzfall (Fenster wurde parallel gerade erst eroeffnet) per Retry statt falscher Ablehnung', async () => {
    // 1. Versuch: updateMany matcht nichts (Zeile existierte zum Zeitpunkt des
    //    Schreibversuchs noch nicht).
    mockUpdateMany.mockResolvedValueOnce({ count: 0 });
    // Nachlesen zeigt: eine parallele Anfrage hat inzwischen ein frisches
    // Fenster mit count < Limit angelegt -> echter Race, kein erreichtes Limit.
    mockFindUnique.mockResolvedValueOnce({ count: 1, windowStart: new Date() });
    // 2. Versuch: jetzt existiert die Zeile, Increment klappt.
    mockUpdateMany.mockResolvedValueOnce({ count: 1 });
    mockFindUnique.mockResolvedValueOnce({ count: 2, windowStart: new Date() });

    const result = await checkRateLimit('user-1', 'ai');

    expect(result.allowed).toBe(true);
    expect(mockUpdateMany).toHaveBeenCalledTimes(2);
  });

  it('eroeffnet per upsert ein neues Fenster, wenn kein aktiver Eintrag existiert', async () => {
    mockUpdateMany.mockResolvedValueOnce({ count: 0 });
    mockFindUnique.mockResolvedValueOnce(null);
    mockUpsert.mockResolvedValueOnce({});

    const result = await checkRateLimit('user-1', 'ai');

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(19);
    expect(mockUpsert).toHaveBeenCalledTimes(1);
  });

  it('faellt fail-closed aus, wenn nach zwei Versuchen immer noch keine eindeutige Entscheidung moeglich ist', async () => {
    // Beide Versuche liefern denselben mehrdeutigen Zustand (Fenster aktiv,
    // count < Limit, aber der Increment matcht trotzdem nie - z.B. starke
    // Gleichzeitigkeit ueber die gesamte Retry-Dauer hinweg).
    mockUpdateMany.mockResolvedValue({ count: 0 });
    mockFindUnique.mockResolvedValue({ count: 1, windowStart: new Date() });

    const result = await checkRateLimit('user-1', 'ai');

    expect(result.allowed).toBe(false);
    expect(mockUpdateMany).toHaveBeenCalledTimes(2);
  });
});
