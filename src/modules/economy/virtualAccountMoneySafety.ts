import prisma from '../../database/prisma';
import type { GuildId, NitradoConnId, UserDiscordId } from '../../types/scope';
import {
  getVirtualAccountById,
  type EconomyPocket,
  type VirtualAccountRawDb,
  type VirtualAccountRow,
} from './virtualAccounts';
import {
  depositUserIntoVirtualAccount,
  payoutVirtualAccountToUser,
  removeVirtualAccountAmount,
  transferVirtualPocket,
  type VirtualAccountFinance,
} from './virtualAccountFinance';

interface ReplayRow {
  virtualAccountId: string;
  delta: bigint;
  entryType: string;
  sourcePocket: string | null;
  actorDiscordId: string | null;
  userDiscordId: string | null;
  reason: string | null;
  sourceRef: string | null;
}

interface PlayerLedgerReplayRow {
  userDiscordId: string;
  walletDelta: bigint;
  bankDelta: bigint;
  sourceRef: string | null;
}

function rawDb(): VirtualAccountRawDb {
  return prisma as unknown as VirtualAccountRawDb;
}

function externalKey(value: string): string {
  const clean = value.normalize('NFKC').trim();
  if (!clean || clean.length > 80 || !/^[A-Za-z0-9._:-]+$/.test(clean)) throw new Error('Idempotency-Key ungueltig.');
  return clean;
}

function operationKey(prefix: string, guildId: GuildId, connId: NitradoConnId, external: string): string {
  return `${prefix}:${guildId}:${connId}:${externalKey(external)}`;
}

function normalizedReason(value: string | undefined, fallback: string): string {
  return (value?.trim() || fallback).slice(0, 180);
}

function strictReason(value: string, label: string): string {
  const clean = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (clean.length < 3 || clean.length > 180) throw new Error(`${label} muss 3..180 Zeichen enthalten.`);
  return clean;
}

async function assertCustomAccount(guildId: GuildId, connId: NitradoConnId, accountId: string): Promise<VirtualAccountRow> {
  const account = await getVirtualAccountById(guildId, connId, accountId);
  if (!account) throw new Error('Virtuelles Konto nicht gefunden.');
  if (account.kind !== 'CUSTOM') {
    throw new Error('Lotterie- und Markt-Systemkonten duerfen nur durch ihre jeweilige Fachfunktion Geld bewegen.');
  }
  return account;
}

async function replay(key: string): Promise<ReplayRow | null> {
  const rows = await rawDb().$queryRawUnsafe<ReplayRow[]>(
    'SELECT "virtualAccountId", "delta", "entryType", "sourcePocket", "actorDiscordId", "userDiscordId", "reason", "sourceRef" FROM "EconomyVirtualAccountEntry" WHERE "idempotencyKey"=$1 LIMIT 1',
    key,
  );
  return rows[0] ?? null;
}

function assertReplay(actual: ReplayRow | null, expected: ReplayRow): void {
  const same = actual !== null
    && actual.virtualAccountId === expected.virtualAccountId
    && actual.delta === expected.delta
    && actual.entryType === expected.entryType
    && actual.sourcePocket === expected.sourcePocket
    && actual.actorDiscordId === expected.actorDiscordId
    && actual.userDiscordId === expected.userDiscordId
    && actual.reason === expected.reason
    && actual.sourceRef === expected.sourceRef;
  if (!same) throw new Error('Idempotency-Key wurde mit anderen Buchungsdaten wiederverwendet.');
}

async function assertDepositPlayerReplay(args: {
  operationKey: string;
  guildId: GuildId;
  connId: NitradoConnId;
  accountId: string;
  userId: UserDiscordId;
  sourcePocket: EconomyPocket;
  playerAmount: bigint;
}): Promise<void> {
  const rows = await rawDb().$queryRawUnsafe<PlayerLedgerReplayRow[]>(
    'SELECT "userDiscordId", "walletDelta", "bankDelta", "sourceRef" FROM "EconomyLedgerEntry" WHERE "idempotencyKey"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 LIMIT 1',
    `${args.operationKey}:user`,
    String(args.guildId),
    String(args.connId),
  );
  const row = rows[0];
  const expectedWallet = args.sourcePocket === 'WALLET' ? -args.playerAmount : 0n;
  const expectedBank = args.sourcePocket === 'BANK' ? -args.playerAmount : 0n;
  const same = !!row
    && row.userDiscordId === String(args.userId)
    && row.walletDelta === expectedWallet
    && row.bankDelta === expectedBank
    && row.sourceRef === `virtual-account:${args.accountId}`;
  if (!same) throw new Error('Idempotency-Key wurde mit einem anderen urspruenglichen Spielerbetrag wiederverwendet.');
}

