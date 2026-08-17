import prisma from '../../database/prisma';
import { config } from '../../config';
import { economySubjectKey } from '../economy/subjectKey';
import {
  assertNoOpenLeaveCleanupRequest,
  hasOpenLeaveCleanupRequest,
} from '../moderation/leaveCleanupGuard';
import { hasCompletedLeaveCleanupReceipt } from '../moderation/leaveCleanupSaga';
import { identityHash } from './identity';

export interface LinkRewardScope {
  guildId: string;
  nitradoConnId: string;
}

export interface RewardIdentity {
  userDiscordId: string;
  rewardEligibleFrom: Date;
}

export interface LinkStartBalanceResult {
  granted: boolean;
  amount: bigint;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';
}

/**
 * Aktiviert die Reward-Epoche fuer eine verifizierte DayZ-Identitaet.
 *
 * Der Composite-Upsert macht den Link-Hook auch bei parallelen Retries
 * race-safe. `newLink=true` startet fuer einen bereits bekannten Nutzer eine
 * neue Reward-Epoche; die einmalige Startguthaben-Berechtigung wird dabei
 * bewusst NICHT erneut aktiviert.
 */
export async function activateLinkRewardState(
  scope: LinkRewardScope,
  userDiscordId: string,
  gameId: string,
  secret: string,
  newLink: boolean,
  now: Date = new Date(),
): Promise<Date> {
  await assertNoOpenLeaveCleanupRequest(scope.guildId, userDiscordId);
  const hash = identityHash(gameId, secret);
  const row = await prisma.economyLinkRewardState.upsert({
    where: {
      guildId_nitradoConnId_userDiscordId: {
        guildId: scope.guildId,
        nitradoConnId: scope.nitradoConnId,
        userDiscordId,
      },
    },
    create: {
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
      userDiscordId,
      identityHash: hash,
      rewardEligibleFrom: now,
      startBalanceEligible: true,
    },
    update: newLink
      ? {
          identityHash: hash,
          rewardEligibleFrom: now,
          unlinkedAt: null,
        }
      : {
          identityHash: hash,
          unlinkedAt: null,
        },
    select: { rewardEligibleFrom: true },
  });
  return row.rewardEligibleFrom;
}

/** Unlink beendet sofort die Reward-Berechtigung, ohne Historie zu loeschen. */
export async function deactivateLinkRewardState(
  scope: LinkRewardScope,
  userDiscordId: string,
  now: Date = new Date(),
): Promise<void> {
  await prisma.economyLinkRewardState.updateMany({
    where: {
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
      userDiscordId,
      unlinkedAt: null,
    },
    data: { unlinkedAt: now },
  });
}

/**
 * Kanonische Reward-Aufloesung. Eine aktuelle GameIdentityLink allein reicht
 * nicht: Der Reward-State muss aktiv sein und exakt denselben GUID-HMAC tragen.
 */
export async function resolveRewardIdentity(
  scope: LinkRewardScope,
  gameId: string,
  secret: string,
): Promise<RewardIdentity | null> {
  const hash = identityHash(gameId, secret);
  const link = await prisma.gameIdentityLink.findFirst({
    where: {
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
      identityHash: hash,
      status: 'VERIFIED',
    },
    select: { userDiscordId: true },
  });
  if (!link) return null;

  const state = await prisma.economyLinkRewardState.findUnique({
    where: {
      guildId_nitradoConnId_userDiscordId: {
        guildId: scope.guildId,
        nitradoConnId: scope.nitradoConnId,
        userDiscordId: link.userDiscordId,
      },
    },
    select: { identityHash: true, rewardEligibleFrom: true, unlinkedAt: true },
  });
  if (!state || state.unlinkedAt || state.identityHash !== hash) return null;
  return { userDiscordId: link.userDiscordId, rewardEligibleFrom: state.rewardEligibleFrom };
}

/** Event-Rewards zaehlen ausschliesslich ab dem aktuellen Link-Cutoff. */
export async function resolveRewardUserAt(
  scope: LinkRewardScope,
  gameId: string,
  occurredAt: Date | null,
  secret: string,
): Promise<string | null> {
  if (!occurredAt) return null;
  const identity = await resolveRewardIdentity(scope, gameId, secret);
  if (!identity || occurredAt < identity.rewardEligibleFrom) return null;
  return identity.userDiscordId;
}

/**
 * Startguthaben wird genau einmal pro Guild+Gameserver+Discord-Account bewertet.
 * Die Berechtigung wird beim ersten modernen Link verbraucht — auch wenn
 * Economy oder Betrag zu diesem Zeitpunkt deaktiviert/0 sind. So gibt es keine
 * spaetere Retroaktivitaet durch Unlink/Relink oder eine Config-Aenderung.
 *
 * Ein abgeschlossener Leave-Cleanup-Receipt ist eine dauerhafte Anti-Churn-
 * Schranke: Nach einem bewusst vollstaendigen Spielerreset darf ein Rejoin zwar
 * eine neue Reward-Epoche beginnen, aber niemals erneut Startkapital erzeugen.
 *
 * Ein noch OFFENER Leave-Cleanup blockiert die Auszahlung ohne die Eligibility
 * zu veraendern. Der laufende Reset bleibt alleiniger Besitzer des alten States.
 *
 * Zusaetzlich wird der Altbestand des frueheren Discord-Join-Systems erkannt:
 * existiert bereits eine positive STARTBALANCE_JOIN-Transaktion, wird sie als
 * historischer Claim uebernommen und niemals ein zweites Startguthaben gebucht.
 */
