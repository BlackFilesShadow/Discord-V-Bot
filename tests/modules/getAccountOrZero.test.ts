/**
 * Phase 5: GET erzeugt keinen Account. getAccountOrZero liest nur — fehlt der
 * Account, kommt ein Null-Konto OHNE DB-Write zurueck.
 */
const findUnique = jest.fn();
const upsert = jest.fn();
const create = jest.fn();

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    economyAccount: { findUnique, upsert, create },
    economyConfig: { findUnique: jest.fn() },
  },
}));

import { getAccountOrZero } from '../../src/modules/economy/repository';

const G = 'guild-1' as never;
const U = 'user-1' as never;

beforeEach(() => { jest.clearAllMocks(); });

describe('getAccountOrZero', () => {
  it('liefert Null-Konto ohne DB-Write, wenn kein Account existiert', async () => {
    findUnique.mockResolvedValue(null);
    const acc = await getAccountOrZero(G, U);
    expect(acc.walletBalance).toBe(0n);
    expect(acc.bankBalance).toBe(0n);
    expect(acc.lifetimeEarned).toBe(0n);
    expect(upsert).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('liefert das bestehende Konto', async () => {
    findUnique.mockResolvedValue({
      guildId: G, userDiscordId: U,
      walletBalance: 500n, bankBalance: 200n, lifetimeEarned: 700n, lifetimeSpent: 0n,
    });
    const acc = await getAccountOrZero(G, U);
    expect(acc.walletBalance).toBe(500n);
    expect(acc.bankBalance).toBe(200n);
    expect(upsert).not.toHaveBeenCalled();
  });
});
