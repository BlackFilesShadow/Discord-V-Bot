/**
 * Economy-Repository — atomare Wallet/Bank-Operationen.
 *
 * KRITISCH: jede Mutation ist `prisma.$transaction([...])` mit row-level-locks
 * via `update where: id` (Postgres SELECT FOR UPDATE-Semantik bei updateMany
 * + WHERE balance >= delta).
 *
 * Geld-Werte: BigInt. NIEMALS Number.
 */

import prisma from '../../database/prisma';
import type { GuildId, UserDiscordId } from '../../types/scope';
import type { EconomyTxType, Prisma } from '@prisma/client';

export interface EconomyConfigRow {
  guildId: GuildId;
  enabled: boolean;
  currencyName: string;
  emoji: string;
  startBalance: number; // Int im Schema (vernuenftige Obergrenze)
  playtimeRewardPercent: number;
  bankInterestPercent: number;
  bankChannelId: string | null;
}

export interface AccountRow {
  guildId: GuildId;
  userDiscordId: UserDiscordId;
  walletBalance: bigint;
  bankBalance: bigint;
  lifetimeEarned: bigint;
  lifetimeSpent: bigint;
}

const DEFAULT_CONFIG: Omit<EconomyConfigRow, 'guildId'> = {
  enabled: false,
  currencyName: 'Coins',
  emoji: '🪙',
  startBalance: 0,
  playtimeRewardPercent: 0,
  bankInterestPercent: 0,
  bankChannelId: null,
};

