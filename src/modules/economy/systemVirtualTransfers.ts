import { randomUUID } from 'node:crypto';
import type { EconomyTxType } from '@prisma/client';
import prisma from '../../database/prisma';
import type { GuildId, NitradoConnId, UserDiscordId } from '../../types/scope';
import { assertEconomyScopeReady } from './scopeMigration';
import type { EconomyPocket, VirtualAccountKind, VirtualAccountRawDb, VirtualAccountRow } from './virtualAccounts';

interface DbVirtualAccountRow {
  id: string;
  guildId: string;
  nitradoConnId: string;
  kind: VirtualAccountKind;
  name: string;
  nameKey: string;
  balance: bigint;
  status: 'ACTIVE' | 'EXPIRED' | 'ARCHIVED';
  acceptUserTransfers: boolean;
  expiresAt: Date | null;
  archivedAt: Date | null;
  archivedByDiscordId: string | null;
  createdByDiscordId: string;
  createdAt: Date;
  updatedAt: Date;
}

interface DbVirtualEntryRow {
  id: string;
  idempotencyKey: string;
  guildId: string;
  nitradoConnId: string;
  virtualAccountId: string;
  delta: bigint;
  entryType: string;
  sourcePocket: EconomyPocket | null;
  actorDiscordId: string | null;
  userDiscordId: string | null;
  reason: string | null;
  sourceRef: string | null;
  createdAt: Date;
}

export interface SystemTransferContext<T> {
  raw: VirtualAccountRawDb;
  preflight: T;
  account: VirtualAccountRow;
}

interface CommonSystemTransferArgs {
  idempotencyKey: string;
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  virtualAccountId: string;
  amount: bigint;
  expectedKind: VirtualAccountKind;
  economyTxType: EconomyTxType;
  entryType: string;
  reason: string;
  sourceRef: string;
  actorDiscordId: UserDiscordId | null;
}

export interface SystemUserToVirtualArgs extends CommonSystemTransferArgs {
  fromUserId: UserDiscordId;
  sourcePocket?: EconomyPocket;
}

export interface SystemVirtualToUserArgs extends CommonSystemTransferArgs {
  toUserId: UserDiscordId;
  targetPocket?: EconomyPocket;
  countAsEarned?: boolean;
}

const MAX_OPERATION_KEY_LENGTH = 96;
const MAX_REASON_LENGTH = 180;
const MAX_ENTRY_TYPE_LENGTH = 40;
const MAX_SOURCE_REF_LENGTH = 180;