export async function safeDepositUserIntoVirtualAccount(args: {
  idempotencyKey: string;
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  accountId: string;
  userDiscordId: UserDiscordId;
  sourcePocket: EconomyPocket;
  playerAmount: bigint;
  reason?: string;
}): Promise<{ booked: boolean; account: VirtualAccountRow; finance: VirtualAccountFinance; playerDebited: bigint; accountCredited: bigint }> {
  await assertCustomAccount(args.guildId, args.nitradoConnId, args.accountId);
  const result = await depositUserIntoVirtualAccount(args);
  if (!result.booked) {
    const reason = normalizedReason(args.reason, 'Einzahlung auf virtuelles Konto');
    const key = operationKey('virtual-deposit', args.guildId, args.nitradoConnId, args.idempotencyKey);
    assertReplay(await replay(key), {
      virtualAccountId: args.accountId,
      delta: result.accountCredited,
      entryType: 'USER_DEPOSIT',
      sourcePocket: args.sourcePocket,
      actorDiscordId: String(args.userDiscordId),
      userDiscordId: String(args.userDiscordId),
      reason,
      sourceRef: `virtual-account:${args.accountId}`,
    });
    await assertDepositPlayerReplay({
      operationKey: key,
      guildId: args.guildId,
      connId: args.nitradoConnId,
      accountId: args.accountId,
      userId: args.userDiscordId,
      sourcePocket: args.sourcePocket,
      playerAmount: args.playerAmount,
    });
  }
  return result;
}

export async function safeTransferVirtualPocket(args: {
  idempotencyKey: string;
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  accountId: string;
  actorDiscordId: UserDiscordId;
  from: EconomyPocket;
  to: EconomyPocket;
  amount: bigint;
  reason?: string;
}) {
  await assertCustomAccount(args.guildId, args.nitradoConnId, args.accountId);
  const result = await transferVirtualPocket(args);
  if (!result.booked) {
    const reason = normalizedReason(args.reason, `${args.from} -> ${args.to}`);
    assertReplay(await replay(operationKey('virtual-pocket', args.guildId, args.nitradoConnId, args.idempotencyKey)), {
      virtualAccountId: args.accountId,
      delta: 0n,
      entryType: 'POCKET_TRANSFER',
      sourcePocket: args.from,
      actorDiscordId: String(args.actorDiscordId),
      userDiscordId: null,
      reason,
      sourceRef: `${args.from}->${args.to}`,
    });
  }
  return result;
}

export async function safeRemoveVirtualAccountAmount(args: {
  idempotencyKey: string;
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  accountId: string;
  actorDiscordId: UserDiscordId;
  pocket: EconomyPocket;
  amount: bigint;
  reason: string;
}) {
  await assertCustomAccount(args.guildId, args.nitradoConnId, args.accountId);
  const reason = strictReason(args.reason, 'Remove-Grund');
  const result = await removeVirtualAccountAmount({ ...args, reason });
  if (!result.booked) {
    assertReplay(await replay(operationKey('virtual-remove', args.guildId, args.nitradoConnId, args.idempotencyKey)), {
      virtualAccountId: args.accountId,
      delta: -args.amount,
      entryType: 'MANAGER_REMOVE',
      sourcePocket: args.pocket,
      actorDiscordId: String(args.actorDiscordId),
      userDiscordId: null,
      reason,
      sourceRef: `virtual-account:${args.accountId}`,
    });
  }
  return result;
}

export async function safePayoutVirtualAccountToUser(args: {
  idempotencyKey: string;
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  accountId: string;
  actorDiscordId: UserDiscordId;
  toUserDiscordId: UserDiscordId;
  sourcePocket: EconomyPocket;
  targetPocket: EconomyPocket;
  accountAmount: bigint;
  reason: string;
}) {
  await assertCustomAccount(args.guildId, args.nitradoConnId, args.accountId);
  const reason = strictReason(args.reason, 'Auszahlungsgrund');
  const result = await payoutVirtualAccountToUser({ ...args, reason });
  if (!result.booked) {
    assertReplay(await replay(operationKey('virtual-payout', args.guildId, args.nitradoConnId, args.idempotencyKey)), {
      virtualAccountId: args.accountId,
      delta: -args.accountAmount,
      entryType: 'MANAGER_PAYOUT',
      sourcePocket: args.sourcePocket,
      actorDiscordId: String(args.actorDiscordId),
      userDiscordId: String(args.toUserDiscordId),
      reason,
      sourceRef: `virtual-account:${args.accountId}`,
    });
  }
  return result;
}
