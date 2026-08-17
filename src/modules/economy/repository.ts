/**
 * Economy-Repository — atomare, servergescopte Wallet/Bank-Operationen.
 *
 * Phase 4 / ECO-S01..S05:
 * - JEDE Datenoperation traegt guildId + nitradoConnId.
 * - Kein globales Wallet innerhalb einer Discord-Guild.
 * - Transfers koennen konstruktiv nur innerhalb desselben nitradoConnId laufen.
 * - Geld-Werte bleiben BigInt; niemals Number fuer Balances.
 *
 * Die Phase-4-Migration fuegt die Scope-Spalten/Composite-Indexes additiv ein.
 * Bis schema.prisma vollstaendig nachgezogen ist, werden die neuen Spalten hier
 * bewusst ueber parameterisierte Raw-SQL-Zugriffe adressiert. Alle SQL-Strings
 * sind statisch; Nutzerdaten werden ausschliesslich als Bind-Parameter uebergeben.
 */

import { randomUUID } from 'node:crypto';
import prisma from '../../database/prisma';
import { config } from '../../config';
import type { GuildId, NitradoConnId, UserDiscordId } from '../../types/scope';
import type { EconomyTxType, Prisma } from '@prisma/client';
import { hasCompletedLeaveCleanupReceipt } from '../moderation/leaveCleanupSaga';
import { assertEconomyScopeReady } from './scopeMigration';
import { economySubjectKey } from './subjectKey';

export interface EconomyConfigRow {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  enabled: boolean;
  currencyName: string;
  emoji: string;
  startBalance: number;
  playtimeRewardPercent: number;
  bankInterestPercent: number;
  bankChannelId: string | null;
}

export interface AccountRow {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  userDiscordId: UserDiscordId;
  walletBalance: bigint;
  bankBalance: bigint;
  lifetimeEarned: bigint;
  lifetimeSpent: bigint;
}

interface AccountDbRow {
  id: string;
  guildId: string;
  nitradoConnId: string;
  userDiscordId: string;
  walletBalance: bigint;
  bankBalance: bigint;
  lifetimeEarned: bigint;
  lifetimeSpent: bigint;
}

interface ConfigDbRow {
  guildId: string;
  nitradoConnId: string;
  enabled: boolean;
  currencyName: string;
  emoji: string;
  startBalance: number;
  playtimeRewardPercent: number;
  bankInterestPercent: number;
  bankChannelId: string | null;
}

type RawDb = {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
};

const DEFAULT_CONFIG: Omit<EconomyConfigRow, 'guildId' | 'nitradoConnId'> = {
  enabled: false,
  currencyName: 'Coins',
  emoji: '🪙',
  startBalance: 0,
  playtimeRewardPercent: 0,
  bankInterestPercent: 0,
  bankChannelId: null,
};

async function queryOne<T>(db: RawDb, sql: string, ...values: unknown[]): Promise<T | null> {
  const rows = await db.$queryRawUnsafe<T[]>(sql, ...values);
  return rows[0] ?? null;
}

function toAccount(row: AccountDbRow): AccountRow {
  return {
    guildId: row.guildId as GuildId,
    nitradoConnId: row.nitradoConnId as NitradoConnId,
    userDiscordId: row.userDiscordId as UserDiscordId,
    walletBalance: row.walletBalance,
    bankBalance: row.bankBalance,
    lifetimeEarned: row.lifetimeEarned,
    lifetimeSpent: row.lifetimeSpent,
  };
}

async function findAccount(
  db: RawDb,
  guildId: GuildId,
  nitradoConnId: NitradoConnId,
  userDiscordId: UserDiscordId,
): Promise<AccountDbRow | null> {
  return queryOne<AccountDbRow>(db,
    'SELECT "id", "guildId", "nitradoConnId", "userDiscordId", "walletBalance", "bankBalance", "lifetimeEarned", "lifetimeSpent" FROM "EconomyAccount" WHERE "guildId" = $1 AND "nitradoConnId" = $2 AND "userDiscordId" = $3 LIMIT 1',
    String(guildId), String(nitradoConnId), String(userDiscordId));
}

