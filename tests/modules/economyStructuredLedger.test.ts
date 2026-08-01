/**
 * Phase 5: strukturierte Ledger-Saetze fuer deposit/withdraw/transferBank.
 * Beweis: korrekte wallet/bankDelta + bei fehlender Deckung KEIN Ledger-Satz.
 */
const ledgerCreate = jest.fn();
const ledgerCreateMany = jest.fn();
const txCreate = jest.fn();
const txCreateMany = jest.fn();
const acctUpdateMany = jest.fn();
const acctUpsert = jest.fn();

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
      economyAccount: { updateMany: acctUpdateMany, upsert: acctUpsert },
      economyTransaction: { create: txCreate, createMany: txCreateMany },
      economyLedgerEntry: { create: ledgerCreate, createMany: ledgerCreateMany },
    }),
  },
}));

import { deposit, withdraw, transferBank } from '../../src/modules/economy/repository';

const G = 'g' as never;
const U = 'u1' as never;
const U2 = 'u2' as never;

beforeEach(() => {
  jest.clearAllMocks();
  acctUpdateMany.mockResolvedValue({ count: 1 });
  acctUpsert.mockResolvedValue({});
});

describe('deposit — strukturierter Ledger', () => {
  it('schreibt walletDelta=-amount, bankDelta=+amount', async () => {
    await deposit(G, U, 100n);
    expect(ledgerCreate).toHaveBeenCalledTimes(1);
    const data = ledgerCreate.mock.calls[0][0].data;
    expect(data.walletDelta).toBe(-100n);
    expect(data.bankDelta).toBe(100n);
    expect(data.type).toBe('DEPOSIT');
  });

  it('ohne Deckung -> Fehler, KEIN Ledger-Satz', async () => {
    acctUpdateMany.mockResolvedValue({ count: 0 });
    await expect(deposit(G, U, 100n)).rejects.toThrow('Wallet zu klein');
    expect(ledgerCreate).not.toHaveBeenCalled();
  });
});

describe('withdraw — strukturierter Ledger', () => {
  it('schreibt bankDelta=-amount, walletDelta=+amount', async () => {
    await withdraw(G, U, 40n);
    const data = ledgerCreate.mock.calls[0][0].data;
    expect(data.bankDelta).toBe(-40n);
    expect(data.walletDelta).toBe(40n);
    expect(data.type).toBe('WITHDRAW');
  });

  it('ohne Deckung -> Fehler, KEIN Ledger-Satz', async () => {
    acctUpdateMany.mockResolvedValue({ count: 0 });
    await expect(withdraw(G, U, 40n)).rejects.toThrow('Bank zu klein');
    expect(ledgerCreate).not.toHaveBeenCalled();
  });
});

describe('transferBank — strukturierter Ledger', () => {
  it('schreibt zwei Saetze (from -amount, to +amount)', async () => {
    await transferBank({ guildId: G, fromUserId: U, toUserId: U2, amount: 250n });
    expect(ledgerCreateMany).toHaveBeenCalledTimes(1);
    const rows = ledgerCreateMany.mock.calls[0][0].data;
    expect(rows[0].bankDelta).toBe(-250n);
    expect(rows[1].bankDelta).toBe(250n);
  });

  it('ohne Deckung -> Fehler, KEIN Ledger-Satz', async () => {
    acctUpdateMany.mockResolvedValue({ count: 0 });
    await expect(transferBank({ guildId: G, fromUserId: U, toUserId: U2, amount: 250n })).rejects.toThrow('Bank zu klein');
    expect(ledgerCreateMany).not.toHaveBeenCalled();
  });
});
