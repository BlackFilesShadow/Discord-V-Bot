import prisma from '../../database/prisma';
import { config } from '../../config';
import { economySubjectKey } from '../economy/subjectKey';
import {
  assertNoOpenLeaveCleanupRequest,
  hasOpenLeaveCleanupRequest,
  LeaveCleanupPendingError,
} from '../moderation/leaveCleanupGuard';
import {
  hasCompletedLeaveCleanupReceipt,
  leaveCleanupJobKey,
  leaveCleanupReceiptFingerprint,
} from '../moderation/leaveCleanupSaga';
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

interface LeaveFenceTx {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  dataDeletionRequest: {
    findFirst(args: unknown): Promise<{ id: string; completedAt?: Date | null } | null>;
  };
  gameIdentityLink: {
    findFirst(args: unknown): Promise<{ verifiedAt: Date | null } | null>;
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';
}

async function lockLeaveSubject(tx: LeaveFenceTx, guildId: string, userDiscordId: string): Promise<string> {
  const key = leaveCleanupJobKey(guildId, userDiscordId);
  await tx.$queryRawUnsafe(
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    key,
  );
  return key;
}

async function hasOpenLeaveCleanupInTx(tx: LeaveFenceTx, leaveKey: string): Promise<boolean> {
  const row = await tx.dataDeletionRequest.findFirst({
    where: {
      userId: leaveKey,
      requestType: 'PARTIAL_DELETION',
      status: { in: ['PENDING', 'IN_PROGRESS', 'FAILED'] },
    },
    select: { id: true },
  });
  return row !== null;
}

async function hasCompletedLeaveReceiptInTx(
  tx: LeaveFenceTx,
  guildId: string,
  userDiscordId: string,
): Promise<boolean> {
  const fingerprint = leaveCleanupReceiptFingerprint(
    guildId,
    userDiscordId,
    config.security.encryptionKey,
  );
  const row = await tx.dataDeletionRequest.findFirst({
    where: {
      userId: fingerprint,
      discordId: fingerprint,
      requestType: 'PARTIAL_DELETION',
      status: 'COMPLETED',
    },
    select: { id: true },
  });
  return row !== null;
}

/**
 * Verifiziert unter derselben Leave-Fence, dass die Reward-Aktivierung noch zu
 * einer echten, NACH dem letzten vollendeten Leave-Reset verifizierten Link-
 * Generation gehoert. Das schliesst den engen Race-Fall:
 *
 * Link-Commit gewinnt zuerst -> Leave wird direkt danach komplett abgearbeitet
 * und loescht den Link -> ein spaeter fortgesetzter Reward-Hook darf danach
 * keinen frischen EconomyLinkRewardState mehr auferstehen lassen.
 *
 * Ein legitimer Rejoin nach einem frueheren COMPLETE bleibt erlaubt, weil sein
 * neuer GameIdentityLink.verifiedAt strikt spaeter als completedAt liegt.
 */
async function assertFreshVerifiedLinkInTx(
  tx: LeaveFenceTx,
  scope: LinkRewardScope,
  userDiscordId: string,
  identityHashValue: string,
  secret: string,
): Promise<void> {
  const link = await tx.gameIdentityLink.findFirst({
    where: {
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
      userDiscordId,
      identityHash: identityHashValue,
      status: 'VERIFIED',
    },
    select: { verifiedAt: true },
  });
  if (!link?.verifiedAt) throw new LeaveCleanupPendingError();

  const fingerprint = leaveCleanupReceiptFingerprint(scope.guildId, userDiscordId, secret);
  const receipt = await tx.dataDeletionRequest.findFirst({
    where: {
      userId: fingerprint,
      discordId: fingerprint,
      requestType: 'PARTIAL_DELETION',
      status: 'COMPLETED',
    },
    select: { id: true, completedAt: true },
    orderBy: { completedAt: 'desc' },
  });
  if (receipt && (!receipt.completedAt || link.verifiedAt <= receipt.completedAt)) {
    throw new LeaveCleanupPendingError();
  }
}

/**
 * Aktiviert die Reward-Epoche fuer eine verifizierte DayZ-Identitaet.
 *
 * Der Composite-Upsert macht den Link-Hook auch bei parallelen Retries
 * race-safe. `newLink=true` startet fuer einen bereits bekannten Nutzer eine
 * neue Reward-Epoche; die einmalige Startguthaben-Berechtigung wird dabei
 * bewusst NICHT erneut aktiviert.
 *
 * Leave-1I: Der finale Open-Leave-Check, die Link-Generationspruefung und der
 * Upsert liegen unter exakt demselben transaction-scoped Advisory-Key wie das
 * Leave-Enqueue. Dadurch kann weder ein gerade beginnender noch ein unmittelbar
 * vor dem Reward-Hook vollendeter Cleanup frischen State hinterlassen.
 */
export async function activateLinkRewardState(
  scope: LinkRewardScope,
  userDiscordId: string,
  gameId: string,
  secret: string,
  newLink: boolean,
  now: Date = new Date(),
): Promise<Date> {
  // Schneller Fail-Closed-Guard fuer den Normalfall; die transaktionale
  // Revalidierung darunter ist die eigentliche Race-Grenze.
  await assertNoOpenLeaveCleanupRequest(scope.guildId, userDiscordId);
  const hash = identityHash(gameId, secret);

  return prisma.$transaction(async tx => {
    const fenceTx = tx as unknown as LeaveFenceTx;
    const leaveKey = await lockLeaveSubject(fenceTx, scope.guildId, userDiscordId);
    if (await hasOpenLeaveCleanupInTx(fenceTx, leaveKey)) {
      throw new LeaveCleanupPendingError();
    }
    await assertFreshVerifiedLinkInTx(fenceTx, scope, userDiscordId, hash, secret);

    const row = await tx.economyLinkRewardState.upsert({
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
  });
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
 * Leave-1I: Direkt vor Legacy-Claim/Eligibility/Ledger wird unter demselben
 * Leave-Advisory-Key erneut auf offenen Cleanup UND Completed-Receipt geprueft.
 * Gewinnt die Buchung den Lock zuerst, muss ein spaeteres Leave-Enqueue warten
 * und der anschliessende Cleanup entfernt die Buchung. Gewinnt Leave zuerst,
 * sieht die Buchung den offenen Job und mutiert nichts. Ein bereits vollendeter
 * Cleanup wird ueber den pseudonymen Receipt ebenfalls fail-closed erkannt.
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
  // Fast paths sparen im Normalfall die schwere Transaktion. Beide Bedingungen
  // werden unter dem Advisory-Lock unten zwingend erneut validiert.
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
      const fenceTx = tx as unknown as LeaveFenceTx;
      const leaveKey = await lockLeaveSubject(fenceTx, scope.guildId, userDiscordId);
      if (await hasOpenLeaveCleanupInTx(fenceTx, leaveKey)) return false;

      // Der Fast-Path oberhalb kann zeitlich vor dem Worker-Completion liegen.
      // Deshalb den pseudonymen Receipt nach Lock-Gewinn zwingend erneut lesen.
      if (await hasCompletedLeaveReceiptInTx(fenceTx, scope.guildId, userDiscordId)) {
        await tx.economyLinkRewardState.updateMany({
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
        return false;
      }

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