async function ensureAccount(
  db: RawDb,
  guildId: GuildId,
  nitradoConnId: NitradoConnId,
  userDiscordId: UserDiscordId,
): Promise<AccountDbRow> {
  await db.$executeRawUnsafe(
    'INSERT INTO "EconomyAccount" ("id", "guildId", "nitradoConnId", "userDiscordId", "walletBalance", "bankBalance", "lifetimeEarned", "lifetimeSpent", "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,0,0,0,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT ("guildId", "nitradoConnId", "userDiscordId") DO NOTHING',
    randomUUID(), String(guildId), String(nitradoConnId), String(userDiscordId));
  const row = await findAccount(db, guildId, nitradoConnId, userDiscordId);
  if (!row) throw new Error('EconomyAccount konnte nicht angelegt werden');
  return row;
}

async function insertTransaction(db: RawDb, args: {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  userDiscordId: UserDiscordId;
  delta: bigint;
  type: EconomyTxType;
  reason?: string | null;
  actorDiscordId?: UserDiscordId | null;
  counterpartDiscordId?: UserDiscordId | null;
}): Promise<void> {
  await db.$executeRawUnsafe(
    'INSERT INTO "EconomyTransaction" ("id", "guildId", "nitradoConnId", "userDiscordId", "delta", "type", "reason", "actorDiscordId", "counterpartDiscordId", "createdAt") VALUES ($1,$2,$3,$4,$5,$6::"EconomyTxType",$7,$8,$9,CURRENT_TIMESTAMP)',
    randomUUID(), String(args.guildId), String(args.nitradoConnId), String(args.userDiscordId),
    args.delta, args.type, args.reason ?? null, args.actorDiscordId ? String(args.actorDiscordId) : null,
    args.counterpartDiscordId ? String(args.counterpartDiscordId) : null);
}

async function insertLedger(db: RawDb, args: {
  idempotencyKey: string;
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  userDiscordId: UserDiscordId;
  walletDelta?: bigint;
  bankDelta?: bigint;
  type: EconomyTxType;
  reason?: string | null;
  sourceRef?: string | null;
}): Promise<boolean> {
  const changed = await db.$executeRawUnsafe(
    'INSERT INTO "EconomyLedgerEntry" ("id", "idempotencyKey", "guildId", "nitradoConnId", "userDiscordId", "walletDelta", "bankDelta", "type", "reason", "buckets", "sourceRef", "createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8::"EconomyTxType",$9,0,$10,CURRENT_TIMESTAMP) ON CONFLICT ("idempotencyKey") DO NOTHING',
    randomUUID(), args.idempotencyKey, String(args.guildId), String(args.nitradoConnId), String(args.userDiscordId),
    args.walletDelta ?? 0n, args.bankDelta ?? 0n, args.type, args.reason ?? null, args.sourceRef ?? null);
  return changed === 1;
}

export async function getConfig(
  guildId: GuildId,
  nitradoConnId: NitradoConnId,
): Promise<EconomyConfigRow> {
  await assertEconomyScopeReady(guildId, nitradoConnId);
  const row = await queryOne<ConfigDbRow>(prisma as unknown as RawDb,
    'SELECT "guildId", "nitradoConnId", "enabled", "currencyName", "emoji", "startBalance", "playtimeRewardPercent", "bankInterestPercent", "bankChannelId" FROM "EconomyConfig" WHERE "guildId" = $1 AND "nitradoConnId" = $2 LIMIT 1',
    String(guildId), String(nitradoConnId));
  if (!row) return { guildId, nitradoConnId, ...DEFAULT_CONFIG };
  return {
    guildId: row.guildId as GuildId,
    nitradoConnId: row.nitradoConnId as NitradoConnId,
    enabled: row.enabled,
    currencyName: row.currencyName,
    emoji: row.emoji,
    startBalance: row.startBalance,
    playtimeRewardPercent: row.playtimeRewardPercent,
    bankInterestPercent: row.bankInterestPercent,
    bankChannelId: row.bankChannelId,
  };
}