export async function getConfig(guildId: GuildId): Promise<EconomyConfigRow> {
  const row = await prisma.economyConfig.findUnique({ where: { guildId } });
  if (!row) return { guildId, ...DEFAULT_CONFIG };
  return {
    guildId: row.guildId as GuildId,
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
  patch: Partial<Omit<EconomyConfigRow, 'guildId'>>,
): Promise<EconomyConfigRow> {
  const merged = { ...DEFAULT_CONFIG, ...patch };
  if (merged.startBalance < 0) throw new Error('startBalance darf nicht negativ sein');
  if (merged.playtimeRewardPercent < 0 || merged.playtimeRewardPercent > 1000) {
    throw new Error('playtimeRewardPercent 0..1000');
  }
  if (merged.bankInterestPercent < 0 || merged.bankInterestPercent > 100) {
    throw new Error('bankInterestPercent 0..100');
  }
  const row = await prisma.economyConfig.upsert({
    where: { guildId },
    create: { guildId, ...merged },
    update: merged,
  });
  return {
    guildId: row.guildId as GuildId,
    enabled: row.enabled,
    currencyName: row.currencyName,
    emoji: row.emoji,
    startBalance: row.startBalance,
    playtimeRewardPercent: row.playtimeRewardPercent,
    bankInterestPercent: row.bankInterestPercent,
    bankChannelId: row.bankChannelId,
  };
}

export async function getOrCreateAccount(
  guildId: GuildId,
  userDiscordId: UserDiscordId,
): Promise<AccountRow> {
  const row = await prisma.economyAccount.upsert({
    where: { guildId_userDiscordId: { guildId, userDiscordId } },
    create: { guildId, userDiscordId },
    update: {},
  });
  return {
    guildId: row.guildId as GuildId,
    userDiscordId: row.userDiscordId as UserDiscordId,
    walletBalance: row.walletBalance,
    bankBalance: row.bankBalance,
    lifetimeEarned: row.lifetimeEarned,
    lifetimeSpent: row.lifetimeSpent,
  };
}

export async function getAccount(
  guildId: GuildId,
  userDiscordId: UserDiscordId,
): Promise<AccountRow | null> {
  const row = await prisma.economyAccount.findUnique({
    where: { guildId_userDiscordId: { guildId, userDiscordId } },
  });
  if (!row) return null;
  return {
    guildId: row.guildId as GuildId,
    userDiscordId: row.userDiscordId as UserDiscordId,
    walletBalance: row.walletBalance,
    bankBalance: row.bankBalance,
    lifetimeEarned: row.lifetimeEarned,
    lifetimeSpent: row.lifetimeSpent,
  };
}

/**
 * Erstellt initial-Account beim Server-Join, wenn `EconomyConfig.startBalance > 0`.
 * Idempotent: wenn Account schon existiert, wird NICHTS verändert.
 */
export async function maybeGrantStartBalance(
  guildId: GuildId,
  userDiscordId: UserDiscordId,
): Promise<{ granted: boolean; amount: bigint }> {
  const cfg = await getConfig(guildId);
  if (!cfg.enabled || cfg.startBalance <= 0) return { granted: false, amount: 0n };
  const amount = BigInt(cfg.startBalance);

  return prisma.$transaction(async tx => {
    const existing = await tx.economyAccount.findUnique({
      where: { guildId_userDiscordId: { guildId, userDiscordId } },
    });
    if (existing) return { granted: false, amount: 0n };
    await tx.economyAccount.create({
      data: {
        guildId,
        userDiscordId,
        walletBalance: amount,
        lifetimeEarned: amount,
      },
    });
    await tx.economyTransaction.create({
      data: {
        guildId,
        userDiscordId,
        delta: amount,
        type: 'STARTBALANCE_JOIN',
        reason: 'Initial-Balance bei Guild-Join',
        actorDiscordId: null,
      },
    });
    return { granted: true, amount };
  });
}

/**
 * Atomarer Pay (User → User) aus Wallet → Wallet.
 * Wirft, wenn Quelle unter `amount` faellt (Race-safe via WHERE-Check).
 */
export async function pay(args: {
  guildId: GuildId;
  fromUserId: UserDiscordId;
  toUserId: UserDiscordId;
  amount: bigint;
  reason: string;
}): Promise<void> {
  if (args.fromUserId === args.toUserId) throw new Error('Self-Pay nicht erlaubt');
  if (args.amount <= 0n) throw new Error('Betrag muss > 0 sein');

  await prisma.$transaction(async tx => {
    // Source: atomare Bedingung walletBalance >= amount
    const updated = await tx.economyAccount.updateMany({
      where: {
        guildId: args.guildId,
        userDiscordId: args.fromUserId,
        walletBalance: { gte: args.amount },
      },
      data: {
        walletBalance: { decrement: args.amount },
        lifetimeSpent: { increment: args.amount },
      },
    });
    if (updated.count !== 1) throw new Error('Unzureichendes Guthaben');

    // Target: upsert + increment
    await tx.economyAccount.upsert({
      where: { guildId_userDiscordId: { guildId: args.guildId, userDiscordId: args.toUserId } },
      create: {
        guildId: args.guildId,
        userDiscordId: args.toUserId,
        walletBalance: args.amount,
        lifetimeEarned: args.amount,
      },
      update: {
        walletBalance: { increment: args.amount },
        lifetimeEarned: { increment: args.amount },
      },
    });

    // Audit-Trail (zwei Eintraege fuer Lesbarkeit)
    await tx.economyTransaction.createMany({
      data: [
        {
          guildId: args.guildId,
          userDiscordId: args.fromUserId,
          delta: -args.amount,
          type: 'PAY',
          reason: args.reason,
          actorDiscordId: args.fromUserId,
          counterpartDiscordId: args.toUserId,
        },
        {
          guildId: args.guildId,
          userDiscordId: args.toUserId,
          delta: args.amount,
          type: 'PAY',
          reason: args.reason,
          actorDiscordId: args.fromUserId,
          counterpartDiscordId: args.fromUserId,
        },
      ],
    });
  });
}

export async function adminPay(args: {
  guildId: GuildId;
  targetUserId: UserDiscordId;
  delta: bigint; // ggf. negativ
  reason: string;
  actorDiscordId: UserDiscordId;
}): Promise<void> {
  if (args.delta === 0n) throw new Error('Delta darf nicht 0 sein');
  await prisma.$transaction(async tx => {
    if (args.delta < 0n) {
      const u = await tx.economyAccount.updateMany({
        where: {
          guildId: args.guildId,
          userDiscordId: args.targetUserId,
          walletBalance: { gte: -args.delta },
        },
        data: { walletBalance: { decrement: -args.delta }, lifetimeSpent: { increment: -args.delta } },
      });
      if (u.count !== 1) throw new Error('Empfaenger hat zu wenig Guthaben fuer negatives Delta');
    } else {
      await tx.economyAccount.upsert({
        where: { guildId_userDiscordId: { guildId: args.guildId, userDiscordId: args.targetUserId } },
        create: {
          guildId: args.guildId,
          userDiscordId: args.targetUserId,
          walletBalance: args.delta,
          lifetimeEarned: args.delta,
        },
        update: { walletBalance: { increment: args.delta }, lifetimeEarned: { increment: args.delta } },
      });
    }
    await tx.economyTransaction.create({
      data: {
        guildId: args.guildId,
        userDiscordId: args.targetUserId,
        delta: args.delta,
        type: 'ADMIN_PAY',
        reason: args.reason,
        actorDiscordId: args.actorDiscordId,
      },
    });
  });
}

export async function deposit(
  guildId: GuildId,
  userId: UserDiscordId,
  amount: bigint,
): Promise<void> {
  if (amount <= 0n) throw new Error('Betrag muss > 0 sein');
  await prisma.$transaction(async tx => {
    const u = await tx.economyAccount.updateMany({
      where: { guildId, userDiscordId: userId, walletBalance: { gte: amount } },
      data: { walletBalance: { decrement: amount }, bankBalance: { increment: amount } },
    });
    if (u.count !== 1) throw new Error('Wallet zu klein');
    await tx.economyTransaction.create({
      data: {
        guildId,
        userDiscordId: userId,
        delta: 0n,
        type: 'DEPOSIT',
        reason: `Wallet -> Bank ${amount}`,
        actorDiscordId: userId,
      },
    });
  });
}

export async function withdraw(
  guildId: GuildId,
  userId: UserDiscordId,
  amount: bigint,
): Promise<void> {
  if (amount <= 0n) throw new Error('Betrag muss > 0 sein');
  await prisma.$transaction(async tx => {
    const u = await tx.economyAccount.updateMany({
      where: { guildId, userDiscordId: userId, bankBalance: { gte: amount } },
      data: { bankBalance: { decrement: amount }, walletBalance: { increment: amount } },
    });
    if (u.count !== 1) throw new Error('Bank zu klein');
    await tx.economyTransaction.create({
      data: {
        guildId,
        userDiscordId: userId,
        delta: 0n,
        type: 'WITHDRAW',
        reason: `Bank -> Wallet ${amount}`,
        actorDiscordId: userId,
      },
    });
  });
}

export async function transferBank(args: {
  guildId: GuildId;
  fromUserId: UserDiscordId;
  toUserId: UserDiscordId;
  amount: bigint;
}): Promise<void> {
  if (args.fromUserId === args.toUserId) throw new Error('Self-Transfer nicht erlaubt');
  if (args.amount <= 0n) throw new Error('Betrag muss > 0 sein');
  await prisma.$transaction(async tx => {
    const u = await tx.economyAccount.updateMany({
      where: { guildId: args.guildId, userDiscordId: args.fromUserId, bankBalance: { gte: args.amount } },
      data: { bankBalance: { decrement: args.amount } },
    });
    if (u.count !== 1) throw new Error('Bank zu klein');
    await tx.economyAccount.upsert({
      where: { guildId_userDiscordId: { guildId: args.guildId, userDiscordId: args.toUserId } },
      create: { guildId: args.guildId, userDiscordId: args.toUserId, bankBalance: args.amount },
      update: { bankBalance: { increment: args.amount } },
    });
    await tx.economyTransaction.createMany({
      data: [
        {
          guildId: args.guildId,
          userDiscordId: args.fromUserId,
          delta: -args.amount,
          type: 'TRANSFER',
          reason: 'Bank-Transfer',
          actorDiscordId: args.fromUserId,
          counterpartDiscordId: args.toUserId,
        },
        {
          guildId: args.guildId,
          userDiscordId: args.toUserId,
          delta: args.amount,
          type: 'TRANSFER',
          reason: 'Bank-Transfer',
          actorDiscordId: args.fromUserId,
          counterpartDiscordId: args.fromUserId,
        },
      ],
    });
  });
}

export async function recentTransactions(
  guildId: GuildId,
  userId: UserDiscordId,
  limit = 10,
): Promise<Array<{ id: string; delta: bigint; type: EconomyTxType; reason: string | null; createdAt: Date }>> {
  const rows = await prisma.economyTransaction.findMany({
    where: { guildId, userDiscordId: userId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: { id: true, delta: true, type: true, reason: true, createdAt: true },
  });
  return rows;
}

export type { Prisma };
