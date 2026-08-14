/**
 * EconomyLedger (Phase 5) — idempotentes, gameserver-gescoptes Buchungsprimitiv.
 *
 * `bookLedgerEntry` schreibt genau EINEN EconomyLedgerEntry und verrechnet
 * wallet-/bankDelta atomar auf den Account desselben Guild+Gameserver-Scopes.
 * Die Idempotenz kommt aus dem eindeutigen `idempotencyKey`: dieselbe Quelle
 * (AdmEvent-Reward, Zins-Lauf, Spielzeit-Bucket) kann NIE zweimal Geld erzeugen.
 *
 * WICHTIG: Seit Phase 4 ist Wirtschaftsdaten-Wahrheit immer servergescoppt.
 * Deshalb ist `nitradoConnId` hier zwingend. Ein Aufrufer kann nicht versehentlich
 * auf einen Legacy-/Guild-weiten Account zurueckfallen.
 */

export interface LedgerEntryInput {
  idempotencyKey: string;
  guildId: string;
  nitradoConnId: string;
  userDiscordId: string;
  walletDelta?: bigint;
  bankDelta?: bigint;
  type: string; // EconomyTxType
  reason?: string | null;
  buckets?: number;
  sourceRef?: string | null;
}

/** Aufteilung eines Buchungssatzes in lifetimeEarned/lifetimeSpent-Anteile. */
export function computeLifetimeDeltas(walletDelta: bigint, bankDelta: bigint): { earned: bigint; spent: bigint } {
  const earned = (walletDelta > 0n ? walletDelta : 0n) + (bankDelta > 0n ? bankDelta : 0n);
  const spent = (walletDelta < 0n ? -walletDelta : 0n) + (bankDelta < 0n ? -bankDelta : 0n);
  return { earned, spent };
}

export interface LedgerTx {
  economyLedgerEntry: {
    create: (args: { data: Record<string, unknown> }) => Promise<{ id: string }>;
  };
  economyAccount: {
    upsert: (args: {
      where: Record<string, unknown>;
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => Promise<unknown>;
  };
}

export interface LedgerClient {
  $transaction: <T>(fn: (tx: LedgerTx) => Promise<T>) => Promise<T>;
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
}

/**
 * Bucht einen Ledger-Eintrag idempotent. Existiert der idempotencyKey bereits,
 * wird NICHTS veraendert und `{ booked: false }` zurueckgegeben. Andernfalls
 * werden Eintrag + exakt derselbe servergescoppte Account in EINER Transaktion
 * geschrieben.
 */
export async function bookLedgerEntry(
  client: LedgerClient,
  input: LedgerEntryInput,
): Promise<{ booked: boolean; entryId?: string }> {
  const walletDelta = input.walletDelta ?? 0n;
  const bankDelta = input.bankDelta ?? 0n;
  const { earned, spent } = computeLifetimeDeltas(walletDelta, bankDelta);

  try {
    const entryId = await client.$transaction(async (tx) => {
      const entry = await tx.economyLedgerEntry.create({
        data: {
          idempotencyKey: input.idempotencyKey,
          guildId: input.guildId,
          nitradoConnId: input.nitradoConnId,
          userDiscordId: input.userDiscordId,
          walletDelta,
          bankDelta,
          type: input.type,
          reason: input.reason ?? null,
          buckets: input.buckets ?? 0,
          sourceRef: input.sourceRef ?? null,
        },
      });
      await tx.economyAccount.upsert({
        where: {
          guildServerUser: {
            guildId: input.guildId,
            nitradoConnId: input.nitradoConnId,
            userDiscordId: input.userDiscordId,
          },
        },
        create: {
          guildId: input.guildId,
          nitradoConnId: input.nitradoConnId,
          userDiscordId: input.userDiscordId,
          walletBalance: walletDelta,
          bankBalance: bankDelta,
          lifetimeEarned: earned,
          lifetimeSpent: spent,
        },
        update: {
          walletBalance: { increment: walletDelta },
          bankBalance: { increment: bankDelta },
          lifetimeEarned: { increment: earned },
          lifetimeSpent: { increment: spent },
        },
      });
      return entry.id;
    });
    return { booked: true, entryId };
  } catch (e) {
    if (isUniqueViolation(e)) return { booked: false }; // bereits gebucht -> idempotent
    throw e;
  }
}