export async function upsertConfig(
  guildId: GuildId,
  nitradoConnId: NitradoConnId,
  patch: Partial<Omit<EconomyConfigRow, 'guildId' | 'nitradoConnId'>>,
): Promise<EconomyConfigRow> {
  await assertEconomyScopeReady(guildId, nitradoConnId);
  const current = await getConfig(guildId, nitradoConnId);
  const merged = { ...current, ...patch };
  if (merged.startBalance < 0) throw new Error('startBalance darf nicht negativ sein');
  if (merged.playtimeRewardPercent < 0 || merged.playtimeRewardPercent > 1000) throw new Error('playtimeRewardPercent 0..1000');
  if (merged.bankInterestPercent < 0 || merged.bankInterestPercent > 100) throw new Error('bankInterestPercent 0..100');

  await (prisma as unknown as RawDb).$executeRawUnsafe(
    'INSERT INTO "EconomyConfig" ("id", "guildId", "nitradoConnId", "currencyName", "emoji", "enabled", "startBalance", "playtimeRewardPercent", "bankChannelId", "bankInterestPercent", "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT ("guildId", "nitradoConnId") DO UPDATE SET "currencyName"=EXCLUDED."currencyName", "emoji"=EXCLUDED."emoji", "enabled"=EXCLUDED."enabled", "startBalance"=EXCLUDED."startBalance", "playtimeRewardPercent"=EXCLUDED."playtimeRewardPercent", "bankChannelId"=EXCLUDED."bankChannelId", "bankInterestPercent"=EXCLUDED."bankInterestPercent", "updatedAt"=CURRENT_TIMESTAMP',
    randomUUID(), String(guildId), String(nitradoConnId), merged.currencyName, merged.emoji, merged.enabled,
    merged.startBalance, merged.playtimeRewardPercent, merged.bankChannelId, merged.bankInterestPercent);
  return getConfig(guildId, nitradoConnId);
}

export async function getOrCreateAccount(
  guildId: GuildId,
  nitradoConnId: NitradoConnId,
  userDiscordId: UserDiscordId,
): Promise<AccountRow> {
  await assertEconomyScopeReady(guildId, nitradoConnId);
  return toAccount(await ensureAccount(prisma as unknown as RawDb, guildId, nitradoConnId, userDiscordId));
}

export async function getAccount(
  guildId: GuildId,
  nitradoConnId: NitradoConnId,
  userDiscordId: UserDiscordId,
): Promise<AccountRow | null> {
  await assertEconomyScopeReady(guildId, nitradoConnId);
  const row = await findAccount(prisma as unknown as RawDb, guildId, nitradoConnId, userDiscordId);
  return row ? toAccount(row) : null;
}

export async function getAccountOrZero(
  guildId: GuildId,
  nitradoConnId: NitradoConnId,
  userDiscordId: UserDiscordId,
): Promise<AccountRow> {
  return (await getAccount(guildId, nitradoConnId, userDiscordId)) ?? {
    guildId,
    nitradoConnId,
    userDiscordId,
    walletBalance: 0n,
    bankBalance: 0n,
    lifetimeEarned: 0n,
    lifetimeSpent: 0n,
  };
}

/** Startguthaben exakt einmal pro (Guild+Server+User), auch ueber Leave/Rejoin. */
export async function maybeGrantStartBalance(
  guildId: GuildId,
  nitradoConnId: NitradoConnId,
  userDiscordId: UserDiscordId,
): Promise<{ granted: boolean; amount: bigint }> {
  const cfg = await getConfig(guildId, nitradoConnId);
  if (!cfg.enabled || cfg.startBalance <= 0) return { granted: false, amount: 0n };

  if (await hasCompletedLeaveCleanupReceipt(
    String(guildId),
    String(userDiscordId),
    config.security.encryptionKey,
  )) {
    return { granted: false, amount: 0n };
  }

  const amount = BigInt(cfg.startBalance);
  const subjectKey = economySubjectKey(String(guildId), String(userDiscordId), config.security.encryptionKey);

  return prisma.$transaction(async tx => {
    const db = tx as unknown as RawDb;
    const inserted = await db.$executeRawUnsafe(
      'INSERT INTO "EconomyAccount" ("id", "guildId", "nitradoConnId", "userDiscordId", "walletBalance", "bankBalance", "lifetimeEarned", "lifetimeSpent", "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,$5,0,$5,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT ("guildId", "nitradoConnId", "userDiscordId") DO NOTHING',
      randomUUID(), String(guildId), String(nitradoConnId), String(userDiscordId), amount);
    if (inserted !== 1) return { granted: false, amount: 0n };

    const key = `startbalance:${guildId}:${nitradoConnId}:${subjectKey}`;
    const ledgerCreated = await insertLedger(db, {
      idempotencyKey: key, guildId, nitradoConnId, userDiscordId,
      walletDelta: amount, type: 'STARTBALANCE_JOIN', reason: 'Initial-Balance bei Server-Join', sourceRef: subjectKey,
    });
    if (!ledgerCreated) throw new Error('Startbalance-Idempotency-Key existiert bereits');
    await insertTransaction(db, {
      guildId, nitradoConnId, userDiscordId, delta: amount,
      type: 'STARTBALANCE_JOIN', reason: 'Initial-Balance bei Server-Join', actorDiscordId: null,
    });
    return { granted: true, amount };
  });
}

