import prisma from '../../database/prisma';
import { logger } from '../../utils/logger';
import { identityHash } from './identity';
import { applySuccessfulLinkEconomyEffects, type LinkRewardScope } from './linkRewards';

interface VerifiedLinkProjection {
  userDiscordId: string;
  identityHash: string | null;
  verifiedAt: Date | null;
}

interface RewardStateProjection {
  userDiscordId: string;
  identityHash: string;
  unlinkedAt: Date | null;
  startBalanceEligible: boolean;
}

export function linkNeedsEconomyRepair(
  link: VerifiedLinkProjection,
  state: RewardStateProjection | undefined,
): boolean {
  if (!link.identityHash) return false;
  if (!state) return true;
  if (state.unlinkedAt) return true;
  if (state.identityHash !== link.identityHash) return true;
  return state.startBalanceEligible;
}

/**
 * Selbstheilung fuer den kleinen Crash-/DB-Fehler-Zeitraum zwischen einem
 * erfolgreichen GameIdentityLink-Commit und dem nachfolgenden Economy-Hook.
 *
 * Es werden ausschliesslich VERIFIED Links mit echter GUID-HMAC betrachtet und
 * nur fehlende, veraltete oder noch nicht fertig ausgewertete Economy-States
 * nachgezogen. Der GUID-Klartext bleibt weiterhin unpersistiert: er wird aus
 * den kanonischen PlayerSessions aufgeloest und nur im Speicher verwendet.
 *
 * `newLink` wird nur bei einem bereits existierenden, aber veralteten/unlinked
 * Reward-State gesetzt. Damit wird bei einer echten Relink-Generation der
 * Reward-Cutoff korrekt neu gesetzt, waehrend ein reiner Retry keinen Cutoff
 * verschiebt. Alle eigentlichen Mutationen laufen weiterhin durch den
 * Leave-Fence- und Startguthaben-sicheren kanonischen Link-Economy-Hook.
 */
export async function reconcileVerifiedLinkEconomyEffects(
  scope: LinkRewardScope,
  secret: string,
): Promise<{ repaired: number; unresolved: number; failed: number }> {
  const [links, states] = await Promise.all([
    prisma.gameIdentityLink.findMany({
      where: {
        guildId: scope.guildId,
        nitradoConnId: scope.nitradoConnId,
        status: 'VERIFIED',
        identityHash: { not: null },
      },
      select: { userDiscordId: true, identityHash: true, verifiedAt: true },
    }),
    prisma.economyLinkRewardState.findMany({
      where: { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId },
      select: {
        userDiscordId: true,
        identityHash: true,
        unlinkedAt: true,
        startBalanceEligible: true,
      },
    }),
  ]);

  const stateByUser = new Map(states.map(state => [state.userDiscordId, state]));
  const pending = links.filter(link => linkNeedsEconomyRepair(link, stateByUser.get(link.userDiscordId)));
  if (pending.length === 0) return { repaired: 0, unresolved: 0, failed: 0 };

  // Nur wenn wirklich Reparaturbedarf besteht, werden die bekannten GUIDs des
  // Servers geladen. DISTINCT verhindert, dass lange Session-Historien dieselbe
  // GUID tausendfach in den Speicher ziehen. Es gibt bewusst kein kuenstliches
  // Limit: ein seltener Reparaturfall darf nicht dauerhaft hinter einem alten
  // 500/1000er Fenster unsichtbar bleiben.
  const sessions = await prisma.playerSession.findMany({
    where: { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId },
    select: { gameId: true },
    distinct: ['gameId'],
  });
  const gameIdByHash = new Map<string, string>();
  for (const session of sessions) {
    gameIdByHash.set(identityHash(session.gameId, secret), session.gameId);
  }

  const repairStartedAt = new Date();
  let repaired = 0;
  let unresolved = 0;
  let failed = 0;
  for (const link of pending) {
    if (!link.identityHash) continue;
    const gameId = gameIdByHash.get(link.identityHash);
    if (!gameId) {
      unresolved++;
      continue;
    }

    const state = stateByUser.get(link.userDiscordId);
    const newLink = Boolean(state && (state.unlinkedAt || state.identityHash !== link.identityHash));
    try {
      await applySuccessfulLinkEconomyEffects({
        scope,
        userDiscordId: link.userDiscordId,
        gameId,
        secret,
        newLink,
        now: link.verifiedAt ?? repairStartedAt,
      });
      repaired++;
    } catch (error) {
      failed++;
      logger.warn(
        `Link-Economy-Reconcile fehlgeschlagen fuer ${scope.nitradoConnId}/${link.userDiscordId}: ${(error as Error).message}`,
      );
    }
  }

  return { repaired, unresolved, failed };
}
