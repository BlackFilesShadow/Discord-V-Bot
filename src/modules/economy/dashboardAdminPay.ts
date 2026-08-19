import crypto from 'node:crypto';
import prisma from '../../database/prisma';
import type { GuildId, NitradoConnId, UserDiscordId } from '../../types/scope';
import { assertEconomyScopeReady } from './scopeMigration';

export interface DashboardAdminPayInput {
  httpIdempotencyKey: string;
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  targetUserId: UserDiscordId;
  delta: bigint;
  reason: string;
  actorDiscordId: UserDiscordId;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';
}

function operationHash(actorDiscordId: string, rawKey: string): string {
  return crypto.createHash('sha256').update(`${actorDiscordId}:${rawKey}`).digest('hex');
}

function operationIdentity(input: DashboardAdminPayInput): { ledgerKey: string; sourceRef: string } {
  const trimmed = input.httpIdempotencyKey.trim();
  if (trimmed.length < 8 || trimmed.length > 128) {
    throw new Error('X-Idempotency-Key muss 8..128 Zeichen haben.');
  }
  const hash = operationHash(input.actorDiscordId, trimmed);
  return {
    ledgerKey: `dashboard-admin-pay:${hash}`,
    sourceRef: `dashboard-admin-pay:${hash.slice(0, 32)}`,
  };
}

async function assertExactReplay(
  input: DashboardAdminPayInput,
  ledgerKey: string,
  sourceRef: string,
): Promise<void> {
  const existing = await prisma.economyLedgerEntry.findUnique({
    where: { idempotencyKey: ledgerKey },
    select: {
      guildId: true,
      nitradoConnId: true,
      userDiscordId: true,
      walletDelta: true,
      bankDelta: true,
      type: true,
      reason: true,
      sourceRef: true,
    },
  });

  const matches = !!existing
    && existing.guildId === input.guildId
    && existing.nitradoConnId === input.nitradoConnId
    && existing.userDiscordId === input.targetUserId
    && existing.walletDelta === input.delta
    && existing.bankDelta === 0n
    && existing.type === 'ADMIN_PAY'
    && existing.reason === input.reason
    && existing.sourceRef === sourceRef;

  if (!matches) {
    throw new Error('Dashboard-Admin-Pay-Idempotency-Key wurde mit anderen Buchungsdaten wiederverwendet.');
  }
}

/**
 * Fachlicher exact-once Commit fuer direkte Dashboard-Admin-Buchungen.
 *
 * Die allgemeine HTTP-Idempotenz verhindert parallele Handler und bewahrt
 * Retry-Keys. Diese zweite, geldnahe Schranke deckt den engeren Crash-Fall ab:
 * DB-Geldcommit ist erfolgreich, der Prozess stirbt aber bevor die HTTP-Schicht
 * ihre DONE-Antwort persistieren kann. Ein spaeterer legitimer HTTP-Reclaim darf
 * dann dieselbe Balance niemals ein zweites Mal mutieren.
 *
 * Der rohe HTTP-Key wird nicht im Economy-Ledger gespeichert. Der Ledger-Claim
 * ist ein SHA-256-Derivat aus Actor + Key und entsteht in derselben Transaktion
 * VOR jeder Account-Mutation. Bei Unterdeckung rollt deshalb auch der Claim
 * zurueck. Ein Retry akzeptiert nur einen exakt passenden bestehenden Commit.
 *
 * Der bisherige Economy-Domain-Guard bleibt erhalten: Legacy-Scope-Migration
 * wird vor Ledger-Claim und jeder Geldmutation fail-closed geprueft. Damit darf
 * die Idempotenz-Haertung keine zuvor gesperrte Economy stillschweigend oeffnen.
 */
export async function applyDashboardAdminPay(
  input: DashboardAdminPayInput,
): Promise<{ applied: boolean }> {
  if (input.delta === 0n) throw new Error('Delta darf nicht 0 sein');
  if (input.reason.length < 3 || input.reason.length > 200) throw new Error('Admin-Pay-Grund ist ungueltig.');

  const { ledgerKey, sourceRef } = operationIdentity(input);
  await assertEconomyScopeReady(input.guildId, input.nitradoConnId);

  try {
    await prisma.$transaction(async tx => {
      await tx.economyLedgerEntry.create({
        data: {
          idempotencyKey: ledgerKey,
          guildId: input.guildId,
          nitradoConnId: input.nitradoConnId,
          userDiscordId: input.targetUserId,
          walletDelta: input.delta,
          bankDelta: 0n,
          type: 'ADMIN_PAY',
          reason: input.reason,
          buckets: 0,
          sourceRef,
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
        if (changed.count !== 1) throw new Error('Empfaenger hat zu wenig Guthaben fuer negatives Delta');
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
    if (!isUniqueViolation(error)) throw error;
    await assertExactReplay(input, ledgerKey, sourceRef);
    return { applied: false };
  }
}