export async function pay(args: {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  fromUserId: UserDiscordId;
  toUserId: UserDiscordId;
  amount: bigint;
  reason: string;
}): Promise<void> {
  if (args.fromUserId === args.toUserId) throw new Error('Self-Pay nicht erlaubt');
  if (args.amount <= 0n) throw new Error('Betrag muss > 0 sein');
  await assertEconomyScopeReady(args.guildId, args.nitradoConnId);

  await prisma.$transaction(async tx => {
    const db = tx as unknown as RawDb;
    const sourceChanged = await db.$executeRawUnsafe(
      'UPDATE "EconomyAccount" SET "walletBalance"="walletBalance"-$4, "lifetimeSpent"="lifetimeSpent"+$4, "updatedAt"=CURRENT_TIMESTAMP WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "userDiscordId"=$3 AND "walletBalance">=$4',
      String(args.guildId), String(args.nitradoConnId), String(args.fromUserId), args.amount);
    if (sourceChanged !== 1) throw new Error('Unzureichendes Guthaben');

    await ensureAccount(db, args.guildId, args.nitradoConnId, args.toUserId);
    const targetChanged = await db.$executeRawUnsafe(
      'UPDATE "EconomyAccount" SET "walletBalance"="walletBalance"+$4, "lifetimeEarned"="lifetimeEarned"+$4, "updatedAt"=CURRENT_TIMESTAMP WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "userDiscordId"=$3',
      String(args.guildId), String(args.nitradoConnId), String(args.toUserId), args.amount);
    if (targetChanged !== 1) throw new Error('Zielkonto konnte nicht aktualisiert werden');

    const transferId = randomUUID();
    await insertTransaction(db, { guildId: args.guildId, nitradoConnId: args.nitradoConnId, userDiscordId: args.fromUserId, delta: -args.amount, type: 'PAY', reason: args.reason, actorDiscordId: args.fromUserId, counterpartDiscordId: args.toUserId });
    await insertTransaction(db, { guildId: args.guildId, nitradoConnId: args.nitradoConnId, userDiscordId: args.toUserId, delta: args.amount, type: 'PAY', reason: args.reason, actorDiscordId: args.fromUserId, counterpartDiscordId: args.fromUserId });
    await insertLedger(db, { idempotencyKey: `pay:${args.nitradoConnId}:${transferId}:from`, guildId: args.guildId, nitradoConnId: args.nitradoConnId, userDiscordId: args.fromUserId, walletDelta: -args.amount, type: 'PAY', reason: args.reason });
    await insertLedger(db, { idempotencyKey: `pay:${args.nitradoConnId}:${transferId}:to`, guildId: args.guildId, nitradoConnId: args.nitradoConnId, userDiscordId: args.toUserId, walletDelta: args.amount, type: 'PAY', reason: args.reason });
  });
}

