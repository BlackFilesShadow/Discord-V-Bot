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
import { forEachBounded } from '../../../utils/boundedConcurrency';
import { asGuildId, asNitradoConnId } from '../../../types/scope';
import { runPvpRewardShadow, type RewardEngineClient } from './rewardEngine';
import { aggregatePlayerSessions, type PlayerSessionClient } from './playerSessionService';
import { runAdmParserBackfill, type AdmParserBackfillClient } from './admParserBackfill';
import { getRewardRule, effectiveBaseAmount, type RewardRuleClient } from '../../economy/rewardRules';
import { getSlotEconomyConfig, type SlotConfigClient } from '../../economy/slotConfig';
import { bookPendingRewards, type RewardBookingClient } from '../../economy/rewardBooking';
import { bookPlaytimeRewards, type PlaytimeBookingClient } from '../../economy/playtimeBooking';
import { assertEconomyScopeReady } from '../../economy/scopeMigration';
import { resolveRewardIdentity, resolveRewardUserAt, applySuccessfulLinkEconomyEffects } from '../../linking/linkRewards';
import { reconcileAdminForcedLinks } from '../../linking/adminForceLink';
import { reconcileVerifiedLinkEconomyEffects } from '../../linking/linkEconomyReconcile';
import { identityHash } from '../../linking/identity';

const INTERVAL_MS = 60_000;
const CONNECTION_SWEEP_CONCURRENCY = 3;
let timer: NodeJS.Timeout | null = null;
let running = false;

interface ScopedConnection {
  id: string;
  guildId: string;
}

async function processConnection(conn: ScopedConnection): Promise<void> {
  const scopeRef = { guildId: conn.guildId, nitradoConnId: conn.id };

  // Parser-Upgrades werden ausschliesslich auf der bereits persistierten
  // AdmEvent-Historie nachgezogen. Der Backfill fasst keinen Remote-Dateicursor
  // an und behaelt eventKey/createdAt bei, sodass bereits passierte Feed-, Radar-
  // und Reward-High-Watermarks niemals kuenstlich zurueckgesetzt werden.
  try {
    const backfill = await runAdmParserBackfill(
      prisma as unknown as AdmParserBackfillClient,
      scopeRef,
    );
    if (backfill.reparsed > 0 || backfill.flagRowsCreated > 0) {
      logger.info(
        `ADM-Postprocess: Parser-Backfill ${conn.id}: reparsed=${backfill.reparsed}, flags=${backfill.flagRowsCreated}, complete=${backfill.complete}`,
      );
    }
  } catch (error) {
    logger.warn(`ADM-Postprocess: Parser-Backfill fehlgeschlagen fuer ${conn.id}: ${(error as Error).message}`);
  }

  try {
    await aggregatePlayerSessions(prisma as unknown as PlayerSessionClient, scopeRef);
  } catch (error) {
    logger.warn(`ADM-Postprocess: PlayerSession-Aggregation fehlgeschlagen fuer ${conn.id}: ${(error as Error).message}`);
  }

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
    const repair = await reconcileVerifiedLinkEconomyEffects(
      scopeRef,
      config.security.encryptionKey,
    );
    if (repair.repaired > 0 || repair.failed > 0 || repair.unresolved > 0) {
      logger.info(
        `ADM-Postprocess: Link-Economy-Reconcile ${conn.id}: repaired=${repair.repaired}, unresolved=${repair.unresolved}, failed=${repair.failed}`,
      );
    }
  } catch (error) {
    logger.warn(`ADM-Postprocess: Link-Economy-Reconciliation fehlgeschlagen fuer ${conn.id}: ${(error as Error).message}`);
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

    // ServerSettings.economyActive remains the canonical economy switch.
    // admRewardsEnabled deliberately gates all automated ADM-originated money.
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
        {
          // Per-rule target is authoritative. Slot target remains compatibility
          // fallback for older configurations without an explicit rule.
          rewardTarget: pvpRule?.rewardTarget ?? slotCfg.rewardTarget,
          dailyCap: pvpRule?.dailyCap ?? null,
          cooldownSeconds: pvpRule?.cooldownSeconds ?? 0,
          timezone: slotCfg.timezone,
        },
      );
    }

    // Always run playtime progress. When payout is disabled, completed buckets
    // are consumed without money so later activation cannot back-pay history.
    await bookPlaytimeRewards(
      prisma as unknown as PlaytimeBookingClient,
      scopeRef,
      {
        perBucketAmount: effectiveBaseAmount(playtimeRule),
        rewardTarget: playtimeRule?.rewardTarget ?? slotCfg?.rewardTarget ?? 'WALLET',
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
    await forEachBounded(connections, CONNECTION_SWEEP_CONCURRENCY, processConnection);
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
