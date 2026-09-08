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

export const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;
export const POSTGRES_BIGINT_MIN = -9_223_372_036_854_775_808n;

export class EconomyLedgerRangeError extends Error {
  readonly code = 'ECONOMY_LEDGER_RANGE';

  constructor(field: string) {
    super(`Economy-Zahlenbereich fuer ${field} ist ausgeschoepft.`);
    this.name = 'EconomyLedgerRangeError';
  }
}

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

interface EconomyAccountRangeRow {
  walletBalance: bigint;
  bankBalance: bigint;
  lifetimeEarned: bigint;
  lifetimeSpent: bigint;
}

export interface LedgerTx {
  /** Full Prisma transaction clients expose both raw primitives. */
  $queryRawUnsafe?: <T = unknown>(query: string, ...values: unknown[]) => Promise<T>;
  $executeRawUnsafe?: (query: string, ...values: unknown[]) => Promise<number>;
  economyLedgerEntry: {
    create: (args: { data: Record<string, unknown> }) => Promise<{ id: string }>;
    findUnique?: (args: {
      where: {
        idempotencyKey: string;
        guildId: string;
        nitradoConnId: string;
        userDiscordId: string;
      };
      select: { id: true };
    }) => Promise<{ id: string } | null>;
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

function assertPostgresBigint(value: bigint, field: string): void {
  if (value < POSTGRES_BIGINT_MIN || value > POSTGRES_BIGINT_MAX) {
    throw new EconomyLedgerRangeError(field);
  }
}

function accountLockKey(input: LedgerEntryInput): string {
  return `economy-account:${input.guildId}:${input.nitradoConnId}:${input.userDiscordId}`;
}

async function readAccountRangeRow(tx: LedgerTx, input: LedgerEntryInput): Promise<EconomyAccountRangeRow | null> {
  const rows = await tx.$queryRawUnsafe!<EconomyAccountRangeRow[]>(
    `SELECT "walletBalance", "bankBalance", "lifetimeEarned", "lifetimeSpent"
       FROM "EconomyAccount"
      WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "userDiscordId"=$3
      FOR UPDATE`,
    input.guildId,
    input.nitradoConnId,
    input.userDiscordId,
  );
  return rows[0] ?? null;
}

async function assertAccountRange(
  tx: LedgerTx,
  input: LedgerEntryInput,
  walletDelta: bigint,
  bankDelta: bigint,
  earned: bigint,
  spent: bigint,
): Promise<void> {
  // Deltas themselves must be representable even for lightweight test clients
  // that intentionally expose only the narrow ledger interface.
  assertPostgresBigint(walletDelta, 'walletDelta');
  assertPostgresBigint(bankDelta, 'bankDelta');
  assertPostgresBigint(earned, 'lifetimeEarnedDelta');
  assertPostgresBigint(spent, 'lifetimeSpentDelta');

  // A real Prisma transaction exposes both raw primitives. Some unit-test
  // clients intentionally expose only $queryRawUnsafe for their own domain
  // locks; those are not treated as a complete database transaction here.
  if (!tx.$queryRawUnsafe || !tx.$executeRawUnsafe) return;

  // Existing rows are serialized by their row lock alone. This deliberately
  // preserves the lock order of callers (for example Casino already locks the
  // account row before invoking the ledger) and avoids an unnecessary second
  // lock class for the common path.
  let current = await readAccountRangeRow(tx, input);

  if (!current) {
    // FOR UPDATE cannot lock a row that does not exist yet. Serialize only this
    // first-account creation gap with a scoped advisory key, then re-read under
    // FOR UPDATE in case another creator committed while we were waiting.
    await tx.$queryRawUnsafe(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      accountLockKey(input),
    );
    current = await readAccountRangeRow(tx, input);
  }

  const snapshot = current ?? {
    walletBalance: 0n,
    bankBalance: 0n,
    lifetimeEarned: 0n,
    lifetimeSpent: 0n,
  };

  assertPostgresBigint(snapshot.walletBalance + walletDelta, 'walletBalance');
  assertPostgresBigint(snapshot.bankBalance + bankDelta, 'bankBalance');
  assertPostgresBigint(snapshot.lifetimeEarned + earned, 'lifetimeEarned');
  assertPostgresBigint(snapshot.lifetimeSpent + spent, 'lifetimeSpent');
}

/**
 * Transaktionsinterne Variante fuer fachliche State-Machines, die Claim + Geld
 * in EINER gemeinsamen DB-Transaktion committen muessen. Der Caller besitzt die
 * Idempotenz-/Recovery-Entscheidung; ein Unique-Konflikt wird hier absichtlich
 * nicht geschluckt, weil PostgreSQL die laufende Transaktion danach als failed
 * markiert.
 */
export async function bookLedgerEntryInTx(
  tx: LedgerTx,
  input: LedgerEntryInput,
): Promise<{ entryId: string }> {
  const walletDelta = input.walletDelta ?? 0n;
  const bankDelta = input.bankDelta ?? 0n;
  const { earned, spent } = computeLifetimeDeltas(walletDelta, bankDelta);

  await assertAccountRange(tx, input, walletDelta, bankDelta, earned, spent);

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
  return { entryId: entry.id };
}

async function existingLedgerEntryId(client: LedgerClient, input: LedgerEntryInput): Promise<string | null> {
  return client.$transaction(async tx => {
    if (!tx.economyLedgerEntry.findUnique) return null;
    const existing = await tx.economyLedgerEntry.findUnique({
      where: {
        idempotencyKey: input.idempotencyKey,
        guildId: input.guildId,
        nitradoConnId: input.nitradoConnId,
        userDiscordId: input.userDiscordId,
      },
      select: { id: true },
    });
    return existing?.id ?? null;
  });
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
  try {
    const result = await client.$transaction((tx) => bookLedgerEntryInTx(tx, input));
    return { booked: true, entryId: result.entryId };
  } catch (e) {
    if (isUniqueViolation(e)) return { booked: false }; // bereits gebucht -> idempotent
    if (e instanceof EconomyLedgerRangeError) {
      // The cumulative range fence runs before the unique insert so automatic
      // callers can catch a range error without leaving a ledger row behind.
      // A retry of an already committed public idempotency key must nevertheless
      // retain the historic `{ booked:false }` contract even if the account has
      // since reached the BIGINT boundary.
      try {
        if (await existingLedgerEntryId(client, input)) return { booked: false };
      } catch {
        // Preserve the original range error if the recovery lookup itself fails.
      }
    }
    throw e;
  }
}