export async function adminPay(args: {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  targetUserId: UserDiscordId;
  delta: bigint;
  reason: string;
  actorDiscordId: UserDiscordId;
}): Promise<void> {
  if (args.delta === 0n) throw new Error('Delta darf nicht 0 sein');
  await assertEconomyScopeReady(args.guildId, args.nitradoConnId);

  await prisma.$transaction(async tx => {
    const db = tx as unknown as RawDb;
    if (args.delta < 0n) {
      const amount = -args.delta;
      const changed = await db.$executeRawUnsafe(
        'UPDATE "EconomyAccount" SET "walletBalance"="walletBalance"-$4, "lifetimeSpent"="lifetimeSpent"+$4, "updatedAt"=CURRENT_TIMESTAMP WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "userDiscordId"=$3 AND "walletBalance">=$4',
        String(args.guildId), String(args.nitradoConnId), String(args.targetUserId), amount);
      if (changed !== 1) throw new Error('Empfaenger hat zu wenig Guthaben fuer negatives Delta');
    } else {
      await ensureAccount(db, args.guildId, args.nitradoConnId, args.targetUserId);
      const changed = await db.$executeRawUnsafe(
        'UPDATE "EconomyAccount" SET "walletBalance"="walletBalance"+$4, "lifetimeEarned"="lifetimeEarned"+$4, "updatedAt"=CURRENT_TIMESTAMP WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "userDiscordId"=$3',
        String(args.guildId), String(args.nitradoConnId), String(args.targetUserId), args.delta);
      if (changed !== 1) throw new Error('Zielkonto konnte nicht aktualisiert werden');
    }
    await insertTransaction(db, { guildId: args.guildId, nitradoConnId: args.nitradoConnId, userDiscordId: args.targetUserId, delta: args.delta, type: 'ADMIN_PAY', reason: args.reason, actorDiscordId: args.actorDiscordId });
    await insertLedger(db, { idempotencyKey: `admin-pay:${args.nitradoConnId}:${randomUUID()}`, guildId: args.guildId, nitradoConnId: args.nitradoConnId, userDiscordId: args.targetUserId, walletDelta: args.delta, type: 'ADMIN_PAY', reason: args.reason });
  });
}

export async function deposit(
  guildId: GuildId,
  nitradoConnId: NitradoConnId,
  userId: UserDiscordId,
  amount: bigint,
): Promise<void> {
  if (amount <= 0n) throw new Error('Betrag muss > 0 sein');
  await assertEconomyScopeReady(guildId, nitradoConnId);
  const subjectKey = economySubjectKey(String(guildId), String(userId), config.security.encryptionKey);
  await prisma.$transaction(async tx => {
    const db = tx as unknown as RawDb;
    const changed = await db.$executeRawUnsafe(
      'UPDATE "EconomyAccount" SET "walletBalance"="walletBalance"-$4, "bankBalance"="bankBalance"+$4, "updatedAt"=CURRENT_TIMESTAMP WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "userDiscordId"=$3 AND "walletBalance">=$4',
      String(guildId), String(nitradoConnId), String(userId), amount);
    if (changed !== 1) throw new Error('Wallet zu klein');
    await insertTransaction(db, { guildId, nitradoConnId, userDiscordId: userId, delta: 0n, type: 'DEPOSIT', reason: `Wallet -> Bank ${amount}`, actorDiscordId: userId });
    await insertLedger(db, { idempotencyKey: `deposit:${guildId}:${nitradoConnId}:${subjectKey}:${randomUUID()}`, guildId, nitradoConnId, userDiscordId: userId, walletDelta: -amount, bankDelta: amount, type: 'DEPOSIT', reason: 'Wallet -> Bank', sourceRef: subjectKey });
  });
}

export async function withdraw(
  guildId: GuildId,
  nitradoConnId: NitradoConnId,
  userId: UserDiscordId,
  amount: bigint,
): Promise<void> {
  if (amount <= 0n) throw new Error('Betrag muss > 0 sein');
  await assertEconomyScopeReady(guildId, nitradoConnId);
  const subjectKey = economySubjectKey(String(guildId), String(userId), config.security.encryptionKey);
  await prisma.$transaction(async tx => {
    const db = tx as unknown as RawDb;
    const changed = await db.$executeRawUnsafe(
      'UPDATE "EconomyAccount" SET "bankBalance"="bankBalance"-$4, "walletBalance"="walletBalance"+$4, "updatedAt"=CURRENT_TIMESTAMP WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "userDiscordId"=$3 AND "bankBalance">=$4',
      String(guildId), String(nitradoConnId), String(userId), amount);
    if (changed !== 1) throw new Error('Bank zu klein');
    await insertTransaction(db, { guildId, nitradoConnId, userDiscordId: userId, delta: 0n, type: 'WITHDRAW', reason: `Bank -> Wallet ${amount}`, actorDiscordId: userId });
    await insertLedger(db, { idempotencyKey: `withdraw:${guildId}:${nitradoConnId}:${subjectKey}:${randomUUID()}`, guildId, nitradoConnId, userDiscordId: userId, walletDelta: amount, bankDelta: -amount, type: 'WITHDRAW', reason: 'Bank -> Wallet', sourceRef: subjectKey });
  });
}

