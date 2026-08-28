/**
 * ADM-V2 Postprocessor.
 *
 * Datei-Download/Parsing gehoert ausschliesslich dem inkrementellen Live-Ingest.
 * Dieser Cron arbeitet nur noch auf der kanonischen AdmEvent-Source-of-Truth
 * und uebernimmt PvP-Rewards, PlayerSessions und Spielzeit-Rewards.
 */

import prisma from '../../../database/prisma';
import { config } from '../../../config';
import { logger } from '../../../utils/logger';
import { asGuildId, asNitradoConnId } from '../../../types/scope';
import { runPvpRewardShadow, type RewardEngineClient } from './rewardEngine';
import { aggregatePlayerSessions, type PlayerSessionClient } from './playerSessionService';
import { getRewardRule, effectiveBaseAmount, type RewardRuleClient } from '../../economy/rewardRules';
import { getSlotEconomyConfig, type SlotConfigClient } from '../../economy/slotConfig';
import { bookPendingRewards, type RewardBookingClient } from '../../economy/rewardBooking';
import { bookPlaytimeRewards, type PlaytimeBookingClient } from '../../economy/playtimeBooking';
import { assertEconomyScopeReady } from '../../economy/scopeMigration';
import { resolveRewardIdentity, resolveRewardUserAt, applySuccessfulLinkEconomyEffects } from '../../linking/linkRewards';
import { reconcileAdminForcedLinks } from '../../linking/adminForceLink';
import { identityHash } from '../../linking/identity';

const INTERVAL_MS = 60_000;
let timer: NodeJS.Timeout | null = null;
let running = false;

interface ScopedConnection {
  id: string;
  guildId: string;
}

async function processConnection(conn: ScopedConnection): Promise<void> {
  const scopeRef = { guildId: conn.guildId, nitradoConnId: conn.id };

  try {
    await aggregatePlayerSessions(prisma as unknown as PlayerSessionClient, scopeRef);
  } catch (error) {
    logger.warn(`ADM-Postprocess: PlayerSession-Aggregation fehlgeschlagen fuer ${conn.id}: ${(error as Error).message}`);
  }

  // Admin-Force-Links duerfen bereits vor dem ersten ADM-Treffer existieren.
  // Sobald der exakte Name auf diesem Gameserver eindeutig einer GUID zugeordnet
  // werden kann, wird die echte HMAC gebunden. Economy-Hooks sind idempotent und
  // werden auch fuer bereits gebundene Force-Links erneut sichergestellt, damit
  // ein Crash zwischen GUID-Commit und Reward-Aktivierung selbstheilend bleibt.
  try {
    const reconciled = await reconcileAdminForcedLinks({
      scope: scopeRef,
      secret: config.security.encryptionKey,
    });
    for (const link of reconciled) {
      try {
        await applySuccessfulLinkEconomyEffects({
          scope: scopeRef,
          userDiscordId: link.userDiscordId,
          gameId: link.gameId,
          secret: config.security.encryptionKey,
          newLink: link.newIdentityBinding,
        });
      } catch (error) {
        logger.warn(`ADM-Postprocess: Force-Link-Economy-Hook fehlgeschlagen fuer ${conn.id}/${link.userDiscordId}: ${(error as Error).message}`);
      }
    }
  } catch (error) {
    logger.warn(`ADM-Postprocess: Admin-Force-Link-Reconciliation fehlgeschlagen fuer ${conn.id}: ${(error as Error).message}`);
  }

  try {
    await assertEconomyScopeReady(asGuildId(conn.guildId), asNitradoConnId(conn.id));
  } catch (error) {
    logger.debug(`ADM-Postprocess: Economy fuer ${conn.guildId}/${conn.id} noch nicht scope-ready: ${(error as Error).message}`);
    return;
  }

  try {
    const [slotCfg, settings, pvpRule, playtimeRule] = await Promise.all([
      getSlotEconomyConfig(prisma as unknown as SlotConfigClient, scopeRef),
      prisma.serverSettings.findUnique({
        where: { guildId_nitradoConnId: { guildId: conn.guildId, nitradoConnId: conn.id } },
        select: { economyActive: true },
      }),
      getRewardRule(prisma as unknown as RewardRuleClient, scopeRef, 'pvp:default'),
      getRewardRule(prisma as unknown as RewardRuleClient, scopeRef, 'playtime:default'),
    ]);

    // Seit Etappe 1 ist ServerSettings.economyActive die kanonische Wahrheit.
    // EconomySlotConfig.enabled ist nur noch ein Kompatibilitaets-Mirror und
    // darf einen abweichenden Runtime-Zustand nicht eigenstaendig aktivieren.
    const active = settings?.economyActive === true && slotCfg?.admRewardsEnabled === true;
    const resolveUserAt = (gameId: string, occurredAt: Date | null) => resolveRewardUserAt(
      scopeRef,
      gameId,
      occurredAt,
      config.security.encryptionKey,
    );
    const resolvePlaytimeLink = async (gameId: string) => {
      const link = await resolveRewardIdentity(
        scopeRef,
        gameId,
        config.security.encryptionKey,
      );
      return link ? {
        ...link,
        identityHash: identityHash(gameId, config.security.encryptionKey),
      } : null;
    };

    await runPvpRewardShadow(
      prisma as unknown as RewardEngineClient,
      scopeRef,
      {
        rewardRuleId: 'pvp:default',
        baseAmount: active ? effectiveBaseAmount(pvpRule) : 0n,
      },
      resolveUserAt,
    );

    if (active && slotCfg) {
      await bookPendingRewards(
        prisma as unknown as RewardBookingClient,
        scopeRef,
        { rewardTarget: slotCfg.rewardTarget },
      );
    }

    // Immer ausfuehren: bei deaktivierter Economy/Regel werden vollstaendige
    // Zeit-Buckets nur als verarbeitet markiert. Damit koennen sie nach einer
    // spaeteren Aktivierung niemals rueckwirkend ausgezahlt werden.
    await bookPlaytimeRewards(
      prisma as unknown as PlaytimeBookingClient,
      scopeRef,
      {
        perBucketAmount: effectiveBaseAmount(playtimeRule),
        rewardTarget: slotCfg?.rewardTarget ?? 'WALLET',
        payoutEnabled: active,
      },
      resolvePlaytimeLink,
    );
  } catch (error) {
    logger.warn(`ADM-Postprocess: Reward-Verarbeitung fehlgeschlagen fuer ${conn.id}: ${(error as Error).message}`);
  }
}

export async function runAdmPostProcessOnce(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // eslint-disable-next-line local/no-unscoped-prisma-query -- globaler Scheduler-Sweep; jede Folgeoperation ist Guild+Connection scoped.
    const connections = await prisma.nitradoConnection.findMany({
      where: { status: 'ACTIVE', nitradoServerId: { not: null } },
      select: { id: true, guildId: true },
    });
    for (const connection of connections) await processConnection(connection);
  } catch (error) {
    logger.error('ADM-V2-Postprocess Fehler:', error as Error);
  } finally {
    running = false;
  }
}

export function startAdmPostProcessCron(): void {
  if (timer) return;
  logger.info(`ADM-V2-Postprocess gestartet (Intervall ${INTERVAL_MS / 1000}s).`);
  timer = setInterval(() => { void runAdmPostProcessOnce(); }, INTERVAL_MS);
  timer.unref?.();
  void runAdmPostProcessOnce();
}

export function stopAdmPostProcessCron(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
