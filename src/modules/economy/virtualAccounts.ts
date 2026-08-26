import { randomUUID } from 'node:crypto';
import prisma from '../../database/prisma';
import type { GuildId, NitradoConnId, UserDiscordId } from '../../types/scope';
import { assertEconomyScopeReady } from './scopeMigration';

export type VirtualAccountKind = 'CUSTOM' | 'LOTTERY_POT' | 'MARKET_VENDOR';
export type VirtualAccountStatus = 'ACTIVE' | 'EXPIRED' | 'ARCHIVED';
export type EconomyPocket = 'WALLET' | 'BANK';

export interface VirtualAccountRow {
  id: string;
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  kind: VirtualAccountKind;
  name: string;
  nameKey: string;
  balance: bigint;
  status: VirtualAccountStatus;
  acceptUserTransfers: boolean;
  expiresAt: Date | null;
  archivedAt: Date | null;
  archivedByDiscordId: string | null;
  createdByDiscordId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface VirtualAccountEntryRow {
  id: string;
  idempotencyKey: string;
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
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

interface DbVirtualAccountRow {
  id: string;
  guildId: string;
  nitradoConnId: string;
  kind: VirtualAccountKind;
  name: string;
  nameKey: string;
  balance: bigint;
  status: VirtualAccountStatus;
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

export interface VirtualAccountRawDb {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

const VIRTUAL_ACCOUNT_NAME_MAX = 80;
const IDEMPOTENCY_KEY_MAX = 80;
const REASON_MAX = 180;

function db(): VirtualAccountRawDb {
  return prisma as unknown as VirtualAccountRawDb;
}

function toVirtualAccount(row: DbVirtualAccountRow): VirtualAccountRow {
  return {
    ...row,
    guildId: row.guildId as GuildId,
    nitradoConnId: row.nitradoConnId as NitradoConnId,
  };
}

function toVirtualEntry(row: DbVirtualEntryRow): VirtualAccountEntryRow {
  return {
    ...row,
    guildId: row.guildId as GuildId,
    nitradoConnId: row.nitradoConnId as NitradoConnId,
  };
}

interface ReplayExpectation {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  virtualAccountId: string;
  delta: bigint;
  entryType: string;
  sourcePocket: EconomyPocket | null;
  actorDiscordId: string | null;
  userDiscordId: string | null;
  reason: string | null;
  sourceRef: string | null;
}

async function assertReplayMatches(
  raw: VirtualAccountRawDb,
  idempotencyKey: string,
  expected: ReplayExpectation,
): Promise<void> {
  const rows = await raw.$queryRawUnsafe<DbVirtualEntryRow[]>(
    'SELECT "id", "idempotencyKey", "guildId", "nitradoConnId", "virtualAccountId", "delta", "entryType", "sourcePocket", "actorDiscordId", "userDiscordId", "reason", "sourceRef", "createdAt" FROM "EconomyVirtualAccountEntry" WHERE "idempotencyKey"=$1 LIMIT 1',
    idempotencyKey,
  );
  const entry = rows[0];
  const matches = !!entry
    && entry.guildId === String(expected.guildId)
    && entry.nitradoConnId === String(expected.nitradoConnId)
    && entry.virtualAccountId === expected.virtualAccountId
    && entry.delta === expected.delta
    && entry.entryType === expected.entryType
    && entry.sourcePocket === expected.sourcePocket
    && entry.actorDiscordId === expected.actorDiscordId
    && entry.userDiscordId === expected.userDiscordId
    && entry.reason === expected.reason
    && entry.sourceRef === expected.sourceRef;
  if (!matches) throw new Error('Idempotency-Key wurde mit anderen Buchungsdaten wiederverwendet.');
}

export function normalizeVirtualAccountName(input: string): { name: string; nameKey: string } {
  const normalized = input.normalize('NFKC');
  if (/[\r\n\t\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`Kontoname muss 1..${VIRTUAL_ACCOUNT_NAME_MAX} druckbare Zeichen enthalten.`);
  }
  const name = normalized.trim().replace(/\s+/g, ' ');
  if (name.length < 1 || name.length > VIRTUAL_ACCOUNT_NAME_MAX) {
    throw new Error(`Kontoname muss 1..${VIRTUAL_ACCOUNT_NAME_MAX} druckbare Zeichen enthalten.`);
  }
  return { name, nameKey: name.toLowerCase() };
}

function normalizeReason(input: string | undefined, fallback: string): string {
  const reason = (input ?? fallback).normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (reason.length < 1) return fallback;
  return reason.slice(0, REASON_MAX);
}

function assertOperationKey(key: string): void {
  if (!key || key.length > IDEMPOTENCY_KEY_MAX || /[\r\n\t\u0000-\u001f\u007f]/.test(key)) {
    throw new Error('Idempotency-Key ungueltig.');
  }
}

function scopedOperationKey(guildId: GuildId, nitradoConnId: NitradoConnId, key: string): string {
  assertOperationKey(key);
  return `virtual:${guildId}:${nitradoConnId}:${key}`;
}

async function expireDueVirtualAccounts(
  raw: VirtualAccountRawDb,
  guildId: GuildId,
  nitradoConnId: NitradoConnId,
): Promise<void> {
  await raw.$executeRawUnsafe(
    'UPDATE "EconomyVirtualAccount" SET "status"=\'EXPIRED\'::"EconomyVirtualAccountStatus", "updatedAt"=CURRENT_TIMESTAMP WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "status"=\'ACTIVE\'::"EconomyVirtualAccountStatus" AND "expiresAt" IS NOT NULL AND "expiresAt"<=CURRENT_TIMESTAMP',
    String(guildId), String(nitradoConnId),
  );
}

async function findVirtualAccountById(
  raw: VirtualAccountRawDb,
  guildId: GuildId,
  nitradoConnId: NitradoConnId,
  accountId: string,
  lock = false,
): Promise<DbVirtualAccountRow | null> {
  const rows = await raw.$queryRawUnsafe<DbVirtualAccountRow[]>(
    'SELECT "id", "guildId", "nitradoConnId", "kind"::text AS kind, "name", "nameKey", "balance", "status"::text AS status, "acceptUserTransfers", "expiresAt", "archivedAt", "archivedByDiscordId", "createdByDiscordId", "createdAt", "updatedAt" FROM "EconomyVirtualAccount" WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 LIMIT 1' + (lock ? ' FOR UPDATE' : ''),
    accountId, String(guildId), String(nitradoConnId),
  );
  return rows[0] ?? null;
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

async function writeUserAudit(
  raw: VirtualAccountRawDb,
  args: {
    idempotencyKey: string;
    guildId: GuildId;
    nitradoConnId: NitradoConnId;
    userDiscordId: UserDiscordId;
    walletDelta: bigint;
    bankDelta: bigint;
    reason: string;
    actorDiscordId: string | null;
    sourceRef: string;
  },
): Promise<void> {
  const txType = args.walletDelta !== 0n ? 'PAY' : 'TRANSFER';
  const delta = args.walletDelta + args.bankDelta;
  await raw.$executeRawUnsafe(
    'INSERT INTO "EconomyTransaction" ("id", "guildId", "nitradoConnId", "userDiscordId", "delta", "type", "reason", "actorDiscordId", "counterpartDiscordId", "createdAt") VALUES ($1,$2,$3,$4,$5,$6::"EconomyTxType",$7,$8,NULL,CURRENT_TIMESTAMP)',
    randomUUID(), String(args.guildId), String(args.nitradoConnId), String(args.userDiscordId),
    delta, txType, args.reason, args.actorDiscordId,
  );
  const ledgerChanged = await raw.$executeRawUnsafe(
    'INSERT INTO "EconomyLedgerEntry" ("id", "idempotencyKey", "guildId", "nitradoConnId", "userDiscordId", "walletDelta", "bankDelta", "type", "reason", "buckets", "sourceRef", "createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8::"EconomyTxType",$9,0,$10,CURRENT_TIMESTAMP) ON CONFLICT ("idempotencyKey") DO NOTHING',
    randomUUID(), `${args.idempotencyKey}:user`, String(args.guildId), String(args.nitradoConnId), String(args.userDiscordId),
    args.walletDelta, args.bankDelta, txType, args.reason, args.sourceRef,
  );
  if (ledgerChanged !== 1) throw new Error('User-Ledger-Idempotenzkonflikt.');
}

export async function listVirtualAccounts(
  guildId: GuildId,
  nitradoConnId: NitradoConnId,
  includeArchived = false,
): Promise<VirtualAccountRow[]> {
  await assertEconomyScopeReady(guildId, nitradoConnId);
  const raw = db();
  await expireDueVirtualAccounts(raw, guildId, nitradoConnId);
  const rows = await raw.$queryRawUnsafe<DbVirtualAccountRow[]>(
    'SELECT "id", "guildId", "nitradoConnId", "kind"::text AS kind, "name", "nameKey", "balance", "status"::text AS status, "acceptUserTransfers", "expiresAt", "archivedAt", "archivedByDiscordId", "createdByDiscordId", "createdAt", "updatedAt" FROM "EconomyVirtualAccount" WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND ($3::boolean OR "status"<>\'ARCHIVED\'::"EconomyVirtualAccountStatus") ORDER BY CASE "status" WHEN \'ACTIVE\' THEN 0 WHEN \'EXPIRED\' THEN 1 ELSE 2 END, LOWER("name"), "createdAt"',
    String(guildId), String(nitradoConnId), includeArchived,
  );
  return rows.map(toVirtualAccount);
}

export async function getVirtualAccountByName(
  guildId: GuildId,
  nitradoConnId: NitradoConnId,
  rawName: string,
): Promise<VirtualAccountRow | null> {
  await assertEconomyScopeReady(guildId, nitradoConnId);
  const { nameKey } = normalizeVirtualAccountName(rawName);
  const raw = db();
  await expireDueVirtualAccounts(raw, guildId, nitradoConnId);
  const rows = await raw.$queryRawUnsafe<DbVirtualAccountRow[]>(
    'SELECT "id", "guildId", "nitradoConnId", "kind"::text AS kind, "name", "nameKey", "balance", "status"::text AS status, "acceptUserTransfers", "expiresAt", "archivedAt", "archivedByDiscordId", "createdByDiscordId", "createdAt", "updatedAt" FROM "EconomyVirtualAccount" WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "nameKey"=$3 LIMIT 1',
    String(guildId), String(nitradoConnId), nameKey,
  );
  return rows[0] ? toVirtualAccount(rows[0]) : null;
}

export async function getVirtualAccountById(
  guildId: GuildId,
  nitradoConnId: NitradoConnId,
  accountId: string,
): Promise<VirtualAccountRow | null> {
  await assertEconomyScopeReady(guildId, nitradoConnId);
  const raw = db();
  await expireDueVirtualAccounts(raw, guildId, nitradoConnId);
  const row = await findVirtualAccountById(raw, guildId, nitradoConnId, accountId);
  return row ? toVirtualAccount(row) : null;
}

export async function createVirtualAccount(args: {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  name: string;
  kind?: VirtualAccountKind;
  expiresAt?: Date | null;
  acceptUserTransfers?: boolean;
  createdByDiscordId: UserDiscordId;
}): Promise<VirtualAccountRow> {
  const { name, nameKey } = normalizeVirtualAccountName(args.name);
  const kind = args.kind ?? 'CUSTOM';
  if (!(['CUSTOM', 'LOTTERY_POT', 'MARKET_VENDOR'] as const).includes(kind)) throw new Error('Kontotyp ungueltig.');
  if (args.expiresAt && args.expiresAt.getTime() <= Date.now()) throw new Error('Ablaufzeit muss in der Zukunft liegen.');
  await assertEconomyScopeReady(args.guildId, args.nitradoConnId);
  try {
    const rows = await db().$queryRawUnsafe<DbVirtualAccountRow[]>(
      'INSERT INTO "EconomyVirtualAccount" ("id", "guildId", "nitradoConnId", "kind", "name", "nameKey", "balance", "status", "acceptUserTransfers", "expiresAt", "archivedAt", "archivedByDiscordId", "createdByDiscordId", "createdAt", "updatedAt") VALUES ($1,$2,$3,$4::"EconomyVirtualAccountKind",$5,$6,0,\'ACTIVE\'::"EconomyVirtualAccountStatus",$7,$8,NULL,NULL,$9,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) RETURNING "id", "guildId", "nitradoConnId", "kind"::text AS kind, "name", "nameKey", "balance", "status"::text AS status, "acceptUserTransfers", "expiresAt", "archivedAt", "archivedByDiscordId", "createdByDiscordId", "createdAt", "updatedAt"',
      randomUUID(), String(args.guildId), String(args.nitradoConnId), kind, name, nameKey,
      args.acceptUserTransfers ?? true, args.expiresAt ?? null, String(args.createdByDiscordId),
    );
    if (!rows[0]) throw new Error('Virtuelles Konto konnte nicht erstellt werden.');
    return toVirtualAccount(rows[0]);
  } catch (error) {
    const candidate = typeof error === 'object' && error !== null
      ? error as { code?: string; meta?: { code?: string } }
      : {};
    if (candidate.code === '23505' || candidate.code === 'P2002' || candidate.meta?.code === '23505') {
      throw new Error('Ein virtuelles Konto mit diesem Namen existiert bereits auf diesem Gameserver.');
    }
    throw error;
  }
}

export async function archiveVirtualAccount(args: {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  accountId: string;
  actorDiscordId: UserDiscordId;
}): Promise<VirtualAccountRow> {
  await assertEconomyScopeReady(args.guildId, args.nitradoConnId);
  return prisma.$transaction(async tx => {
    const raw = tx as unknown as VirtualAccountRawDb;
    await expireDueVirtualAccounts(raw, args.guildId, args.nitradoConnId);
    const current = await findVirtualAccountById(raw, args.guildId, args.nitradoConnId, args.accountId, true);
    if (!current) throw new Error('Virtuelles Konto nicht gefunden.');
    if (current.status === 'ARCHIVED') return toVirtualAccount(current);

    const financeRows = await raw.$queryRawUnsafe<Array<{ bankBalance: bigint }>>(
      'SELECT "bankBalance" FROM "EconomyVirtualAccountFinance" WHERE "accountId"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 LIMIT 1 FOR UPDATE',
      args.accountId,
      String(args.guildId),
      String(args.nitradoConnId),
    );
    const finance = financeRows[0];
    if (!finance) throw new Error('Konto-Finanzprofil fehlt; Archivierung wird sicherheitshalber abgebrochen.');
    if (current.balance !== 0n || finance.bankBalance !== 0n) {
      throw new Error('Konto besitzt noch Guthaben und kann nicht archiviert werden. Wallet und Bank muessen 0 sein.');
    }

    const rows = await raw.$queryRawUnsafe<DbVirtualAccountRow[]>(
      'UPDATE "EconomyVirtualAccount" SET "status"=\'ARCHIVED\'::"EconomyVirtualAccountStatus", "archivedAt"=CURRENT_TIMESTAMP, "archivedByDiscordId"=$4, "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 AND "status"<>\'ARCHIVED\'::"EconomyVirtualAccountStatus" AND "balance"=0 RETURNING "id", "guildId", "nitradoConnId", "kind"::text AS kind, "name", "nameKey", "balance", "status"::text AS status, "acceptUserTransfers", "expiresAt", "archivedAt", "archivedByDiscordId", "createdByDiscordId", "createdAt", "updatedAt"',
      args.accountId, String(args.guildId), String(args.nitradoConnId), String(args.actorDiscordId),
    );
    if (!rows[0]) throw new Error('Virtuelles Konto konnte nicht archiviert werden.');
    return toVirtualAccount(rows[0]);
  });
}

export async function listVirtualAccountEntries(
  guildId: GuildId,
  nitradoConnId: NitradoConnId,
  accountId: string,
  limit = 50,
): Promise<VirtualAccountEntryRow[]> {
  await assertEconomyScopeReady(guildId, nitradoConnId);
  const raw = db();
  const account = await findVirtualAccountById(raw, guildId, nitradoConnId, accountId);
  if (!account) throw new Error('Virtuelles Konto nicht gefunden.');
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  const rows = await raw.$queryRawUnsafe<DbVirtualEntryRow[]>(
    'SELECT "id", "idempotencyKey", "guildId", "nitradoConnId", "virtualAccountId", "delta", "entryType", "sourcePocket", "actorDiscordId", "userDiscordId", "reason", "sourceRef", "createdAt" FROM "EconomyVirtualAccountEntry" WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "virtualAccountId"=$3 ORDER BY "createdAt" DESC LIMIT $4',
    String(guildId), String(nitradoConnId), accountId, safeLimit,
  );
  return rows.map(toVirtualEntry);
}

export async function transferUserToVirtualAccount(args: {
  idempotencyKey: string;
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  fromUserId: UserDiscordId;
  virtualAccountId: string;
  amount: bigint;
  sourcePocket: EconomyPocket;
  reason?: string;
}): Promise<{ booked: boolean; account: VirtualAccountRow }> {
  if (args.amount <= 0n) throw new Error('Betrag muss > 0 sein.');
  if (args.sourcePocket !== 'WALLET' && args.sourcePocket !== 'BANK') throw new Error('Quellkonto ungueltig.');
  const operationKey = scopedOperationKey(args.guildId, args.nitradoConnId, args.idempotencyKey);
  await assertEconomyScopeReady(args.guildId, args.nitradoConnId);
  const reason = normalizeReason(args.reason, 'Ueberweisung auf virtuelles Konto');

  return prisma.$transaction(async tx => {
    const raw = tx as unknown as VirtualAccountRawDb;
    await expireDueVirtualAccounts(raw, args.guildId, args.nitradoConnId);
    const account = await findVirtualAccountById(raw, args.guildId, args.nitradoConnId, args.virtualAccountId, true);
    if (!account) throw new Error('Virtuelles Konto nicht gefunden.');
    if (account.status !== 'ACTIVE') throw new Error('Virtuelles Konto ist nicht aktiv.');
    if (!account.acceptUserTransfers) throw new Error('Dieses Konto nimmt keine direkten User-Ueberweisungen an.');

    const claimed = await raw.$executeRawUnsafe(
      'INSERT INTO "EconomyVirtualAccountEntry" ("id", "idempotencyKey", "guildId", "nitradoConnId", "virtualAccountId", "delta", "entryType", "sourcePocket", "actorDiscordId", "userDiscordId", "reason", "sourceRef", "createdAt") VALUES ($1,$2,$3,$4,$5,$6,\'USER_DEPOSIT\',$7,$8,$9,$10,$11,CURRENT_TIMESTAMP) ON CONFLICT ("idempotencyKey") DO NOTHING',
      randomUUID(), operationKey, String(args.guildId), String(args.nitradoConnId), args.virtualAccountId,
      args.amount, args.sourcePocket, String(args.fromUserId), String(args.fromUserId), reason, `virtual-account:${args.virtualAccountId}`,
    );
    if (claimed !== 1) {
      await assertReplayMatches(raw, operationKey, {
        guildId: args.guildId, nitradoConnId: args.nitradoConnId, virtualAccountId: args.virtualAccountId,
        delta: args.amount, entryType: 'USER_DEPOSIT', sourcePocket: args.sourcePocket,
        actorDiscordId: String(args.fromUserId), userDiscordId: String(args.fromUserId), reason,
        sourceRef: `virtual-account:${args.virtualAccountId}`,
      });
      return { booked: false, account: toVirtualAccount(account) };
    }

    const column = args.sourcePocket === 'WALLET' ? 'walletBalance' : 'bankBalance';
    const sourceChanged = await raw.$executeRawUnsafe(
      `UPDATE "EconomyAccount" SET "${column}"="${column}"-$4, "updatedAt"=CURRENT_TIMESTAMP WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "userDiscordId"=$3 AND "${column}">=$4`,
      String(args.guildId), String(args.nitradoConnId), String(args.fromUserId), args.amount,
    );
    if (sourceChanged !== 1) throw new Error(args.sourcePocket === 'WALLET' ? 'Wallet zu klein.' : 'Bankguthaben zu klein.');

    const targetRows = await raw.$queryRawUnsafe<DbVirtualAccountRow[]>(
      'UPDATE "EconomyVirtualAccount" SET "balance"="balance"+$4, "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 RETURNING "id", "guildId", "nitradoConnId", "kind"::text AS kind, "name", "nameKey", "balance", "status"::text AS status, "acceptUserTransfers", "expiresAt", "archivedAt", "archivedByDiscordId", "createdByDiscordId", "createdAt", "updatedAt"',
      args.virtualAccountId, String(args.guildId), String(args.nitradoConnId), args.amount,
    );
    if (!targetRows[0]) throw new Error('Virtuelles Konto konnte nicht aktualisiert werden.');

    await writeUserAudit(raw, {
      idempotencyKey: operationKey,
      guildId: args.guildId,
      nitradoConnId: args.nitradoConnId,
      userDiscordId: args.fromUserId,
      walletDelta: args.sourcePocket === 'WALLET' ? -args.amount : 0n,
      bankDelta: args.sourcePocket === 'BANK' ? -args.amount : 0n,
      reason: `${reason} -> ${account.name}`.slice(0, 180),
      actorDiscordId: String(args.fromUserId),
      sourceRef: `virtual-account:${args.virtualAccountId}`,
    });
    return { booked: true, account: toVirtualAccount(targetRows[0]) };
  });
}

export async function transferVirtualAccountToUser(args: {
  idempotencyKey: string;
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  virtualAccountId: string;
  toUserId: UserDiscordId;
  amount: bigint;
  targetPocket: EconomyPocket;
  actorDiscordId: UserDiscordId | null;
  reason?: string;
  entryType?: 'PAYOUT' | 'REFUND' | 'ADMIN_WITHDRAW';
}): Promise<{ booked: boolean; account: VirtualAccountRow }> {
  if (args.amount <= 0n) throw new Error('Betrag muss > 0 sein.');
  if (args.targetPocket !== 'WALLET' && args.targetPocket !== 'BANK') throw new Error('Zielkonto ungueltig.');
  const operationKey = scopedOperationKey(args.guildId, args.nitradoConnId, args.idempotencyKey);
  await assertEconomyScopeReady(args.guildId, args.nitradoConnId);
  const reason = normalizeReason(args.reason, 'Auszahlung aus virtuellem Konto');

  return prisma.$transaction(async tx => {
    const raw = tx as unknown as VirtualAccountRawDb;
    await expireDueVirtualAccounts(raw, args.guildId, args.nitradoConnId);
    const account = await findVirtualAccountById(raw, args.guildId, args.nitradoConnId, args.virtualAccountId, true);
    if (!account) throw new Error('Virtuelles Konto nicht gefunden.');
    if (account.status === 'ARCHIVED') throw new Error('Archiviertes Konto kann nicht mehr buchen.');

    const claimed = await raw.$executeRawUnsafe(
      'INSERT INTO "EconomyVirtualAccountEntry" ("id", "idempotencyKey", "guildId", "nitradoConnId", "virtualAccountId", "delta", "entryType", "sourcePocket", "actorDiscordId", "userDiscordId", "reason", "sourceRef", "createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,CURRENT_TIMESTAMP) ON CONFLICT ("idempotencyKey") DO NOTHING',
      randomUUID(), operationKey, String(args.guildId), String(args.nitradoConnId), args.virtualAccountId,
      -args.amount, args.entryType ?? 'PAYOUT', args.targetPocket, args.actorDiscordId ? String(args.actorDiscordId) : null,
      String(args.toUserId), reason, `virtual-account:${args.virtualAccountId}`,
    );
    if (claimed !== 1) {
      await assertReplayMatches(raw, operationKey, {
        guildId: args.guildId, nitradoConnId: args.nitradoConnId, virtualAccountId: args.virtualAccountId,
        delta: -args.amount, entryType: args.entryType ?? 'PAYOUT', sourcePocket: args.targetPocket,
        actorDiscordId: args.actorDiscordId ? String(args.actorDiscordId) : null, userDiscordId: String(args.toUserId), reason,
        sourceRef: `virtual-account:${args.virtualAccountId}`,
      });
      return { booked: false, account: toVirtualAccount(account) };
    }

    const sourceRows = await raw.$queryRawUnsafe<DbVirtualAccountRow[]>(
      'UPDATE "EconomyVirtualAccount" SET "balance"="balance"-$4, "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 AND "balance">=$4 RETURNING "id", "guildId", "nitradoConnId", "kind"::text AS kind, "name", "nameKey", "balance", "status"::text AS status, "acceptUserTransfers", "expiresAt", "archivedAt", "archivedByDiscordId", "createdByDiscordId", "createdAt", "updatedAt"',
      args.virtualAccountId, String(args.guildId), String(args.nitradoConnId), args.amount,
    );
    if (!sourceRows[0]) throw new Error('Virtuelles Konto hat zu wenig Guthaben.');

    await ensureUserAccount(raw, args.guildId, args.nitradoConnId, args.toUserId);
    const column = args.targetPocket === 'WALLET' ? 'walletBalance' : 'bankBalance';
    const userChanged = await raw.$executeRawUnsafe(
      `UPDATE "EconomyAccount" SET "${column}"="${column}"+$4, "updatedAt"=CURRENT_TIMESTAMP WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "userDiscordId"=$3`,
      String(args.guildId), String(args.nitradoConnId), String(args.toUserId), args.amount,
    );
    if (userChanged !== 1) throw new Error('Zielkonto konnte nicht aktualisiert werden.');

    await writeUserAudit(raw, {
      idempotencyKey: operationKey,
      guildId: args.guildId,
      nitradoConnId: args.nitradoConnId,
      userDiscordId: args.toUserId,
      walletDelta: args.targetPocket === 'WALLET' ? args.amount : 0n,
      bankDelta: args.targetPocket === 'BANK' ? args.amount : 0n,
      reason: `${reason} <- ${account.name}`.slice(0, 180),
      actorDiscordId: args.actorDiscordId ? String(args.actorDiscordId) : null,
      sourceRef: `virtual-account:${args.virtualAccountId}`,
    });
    return { booked: true, account: toVirtualAccount(sourceRows[0]) };
  });
}