export async function transferBank(args: {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  fromUserId: UserDiscordId;
  toUserId: UserDiscordId;
  amount: bigint;
}): Promise<void> {
  if (args.fromUserId === args.toUserId) throw new Error('Self-Transfer nicht erlaubt');
  if (args.amount <= 0n) throw new Error('Betrag muss > 0 sein');
  await assertEconomyScopeReady(args.guildId, args.nitradoConnId);

  await prisma.$transaction(async tx => {
    const db = tx as unknown as RawDb;
    const sourceChanged = await db.$executeRawUnsafe(
      'UPDATE "EconomyAccount" SET "bankBalance"="bankBalance"-$4, "updatedAt"=CURRENT_TIMESTAMP WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "userDiscordId"=$3 AND "bankBalance">=$4',
      String(args.guildId), String(args.nitradoConnId), String(args.fromUserId), args.amount);
    if (sourceChanged !== 1) throw new Error('Bank zu klein');

    await ensureAccount(db, args.guildId, args.nitradoConnId, args.toUserId);
    const targetChanged = await db.$executeRawUnsafe(
      'UPDATE "EconomyAccount" SET "bankBalance"="bankBalance"+$4, "updatedAt"=CURRENT_TIMESTAMP WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "userDiscordId"=$3',
      String(args.guildId), String(args.nitradoConnId), String(args.toUserId), args.amount);
    if (targetChanged !== 1) throw new Error('Zielkonto konnte nicht aktualisiert werden');

    await insertTransaction(db, { guildId: args.guildId, nitradoConnId: args.nitradoConnId, userDiscordId: args.fromUserId, delta: -args.amount, type: 'TRANSFER', reason: 'Bank-Transfer', actorDiscordId: args.fromUserId, counterpartDiscordId: args.toUserId });
    await insertTransaction(db, { guildId: args.guildId, nitradoConnId: args.nitradoConnId, userDiscordId: args.toUserId, delta: args.amount, type: 'TRANSFER', reason: 'Bank-Transfer', actorDiscordId: args.fromUserId, counterpartDiscordId: args.fromUserId });
    const transferId = randomUUID();
    await insertLedger(db, { idempotencyKey: `transfer:${args.nitradoConnId}:${transferId}:from`, guildId: args.guildId, nitradoConnId: args.nitradoConnId, userDiscordId: args.fromUserId, bankDelta: -args.amount, type: 'TRANSFER', reason: 'Bank-Transfer' });
    await insertLedger(db, { idempotencyKey: `transfer:${args.nitradoConnId}:${transferId}:to`, guildId: args.guildId, nitradoConnId: args.nitradoConnId, userDiscordId: args.toUserId, bankDelta: args.amount, type: 'TRANSFER', reason: 'Bank-Transfer' });
  });
}

export async function recentTransactions(
  guildId: GuildId,
  nitradoConnId: NitradoConnId,
  userId: UserDiscordId,
  limit = 10,
): Promise<Array<{ id: string; delta: bigint; type: EconomyTxType; reason: string | null; createdAt: Date }>> {
  await assertEconomyScopeReady(guildId, nitradoConnId);
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  return (prisma as unknown as RawDb).$queryRawUnsafe(
    'SELECT "id", "delta", "type", "reason", "createdAt" FROM "EconomyTransaction" WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "userDiscordId"=$3 ORDER BY "createdAt" DESC LIMIT $4',
    String(guildId), String(nitradoConnId), String(userId), safeLimit,
  );
}

export type { Prisma };