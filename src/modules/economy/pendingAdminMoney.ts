import prisma from '../../database/prisma';

export interface PendingAdminMoneyInput {
  actionId: string;
  guildId: string;
  nitradoConnId: string;
  targetUserId: string;
  delta: bigint;
  reason: string;
  actorDiscordId: string;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';
}

/**
 * Exact-once Admin-Buchung fuer bestaetigte PendingServerActions.
 *
 * Der eindeutige Ledger-Key wird IN derselben DB-Transaktion vor Account und
 * Audit-Transaction angelegt. Ein Retry nach Crash/Lease-Recovery sieht P2002
 * und fuehrt keinerlei Balance-Aenderung erneut aus. Schlaegt die Balance-
 * Mutation fehl (z.B. zu wenig Guthaben), rollt auch der Ledger-Claim zurueck.
 */
export async function applyPendingAdminMoneyAction(
  input: PendingAdminMoneyInput,
): Promise<{ applied: boolean }> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.actionId)) {
    throw new Error('Pending-Action-ID ist fuer Economy-Idempotenz ungueltig.');
  }
  if (input.delta === 0n) throw new Error('Delta darf nicht 0 sein');
  if (input.reason.length < 3 || input.reason.length > 200) throw new Error('Pending-Action-Grund ist ungueltig.');

  const idempotencyKey = `pending-action:${input.actionId}:admin-pay`;

  try {
    await prisma.$transaction(async tx => {
      await tx.economyLedgerEntry.create({
        data: {
          idempotencyKey,
          guildId: input.guildId,
          nitradoConnId: input.nitradoConnId,
          userDiscordId: input.targetUserId,
          walletDelta: input.delta,
          bankDelta: 0n,
          type: 'ADMIN_PAY',
          reason: input.reason,
          buckets: 0,
          sourceRef: input.actionId,
        },
      });

      if (input.delta < 0n) {
        const amount = -input.delta;
        const changed = await tx.economyAccount.updateMany({
          where: {
            guildId: input.guildId,
            nitradoConnId: input.nitradoConnId,
            userDiscordId: input.targetUserId,
            walletBalance: { gte: amount },
          },
          data: {
            walletBalance: { decrement: amount },
            lifetimeSpent: { increment: amount },
          },
        });
        if (changed.count !== 1) {
          throw new Error('Empfaenger hat zu wenig Guthaben fuer negatives Delta');
        }
      } else {
        await tx.economyAccount.upsert({
          where: {
            guildServerUser: {
              guildId: input.guildId,
              nitradoConnId: input.nitradoConnId,
              userDiscordId: input.targetUserId,
            },
          },
          create: {
            guildId: input.guildId,
            nitradoConnId: input.nitradoConnId,
            userDiscordId: input.targetUserId,
            walletBalance: input.delta,
            bankBalance: 0n,
            lifetimeEarned: input.delta,
            lifetimeSpent: 0n,
          },
          update: {
            walletBalance: { increment: input.delta },
            lifetimeEarned: { increment: input.delta },
          },
        });
      }

      await tx.economyTransaction.create({
        data: {
          guildId: input.guildId,
          nitradoConnId: input.nitradoConnId,
          userDiscordId: input.targetUserId,
          delta: input.delta,
          type: 'ADMIN_PAY',
          reason: input.reason,
          actorDiscordId: input.actorDiscordId,
          counterpartDiscordId: null,
        },
      });
    });
    return { applied: true };
  } catch (error) {
    if (isUniqueViolation(error)) return { applied: false };
    throw error;
  }
}