export async function grantStartBalanceForLink(
  scope: LinkRewardScope,
  userDiscordId: string,
  now: Date = new Date(),
): Promise<LinkStartBalanceResult> {
  if (await hasOpenLeaveCleanupRequest(scope.guildId, userDiscordId)) {
    return { granted: false, amount: 0n };
  }

  const cleanupReceipt = await hasCompletedLeaveCleanupReceipt(
    scope.guildId,
    userDiscordId,
    config.security.encryptionKey,
  );
  if (cleanupReceipt) {
    await prisma.economyLinkRewardState.updateMany({
      where: {
        guildId: scope.guildId,
        nitradoConnId: scope.nitradoConnId,
        userDiscordId,
        unlinkedAt: null,
        startBalanceEligible: true,
        startBalanceGrantedAt: null,
      },
      data: { startBalanceEligible: false },
    });
    return { granted: false, amount: 0n };
  }

  const [settings, economyConfig] = await Promise.all([
    prisma.serverSettings.findUnique({
      where: {
        guildId_nitradoConnId: {
          guildId: scope.guildId,
          nitradoConnId: scope.nitradoConnId,
        },
      },
      select: { economyActive: true },
    }),
    prisma.economyConfig.findUnique({
      where: {
        guildServer: {
          guildId: scope.guildId,
          nitradoConnId: scope.nitradoConnId,
        },
      },
      select: { startBalance: true },
    }),
  ]);

  const amount = BigInt(economyConfig?.startBalance ?? 0);
  const shouldPay = settings?.economyActive === true && amount > 0n;

  try {
    const granted = await prisma.$transaction(async tx => {
      const legacyGrant = await tx.economyTransaction.findFirst({
        where: {
          guildId: scope.guildId,
          nitradoConnId: scope.nitradoConnId,
          userDiscordId,
          type: 'STARTBALANCE_JOIN',
          delta: { gt: 0n },
        },
        select: { createdAt: true, delta: true },
        orderBy: { createdAt: 'asc' },
      });

      if (legacyGrant) {
        await tx.economyLinkRewardState.updateMany({
          where: {
            guildId: scope.guildId,
            nitradoConnId: scope.nitradoConnId,
            userDiscordId,
            unlinkedAt: null,
            startBalanceEligible: true,
            startBalanceGrantedAt: null,
          },
          data: {
            startBalanceEligible: false,
            startBalanceGrantedAt: legacyGrant.createdAt,
            startBalanceGrantedAmount: legacyGrant.delta,
          },
        });
        return false;
      }

      const claim = await tx.economyLinkRewardState.updateMany({
        where: {
          guildId: scope.guildId,
          nitradoConnId: scope.nitradoConnId,
          userDiscordId,
          unlinkedAt: null,
          startBalanceEligible: true,
          startBalanceGrantedAt: null,
        },
        data: {
          startBalanceEligible: false,
          ...(shouldPay ? {
            startBalanceGrantedAt: now,
            startBalanceGrantedAmount: amount,
          } : {}),
        },
      });
      if (claim.count !== 1 || !shouldPay) return false;

      const subjectKey = economySubjectKey(scope.guildId, userDiscordId, config.security.encryptionKey);
      const key = `startbalance:link:${scope.guildId}:${scope.nitradoConnId}:${subjectKey}`;
      await tx.economyLedgerEntry.create({
        data: {
          idempotencyKey: key,
          guildId: scope.guildId,
          nitradoConnId: scope.nitradoConnId,
          userDiscordId,
          walletDelta: amount,
          bankDelta: 0n,
          type: 'STARTBALANCE_JOIN',
          reason: 'Startguthaben bei Account-Verknuepfung',
          buckets: 0,
          sourceRef: subjectKey,
        },
      });
      await tx.economyAccount.upsert({
        where: {
          guildServerUser: {
            guildId: scope.guildId,
            nitradoConnId: scope.nitradoConnId,
            userDiscordId,
          },
        },
        create: {
          guildId: scope.guildId,
          nitradoConnId: scope.nitradoConnId,
          userDiscordId,
          walletBalance: amount,
          bankBalance: 0n,
          lifetimeEarned: amount,
          lifetimeSpent: 0n,
        },
        update: {
          walletBalance: { increment: amount },
          lifetimeEarned: { increment: amount },
        },
      });
      await tx.economyTransaction.create({
        data: {
          guildId: scope.guildId,
          nitradoConnId: scope.nitradoConnId,
          userDiscordId,
          delta: amount,
          type: 'STARTBALANCE_JOIN',
          reason: 'Startguthaben bei Account-Verknuepfung',
          actorDiscordId: null,
          counterpartDiscordId: null,
        },
      });
      return true;
    });
    return { granted, amount: granted ? amount : 0n };
  } catch (error) {
    if (isUniqueViolation(error)) return { granted: false, amount: 0n };
    throw error;
  }
}

/**
 * Aktivierung + einmalige Startguthaben-Auswertung als gemeinsamer Link-Hook.
 * Auch bei einem idempotenten Retry wird grantStartBalanceForLink aufgerufen:
 * nur eine noch offene moderne Eligibility kann dann greifen; migrierte Alt-
 * Links besitzen diese Eligibility absichtlich nicht.
 */
export async function applySuccessfulLinkEconomyEffects(args: {
  scope: LinkRewardScope;
  userDiscordId: string;
  gameId: string;
  secret: string;
  newLink: boolean;
  now?: Date;
}): Promise<LinkStartBalanceResult> {
  const now = args.now ?? new Date();
  await assertNoOpenLeaveCleanupRequest(args.scope.guildId, args.userDiscordId);
  await activateLinkRewardState(args.scope, args.userDiscordId, args.gameId, args.secret, args.newLink, now);
  return grantStartBalanceForLink(args.scope, args.userDiscordId, now);
}