function cleanText(value: string, max: number, label: string): string {
  const normalized = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (!normalized || normalized.length > max || /[\r\n\t\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} ist ungueltig.`);
  }
  return normalized;
}

function operationKey(args: CommonSystemTransferArgs): string {
  const external = cleanText(args.idempotencyKey, MAX_OPERATION_KEY_LENGTH, 'Idempotency-Key');
  return `virtual-system:${args.guildId}:${args.nitradoConnId}:${external}`;
}

function toVirtualAccount(row: DbVirtualAccountRow): VirtualAccountRow {
  return {
    ...row,
    guildId: row.guildId as GuildId,
    nitradoConnId: row.nitradoConnId as NitradoConnId,
  };
}

async function findLockedAccount(
  raw: VirtualAccountRawDb,
  args: CommonSystemTransferArgs,
): Promise<DbVirtualAccountRow> {
  const rows = await raw.$queryRawUnsafe<DbVirtualAccountRow[]>(
    'SELECT "id", "guildId", "nitradoConnId", "kind"::text AS kind, "name", "nameKey", "balance", "status"::text AS status, "acceptUserTransfers", "expiresAt", "archivedAt", "archivedByDiscordId", "createdByDiscordId", "createdAt", "updatedAt" FROM "EconomyVirtualAccount" WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 LIMIT 1 FOR UPDATE',
    args.virtualAccountId, String(args.guildId), String(args.nitradoConnId),
  );
  const account = rows[0];
  if (!account) throw new Error('Systemkonto nicht gefunden.');
  if (account.kind !== args.expectedKind) throw new Error('Systemkonto hat den falschen Kontotyp.');
  if (account.status === 'ARCHIVED') throw new Error('Archiviertes Systemkonto kann nicht mehr buchen.');
  return account;
}

function expectedEntry(args: CommonSystemTransferArgs, delta: bigint, pocket: EconomyPocket, userId: UserDiscordId) {
  return {
    guildId: String(args.guildId),
    nitradoConnId: String(args.nitradoConnId),
    virtualAccountId: args.virtualAccountId,
    delta,
    entryType: cleanText(args.entryType, MAX_ENTRY_TYPE_LENGTH, 'Entry-Typ'),
    sourcePocket: pocket,
    actorDiscordId: args.actorDiscordId ? String(args.actorDiscordId) : null,
    userDiscordId: String(userId),
    reason: cleanText(args.reason, MAX_REASON_LENGTH, 'Grund'),
    sourceRef: cleanText(args.sourceRef, MAX_SOURCE_REF_LENGTH, 'Source-Ref'),
  };
}

async function assertReplayMatches(
  raw: VirtualAccountRawDb,
  key: string,
  expected: ReturnType<typeof expectedEntry>,
): Promise<void> {
  const rows = await raw.$queryRawUnsafe<DbVirtualEntryRow[]>(
    'SELECT "id", "idempotencyKey", "guildId", "nitradoConnId", "virtualAccountId", "delta", "entryType", "sourcePocket", "actorDiscordId", "userDiscordId", "reason", "sourceRef", "createdAt" FROM "EconomyVirtualAccountEntry" WHERE "idempotencyKey"=$1 LIMIT 1',
    key,
  );
  const entry = rows[0];
  const same = !!entry
    && entry.guildId === expected.guildId
    && entry.nitradoConnId === expected.nitradoConnId
    && entry.virtualAccountId === expected.virtualAccountId
    && entry.delta === expected.delta
    && entry.entryType === expected.entryType
    && entry.sourcePocket === expected.sourcePocket
    && entry.actorDiscordId === expected.actorDiscordId
    && entry.userDiscordId === expected.userDiscordId
    && entry.reason === expected.reason
    && entry.sourceRef === expected.sourceRef;
  if (!same) throw new Error('System-Idempotency-Key wurde mit anderen Buchungsdaten wiederverwendet.');
}

async function ensureUserAccount(
  raw: VirtualAccountRawDb,
  guildId: GuildId,
  nitradoConnId: NitradoConnId,
  userDiscordId: UserDiscordId,
): Promise<void> {
  await raw.$executeRawUnsafe(
    'INSERT INTO "EconomyAccount" ("id", "guildId", "nitradoConnId", "userDiscordId", "walletBalance", "bankBalance", "lifetimeEarned", "lifetimeSpent", "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,0,0,0,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT ("guildId", "nitradoConnId", "userDiscordId") DO NOTHING',
    randomUUID(), String(guildId), String(nitradoConnId), String(userDiscordId),
  );
}

async function insertUserAudit(raw: VirtualAccountRawDb, args: {
  key: string;
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  userDiscordId: UserDiscordId;
  walletDelta: bigint;
  bankDelta: bigint;
  type: EconomyTxType;
  reason: string;
  actorDiscordId: UserDiscordId | null;
  sourceRef: string;
}): Promise<void> {
  const delta = args.walletDelta + args.bankDelta;
  await raw.$executeRawUnsafe(
    'INSERT INTO "EconomyTransaction" ("id", "guildId", "nitradoConnId", "userDiscordId", "delta", "type", "reason", "actorDiscordId", "counterpartDiscordId", "createdAt") VALUES ($1,$2,$3,$4,$5,$6::"EconomyTxType",$7,$8,NULL,CURRENT_TIMESTAMP)',
    randomUUID(), String(args.guildId), String(args.nitradoConnId), String(args.userDiscordId), delta,
    args.type, args.reason, args.actorDiscordId ? String(args.actorDiscordId) : null,
  );
  const ledger = await raw.$executeRawUnsafe(
    'INSERT INTO "EconomyLedgerEntry" ("id", "idempotencyKey", "guildId", "nitradoConnId", "userDiscordId", "walletDelta", "bankDelta", "type", "reason", "buckets", "sourceRef", "createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8::"EconomyTxType",$9,0,$10,CURRENT_TIMESTAMP) ON CONFLICT ("idempotencyKey") DO NOTHING',
    randomUUID(), `${args.key}:user`, String(args.guildId), String(args.nitradoConnId), String(args.userDiscordId),
    args.walletDelta, args.bankDelta, args.type, args.reason, args.sourceRef,
  );
  if (ledger !== 1) throw new Error('System-User-Ledger-Idempotenzkonflikt.');
}

/**
 * Atomare User -> Systemkonto-Buchung. `beforeClaim` laeuft innerhalb derselben
 * DB-Transaktion VOR der Geldmutation (z.B. LotteryRound FOR UPDATE). `mutate`
 * commitet fachliche Begleitdaten (Tickets/Bestellung) zusammen mit dem Geld.
 */
export async function systemUserToVirtualAccount<TPreflight, TMutation>(args: SystemUserToVirtualArgs, hooks: {
  beforeClaim: (raw: VirtualAccountRawDb) => Promise<TPreflight>;
  mutate: (ctx: SystemTransferContext<TPreflight>) => Promise<TMutation>;
}): Promise<{ booked: boolean; account: VirtualAccountRow; mutation?: TMutation }> {
  if (args.amount <= 0n) throw new Error('Betrag muss > 0 sein.');
  const pocket = args.sourcePocket ?? 'WALLET';
  if (pocket !== 'WALLET' && pocket !== 'BANK') throw new Error('Quellkonto ungueltig.');
  await assertEconomyScopeReady(args.guildId, args.nitradoConnId);
  const key = operationKey(args);
  const expected = expectedEntry(args, args.amount, pocket, args.fromUserId);

  return prisma.$transaction(async tx => {
    const raw = tx as unknown as VirtualAccountRawDb;

    const replay = await raw.$queryRawUnsafe<DbVirtualEntryRow[]>(
      'SELECT "id", "idempotencyKey", "guildId", "nitradoConnId", "virtualAccountId", "delta", "entryType", "sourcePocket", "actorDiscordId", "userDiscordId", "reason", "sourceRef", "createdAt" FROM "EconomyVirtualAccountEntry" WHERE "idempotencyKey"=$1 LIMIT 1',
      key,
    );
    if (replay[0]) {
      await assertReplayMatches(raw, key, expected);
      const account = await findLockedAccount(raw, args);
      return { booked: false, account: toVirtualAccount(account) };
    }

    const preflight = await hooks.beforeClaim(raw);
    const account = await findLockedAccount(raw, args);
    if (account.status !== 'ACTIVE') throw new Error('Systemkonto ist nicht aktiv.');

    const claimed = await raw.$executeRawUnsafe(
      'INSERT INTO "EconomyVirtualAccountEntry" ("id", "idempotencyKey", "guildId", "nitradoConnId", "virtualAccountId", "delta", "entryType", "sourcePocket", "actorDiscordId", "userDiscordId", "reason", "sourceRef", "createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,CURRENT_TIMESTAMP) ON CONFLICT ("idempotencyKey") DO NOTHING',
      randomUUID(), key, expected.guildId, expected.nitradoConnId, expected.virtualAccountId, expected.delta,
      expected.entryType, expected.sourcePocket, expected.actorDiscordId, expected.userDiscordId, expected.reason, expected.sourceRef,
    );
    if (claimed !== 1) {
      await assertReplayMatches(raw, key, expected);
      return { booked: false, account: toVirtualAccount(account) };
    }

    const column = pocket === 'WALLET' ? 'walletBalance' : 'bankBalance';
    const debit = await raw.$executeRawUnsafe(
      `UPDATE "EconomyAccount" SET "${column}"="${column}"-$4, "lifetimeSpent"="lifetimeSpent"+$4, "updatedAt"=CURRENT_TIMESTAMP WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "userDiscordId"=$3 AND "${column}">=$4`,
      String(args.guildId), String(args.nitradoConnId), String(args.fromUserId), args.amount,
    );
    if (debit !== 1) throw new Error(pocket === 'WALLET' ? 'Wallet zu klein.' : 'Bankguthaben zu klein.');

    const credited = await raw.$executeRawUnsafe(
      'UPDATE "EconomyVirtualAccount" SET "balance"="balance"+$4, "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3',
      args.virtualAccountId, String(args.guildId), String(args.nitradoConnId), args.amount,
    );
    if (credited !== 1) throw new Error('Systemkonto konnte nicht gutgeschrieben werden.');

    await insertUserAudit(raw, {
      key, guildId: args.guildId, nitradoConnId: args.nitradoConnId, userDiscordId: args.fromUserId,
      walletDelta: pocket === 'WALLET' ? -args.amount : 0n,
      bankDelta: pocket === 'BANK' ? -args.amount : 0n,
      type: args.economyTxType, reason: expected.reason,
      actorDiscordId: args.actorDiscordId, sourceRef: expected.sourceRef,
    });

    const mutation = await hooks.mutate({ raw, preflight, account: toVirtualAccount({ ...account, balance: account.balance + args.amount }) });
    return { booked: true, account: toVirtualAccount({ ...account, balance: account.balance + args.amount }), mutation };
  });
}

/** Atomare Systemkonto -> User-Buchung mit fachlicher Begleitmutation. */
export async function systemVirtualAccountToUser<TMutation>(args: SystemVirtualToUserArgs, hooks: {
  mutate: (ctx: SystemTransferContext<undefined>) => Promise<TMutation>;
}): Promise<{ booked: boolean; account: VirtualAccountRow; mutation?: TMutation }> {
  if (args.amount <= 0n) throw new Error('Betrag muss > 0 sein.');
  const pocket = args.targetPocket ?? 'WALLET';
  if (pocket !== 'WALLET' && pocket !== 'BANK') throw new Error('Zielkonto ungueltig.');
  await assertEconomyScopeReady(args.guildId, args.nitradoConnId);
  const key = operationKey(args);
  const expected = expectedEntry(args, -args.amount, pocket, args.toUserId);

  return prisma.$transaction(async tx => {
    const raw = tx as unknown as VirtualAccountRawDb;
    const replay = await raw.$queryRawUnsafe<DbVirtualEntryRow[]>(
      'SELECT "id", "idempotencyKey", "guildId", "nitradoConnId", "virtualAccountId", "delta", "entryType", "sourcePocket", "actorDiscordId", "userDiscordId", "reason", "sourceRef", "createdAt" FROM "EconomyVirtualAccountEntry" WHERE "idempotencyKey"=$1 LIMIT 1',
      key,
    );
    if (replay[0]) {
      await assertReplayMatches(raw, key, expected);
      const account = await findLockedAccount(raw, args);
      return { booked: false, account: toVirtualAccount(account) };
    }

    const account = await findLockedAccount(raw, args);
    const claimed = await raw.$executeRawUnsafe(
      'INSERT INTO "EconomyVirtualAccountEntry" ("id", "idempotencyKey", "guildId", "nitradoConnId", "virtualAccountId", "delta", "entryType", "sourcePocket", "actorDiscordId", "userDiscordId", "reason", "sourceRef", "createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,CURRENT_TIMESTAMP) ON CONFLICT ("idempotencyKey") DO NOTHING',
      randomUUID(), key, expected.guildId, expected.nitradoConnId, expected.virtualAccountId, expected.delta,
      expected.entryType, expected.sourcePocket, expected.actorDiscordId, expected.userDiscordId, expected.reason, expected.sourceRef,
    );
    if (claimed !== 1) {
      await assertReplayMatches(raw, key, expected);
      return { booked: false, account: toVirtualAccount(account) };
    }

    const debitRows = await raw.$queryRawUnsafe<DbVirtualAccountRow[]>(
      'UPDATE "EconomyVirtualAccount" SET "balance"="balance"-$4, "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 AND "balance">=$4 RETURNING "id", "guildId", "nitradoConnId", "kind"::text AS kind, "name", "nameKey", "balance", "status"::text AS status, "acceptUserTransfers", "expiresAt", "archivedAt", "archivedByDiscordId", "createdByDiscordId", "createdAt", "updatedAt"',
      args.virtualAccountId, String(args.guildId), String(args.nitradoConnId), args.amount,
    );
    if (!debitRows[0]) throw new Error('Systemkonto hat zu wenig Guthaben.');

    await ensureUserAccount(raw, args.guildId, args.nitradoConnId, args.toUserId);
    const column = pocket === 'WALLET' ? 'walletBalance' : 'bankBalance';
    const earnedSql = args.countAsEarned ? ', "lifetimeEarned"="lifetimeEarned"+$4' : '';
    const credit = await raw.$executeRawUnsafe(
      `UPDATE "EconomyAccount" SET "${column}"="${column}"+$4${earnedSql}, "updatedAt"=CURRENT_TIMESTAMP WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "userDiscordId"=$3`,
      String(args.guildId), String(args.nitradoConnId), String(args.toUserId), args.amount,
    );
    if (credit !== 1) throw new Error('User-Zielkonto konnte nicht gutgeschrieben werden.');

    await insertUserAudit(raw, {
      key, guildId: args.guildId, nitradoConnId: args.nitradoConnId, userDiscordId: args.toUserId,
      walletDelta: pocket === 'WALLET' ? args.amount : 0n,
      bankDelta: pocket === 'BANK' ? args.amount : 0n,
      type: args.economyTxType, reason: expected.reason,
      actorDiscordId: args.actorDiscordId, sourceRef: expected.sourceRef,
    });

    const mutation = await hooks.mutate({ raw, preflight: undefined, account: toVirtualAccount(debitRows[0]) });
    return { booked: true, account: toVirtualAccount(debitRows[0]), mutation };
  });
}
