/**
 * Phase 5, Schritt 1: idempotentes Ledger-Buchungsprimitiv.
 * Kernbeweis: derselbe idempotencyKey bucht NIE zweimal (kein Doppel-Geld).
 */
import {
  bookLedgerEntry, computeLifetimeDeltas, type LedgerClient, type LedgerTx,
} from '../../src/modules/economy/ledger';

describe('computeLifetimeDeltas', () => {
  it('positive Deltas -> earned', () => {
    expect(computeLifetimeDeltas(100n, 50n)).toEqual({ earned: 150n, spent: 0n });
  });
  it('negative Deltas -> spent (Betrag)', () => {
    expect(computeLifetimeDeltas(-40n, -10n)).toEqual({ earned: 0n, spent: 50n });
  });
  it('gemischt', () => {
    expect(computeLifetimeDeltas(100n, -30n)).toEqual({ earned: 100n, spent: 30n });
  });
});

interface Account { walletBalance: bigint; bankBalance: bigint; lifetimeEarned: bigint; lifetimeSpent: bigint }

function makeClient() {
  const keys = new Set<string>();
  const accounts = new Map<string, Account>();
  const client: LedgerClient = {
    $transaction: async <T>(fn: (tx: LedgerTx) => Promise<T>): Promise<T> => {
      // Snapshot fuer atomares Rollback bei P2002.
      const keysBefore = new Set(keys);
      const accBefore = new Map([...accounts].map(([k, v]) => [k, { ...v }]));
      try {
        const tx: LedgerTx = {
          economyLedgerEntry: {
            create: async ({ data }) => {
              const key = data.idempotencyKey as string;
              if (keys.has(key)) { const err = new Error('unique') as Error & { code: string }; err.code = 'P2002'; throw err; }
              keys.add(key);
              return { id: 'ledger-' + key };
            },
          },
          economyAccount: {
            upsert: async ({ where, create, update }) => {
              const w = where.guildId_userDiscordId as { guildId: string; userDiscordId: string };
              const k = `${w.guildId}:${w.userDiscordId}`;
              if (!accounts.has(k)) {
                accounts.set(k, {
                  walletBalance: create.walletBalance as bigint,
                  bankBalance: create.bankBalance as bigint,
                  lifetimeEarned: create.lifetimeEarned as bigint,
                  lifetimeSpent: create.lifetimeSpent as bigint,
                });
              } else {
                const a = accounts.get(k)!;
                a.walletBalance += (update.walletBalance as { increment: bigint }).increment;
                a.bankBalance += (update.bankBalance as { increment: bigint }).increment;
                a.lifetimeEarned += (update.lifetimeEarned as { increment: bigint }).increment;
                a.lifetimeSpent += (update.lifetimeSpent as { increment: bigint }).increment;
              }
              return accounts.get(k);
            },
          },
        };
        return await fn(tx);
      } catch (e) {
        // Rollback
        keys.clear(); for (const kk of keysBefore) keys.add(kk);
        accounts.clear(); for (const [kk, vv] of accBefore) accounts.set(kk, vv);
        throw e;
      }
    },
  };
  return { client, accounts };
}

describe('bookLedgerEntry — Idempotenz', () => {
  const base = { guildId: 'g', userDiscordId: 'u', type: 'PLAYTIME_REWARD' as const };

  it('bucht Wallet-Gutschrift und legt Account an', async () => {
    const { client, accounts } = makeClient();
    const r = await bookLedgerEntry(client, { ...base, idempotencyKey: 'k1', walletDelta: 250n });
    expect(r.booked).toBe(true);
    expect(accounts.get('g:u')).toEqual({ walletBalance: 250n, bankBalance: 0n, lifetimeEarned: 250n, lifetimeSpent: 0n });
  });

  it('zweite Buchung mit gleichem Key ist No-op (kein Doppel-Geld)', async () => {
    const { client, accounts } = makeClient();
    await bookLedgerEntry(client, { ...base, idempotencyKey: 'k1', walletDelta: 250n });
    const r2 = await bookLedgerEntry(client, { ...base, idempotencyKey: 'k1', walletDelta: 250n });
    expect(r2.booked).toBe(false);
    expect(accounts.get('g:u')!.walletBalance).toBe(250n); // unveraendert
  });

  it('verschiedene Keys summieren sich', async () => {
    const { client, accounts } = makeClient();
    await bookLedgerEntry(client, { ...base, idempotencyKey: 'k1', walletDelta: 100n });
    await bookLedgerEntry(client, { ...base, idempotencyKey: 'k2', walletDelta: 50n, bankDelta: 30n });
    const a = accounts.get('g:u')!;
    expect(a.walletBalance).toBe(150n);
    expect(a.bankBalance).toBe(30n);
    expect(a.lifetimeEarned).toBe(180n);
  });

  it('Abzug reduziert Balance und zaehlt als spent', async () => {
    const { client, accounts } = makeClient();
    await bookLedgerEntry(client, { ...base, idempotencyKey: 'k1', walletDelta: 200n });
    await bookLedgerEntry(client, { ...base, idempotencyKey: 'k2', walletDelta: -80n, type: 'WITHDRAW' });
    const a = accounts.get('g:u')!;
    expect(a.walletBalance).toBe(120n);
    expect(a.lifetimeSpent).toBe(80n);
  });
});
