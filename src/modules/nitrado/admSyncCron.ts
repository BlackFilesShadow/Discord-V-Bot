/**
 * ADM-Sync-Cron — alle 15 min.
 *
 * Pro `NitradoConnection(status=ACTIVE, nitradoServerId!=null)`:
 *   1. Liste ADM-Files im konfigurierten Profile-Verzeichnis
 *      (`process.env.NITRADO_ADM_DIR`, sonst Skip).
 *   2. Verarbeite nur Dateien mit `modified_at > cursor`. Der Cursor wird
 *      persistent in `NitradoAdmCursor` (pro guildId+nitradoConnId) gehalten,
 *      sodass nach einem Bot-Restart KEINE Spielzeit-Rewards verloren gehen.
 *   3. Download → Link-Challenges verifizieren → ADM-Pipeline/Rewards.
 *
 * Erststart (kein Cursor vorhanden): Cursor wird auf "jetzt" verankert und KEIN
 * historischer Backlog verarbeitet. Folgelaeufe lesen/schreiben den DB-Cursor.
 *
 * Fehlerverhalten: Der Cursor wird nur bis zur letzten VOLLSTAENDIG erfolgreich
 * verarbeiteten Datei gesetzt. Schlaegt Download, Ingest oder Link-Verifikation
 * fehl, wird nicht ueber die Datei hinausgesprungen. Der idempotente Ingest darf
 * sie im naechsten Lauf sicher erneut sehen.
 */

import prisma from '../../database/prisma';
import { logger, logAudit } from '../../utils/logger';
import { config } from '../../config';
import { decrypt } from '../../utils/security';
import { NitradoClient } from './nitradoClient';
import { parseAdm, aggregateMinutesByPlayer } from './admParser';
import { ingestAdmFile } from './adm/admIngestService';
import { runPvpRewardShadow, type RewardEngineClient } from './adm/rewardEngine';
import { aggregatePlayerSessions, type PlayerSessionClient } from './adm/playerSessionService';
import { getRewardRule, effectiveBaseAmount, type RewardRuleClient } from '../economy/rewardRules';
import { getSlotEconomyConfig, admRewardsActive, type SlotConfigClient } from '../economy/slotConfig';
import { bookPendingRewards, type RewardBookingClient } from '../economy/rewardBooking';
import { bookPlaytimeRewards, type PlaytimeBookingClient } from '../economy/playtimeBooking';
import { resolveVerifiedUser, type ResolveClient, type LinkClient } from '../linking/linkService';
import { verifyLinkChallengesInAdmText } from '../linking/admChallengeVerifier';
import { emitGuildEvent } from '../../dashboard/socket/emitter';

const SYNC_INTERVAL_MS = 15 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;
let running = false;

interface ConnRow {
  id: string;
  guildId: string;
  alias: string;
  encryptedToken: string;
  nitradoServerId: string | null;
}

/** Persistenten Cursor pro Connection schreiben (upsert). */
async function saveCursor(guildId: string, nitradoConnId: string, lastModifiedAt: number, lastFileName: string | null): Promise<void> {
  await prisma.nitradoAdmCursor.upsert({
    where: { guildId_nitradoConnId: { guildId, nitradoConnId } },
    create: { guildId, nitradoConnId, lastModifiedAt, lastFileName },
    update: { lastModifiedAt, lastFileName },
  });
}

/**
 * LINK-002: prueft eine bereits heruntergeladene ADM-Datei auf kurzlebige
 * /link-Challenges. Wir loggen nur Anzahl/Scope, niemals Klartext-Spiel-IDs.
 * Ein technischer DB-Fehler wird absichtlich hochgereicht, damit der Cursor die
 * Datei nicht ueberspringt und der idempotente naechste Lauf erneut versucht.
 */
async function verifyLinkChallenges(conn: ConnRow, content: string): Promise<void> {
  const summary = await verifyLinkChallengesInAdmText(
    prisma as unknown as LinkClient,
    { guildId: conn.guildId, nitradoConnId: conn.id },
    content,
    config.security.encryptionKey,
  );
  if (summary.verified > 0) {
    logAudit('LINK_CHALLENGE_VERIFIED', 'LINKING', {
      guildId: conn.guildId,
      nitradoConnId: conn.id,
      verified: summary.verified,
    });
  }
}

async function processConnection(profileDir: string, conn: ConnRow): Promise<void> {
  if (!conn.nitradoServerId) return;
  let token: string;
  try {
    token = decrypt(conn.encryptedToken, config.security.encryptionKey);
  } catch (e) {
    logger.warn(`ADM-Sync: Token-Decrypt fehlgeschlagen fuer ${conn.id}: ${(e as Error).message}`);
    return;
  }
  const client = new NitradoClient(token);

  // Persistenten Cursor laden. Bei DB-Fehler abbrechen — niemals unkontrolliert
  // einen Backlog verarbeiten.
  let cursorRow;
  try {
    cursorRow = await prisma.nitradoAdmCursor.findUnique({
      where: { guildId_nitradoConnId: { guildId: conn.guildId, nitradoConnId: conn.id } },
    });
  } catch (e) {
    logger.warn(`ADM-Sync: Cursor-Load fehlgeschlagen fuer ${conn.id}: ${(e as Error).message} — Connection uebersprungen.`);
    return;
  }

  let files: Array<{ name: string; modified_at: number; size: number }>;
  try {
    files = await client.listAdmFiles(conn.nitradoServerId, profileDir);
  } catch (e) {
    logger.warn(`ADM-Sync: list fehlgeschlagen fuer ${conn.id}: ${(e as Error).message}`);
    return;
  }

  // Erststart ohne Cursor: auf "jetzt" verankern, kein historischer Backlog.
  if (!cursorRow) {
    const nowSec = Math.floor(Date.now() / 1000);
    try {
      await saveCursor(conn.guildId, conn.id, nowSec, null);
    } catch (e) {
      logger.warn(`ADM-Sync: Initial-Cursor-Anlage fehlgeschlagen fuer ${conn.id}: ${(e as Error).message}`);
    }
    return;
  }

  const lastCursor = cursorRow.lastModifiedAt;
  const fresh = files.filter(f => f.modified_at > lastCursor).sort((a, b) => a.modified_at - b.modified_at);
  if (fresh.length === 0) return;

  // Phase 3: Kanonische Pipeline. Speichert AdmEvents (idempotent) und bucht
  // KEIN Geld direkt; Rewards laufen ueber die Shadow-RewardEngine.
  if (config.nitrado.admEventPipelineV2) {
    await processConnectionV2(profileDir, conn, fresh, client, lastCursor, cursorRow.lastFileName ?? null);
    return;
  }

  // Legacy-Rewardpfad bleibt optional. Linking ist davon bewusst unabhaengig:
  // auch bei deaktivierter Economy muessen /link-Challenges verarbeitet werden.
  const cfg = await prisma.economyConfig.findUnique({ where: { guildId: conn.guildId } });
  const rewardsEnabled = !!cfg && cfg.enabled && cfg.playtimeRewardPercent > 0;
  const pct = rewardsEnabled ? cfg.playtimeRewardPercent : 0;

  // Cursor nur bis zur letzten vollstaendig verarbeiteten Datei vorruecken.
  let lastSuccessfulModifiedAt = lastCursor;
  let lastSuccessfulFileName: string | null = cursorRow.lastFileName ?? null;
  let totalRewardedPlayers = 0;
  for (const file of fresh) {
    let content: string;
    try {
      content = await client.downloadFile(conn.nitradoServerId, profileDir.replace(/\/$/, '') + '/' + file.name);
    } catch (e) {
      logger.warn(`ADM-Sync: download fehlgeschlagen fuer ${conn.id}/${file.name}: ${(e as Error).message} — Abbruch, Cursor bleibt vor dieser Datei.`);
      break;
    }

    try {
      await verifyLinkChallenges(conn, content);
    } catch (e) {
      logger.warn(`ADM-Sync: Link-Challenge-Verifikation fehlgeschlagen fuer ${conn.id}/${file.name}: ${(e as Error).message} — Abbruch, Cursor bleibt vor dieser Datei.`);
      break;
    }

    if (rewardsEnabled) {
      const sessions = parseAdm(content, file.name);
      const perPlayer = aggregateMinutesByPlayer(sessions);

      for (const [steam64, minutes] of perPlayer) {
        if (minutes <= 0) continue;
        // Aufloesung ueber verifizierte GameIdentityLink (HMAC), kein EconomyLink mehr.
        const userDiscordId = await resolveVerifiedUser(
          prisma as unknown as ResolveClient,
          { guildId: conn.guildId, nitradoConnId: conn.id },
          steam64,
          config.security.encryptionKey,
        );
        if (!userDiscordId) continue;
        const reward = BigInt(Math.floor((minutes * pct) / 100));
        if (reward <= 0n) continue;

        try {
          await prisma.$transaction(async tx => {
            await tx.economyAccount.upsert({
              where: { guildId_userDiscordId: { guildId: conn.guildId, userDiscordId } },
              create: {
                guildId: conn.guildId,
                userDiscordId,
                walletBalance: reward,
                lifetimeEarned: reward,
              },
              update: {
                walletBalance: { increment: reward },
                lifetimeEarned: { increment: reward },
              },
            });
            await tx.economyTransaction.create({
              data: {
                guildId: conn.guildId,
                userDiscordId,
                delta: reward,
                type: 'PLAYTIME_REWARD',
                reason: `ADM ${file.name}: ${minutes}min × ${pct}%`,
                actorDiscordId: null,
              },
            });
          });
          totalRewardedPlayers++;
          emitGuildEvent(conn.guildId, {
            type: 'economy.tx',
            payload: { guildId: conn.guildId, userDiscordId, type: 'PLAYTIME_REWARD' },
          });
        } catch (e) {
          logger.warn(`ADM-Sync: Reward fehlgeschlagen fuer ${conn.id}: ${(e as Error).message}`);
        }
      }
    }

    // Datei inklusive Link-Challenges vollstaendig verarbeitet.
    lastSuccessfulModifiedAt = file.modified_at;
    lastSuccessfulFileName = file.name;
  }

  // Cursor nur bis zur letzten vollstaendig verarbeiteten Datei persistieren.
  if (lastSuccessfulModifiedAt > lastCursor) {
    try {
      await saveCursor(conn.guildId, conn.id, lastSuccessfulModifiedAt, lastSuccessfulFileName);
    } catch (e) {
      logger.warn(`ADM-Sync: Cursor-Save fehlgeschlagen fuer ${conn.id}: ${(e as Error).message}`);
    }
  }
  if (totalRewardedPlayers > 0) {
    logAudit('NITRADO_ADM_SYNC', 'NITRADO', {
      guildId: conn.guildId, nitradoConnId: conn.id, files: fresh.length, rewarded: totalRewardedPlayers,
    });
  }
}

/**
 * V2-Pfad (Phase 3): laedt frische ADM-Dateien, ueberfuehrt sie in kanonische
 * AdmEvents (byte-genauer Cursor, idempotent) und laesst die Shadow-RewardEngine
 * PvP-Kills zu RewardDecisions verarbeiten. KEINE direkte Geldbuchung.
 */
async function processConnectionV2(
  profileDir: string,
  conn: ConnRow,
  fresh: Array<{ name: string; modified_at: number; size: number }>,
  client: NitradoClient,
  lastCursor: number,
  lastFileName: string | null,
): Promise<void> {
  let lastSuccessfulModifiedAt = lastCursor;
  let lastSuccessfulFileName = lastFileName;
  let totalInserted = 0;
  for (const file of fresh) {
    let content: string;
    try {
      content = await client.downloadFile(conn.nitradoServerId!, profileDir.replace(/\/$/, '') + '/' + file.name);
    } catch (e) {
      logger.warn(`ADM-Sync V2: download fehlgeschlagen fuer ${conn.id}/${file.name}: ${(e as Error).message} — Abbruch.`);
      break;
    }
    try {
      const r = await ingestAdmFile(
        { guildId: conn.guildId, nitradoConnId: conn.id },
        { fileName: file.name, modifiedAt: file.modified_at, size: file.size, content },
      );
      totalInserted += r.inserted;
      await verifyLinkChallenges(conn, content);
    } catch (e) {
      logger.warn(`ADM-Sync V2: Ingest/Link-Verifikation fehlgeschlagen fuer ${conn.id}/${file.name}: ${(e as Error).message} — Abbruch.`);
      break;
    }
    lastSuccessfulModifiedAt = file.modified_at;
    lastSuccessfulFileName = file.name;
  }

  if (lastSuccessfulModifiedAt > lastCursor) {
    try {
      await saveCursor(conn.guildId, conn.id, lastSuccessfulModifiedAt, lastSuccessfulFileName);
    } catch (e) {
      logger.warn(`ADM-Sync V2: Cursor-Save fehlgeschlagen fuer ${conn.id}: ${(e as Error).message}`);
    }
  }

  // Shadow-RewardEngine: PvP-Kills -> idempotente RewardDecisions.
  // Betrag nur wenn Slot-Master (admRewardsEnabled) UND Regel aktiv sind; sonst 0.
  // Bei aktivem Gate werden offene Decisions produktiv ueber den Ledger gebucht
  // (echtes Geld, idempotent ueber Key reward:<decisionId>).
  try {
    const scopeRef = { guildId: conn.guildId, nitradoConnId: conn.id };
    const resolveUser = (gameId: string) => resolveVerifiedUser(prisma as unknown as ResolveClient, scopeRef, gameId, config.security.encryptionKey);
    const slotCfg = await getSlotEconomyConfig(prisma as unknown as SlotConfigClient, scopeRef);
    const pvpRule = await getRewardRule(prisma as unknown as RewardRuleClient, scopeRef, 'pvp:default');
    const active = admRewardsActive(slotCfg);
    const baseAmount = active ? effectiveBaseAmount(pvpRule) : 0n;
    await runPvpRewardShadow(
      prisma as unknown as RewardEngineClient,
      scopeRef,
      { rewardRuleId: 'pvp:default', baseAmount },
      resolveUser,
    );
    if (active) {
      await bookPendingRewards(
        prisma as unknown as RewardBookingClient,
        scopeRef,
        { rewardTarget: slotCfg!.rewardTarget },
      );
    }
  } catch (e) {
    logger.warn(`ADM-Sync V2: RewardEngine-Shadow fehlgeschlagen fuer ${conn.id}: ${(e as Error).message}`);
  }

  // Sitzungs-Aggregation (kein Geld): Connect/Disconnect -> PlayerSessions +
  // 10-Min-Buckets. Idempotent ueber connectEventId. Produktive Spielzeit-
  // Belohnung nur bei aktivem Slot-Gate (echtes Geld, idempotent je Bucket-Stufe).
  try {
    const scopeRef = { guildId: conn.guildId, nitradoConnId: conn.id };
    await aggregatePlayerSessions(prisma as unknown as PlayerSessionClient, scopeRef);
    const slotCfg = await getSlotEconomyConfig(prisma as unknown as SlotConfigClient, scopeRef);
    if (admRewardsActive(slotCfg)) {
      const playtimeRule = await getRewardRule(prisma as unknown as RewardRuleClient, scopeRef, 'playtime:default');
      const resolveUser = (gameId: string) => resolveVerifiedUser(prisma as unknown as ResolveClient, scopeRef, gameId, config.security.encryptionKey);
      await bookPlaytimeRewards(
        prisma as unknown as PlaytimeBookingClient,
        scopeRef,
        { perBucketAmount: effectiveBaseAmount(playtimeRule), rewardTarget: slotCfg!.rewardTarget },
        resolveUser,
      );
    }
  } catch (e) {
    logger.warn(`ADM-Sync V2: PlayerSession-Aggregation fehlgeschlagen fuer ${conn.id}: ${(e as Error).message}`);
  }

  if (totalInserted > 0) {
    logAudit('NITRADO_ADM_INGEST_V2', 'NITRADO', {
      guildId: conn.guildId, nitradoConnId: conn.id, files: fresh.length, events: totalInserted,
    });
  }
}

async function pollOnce(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const profileDir = process.env.NITRADO_ADM_DIR;
    if (!profileDir) return; // kein Verzeichnis konfiguriert → Sync passiv

    // eslint-disable-next-line local/no-unscoped-prisma-query -- Cron iteriert alle Guilds; Scope-Schreiboperationen sind pro Connection gebunden.
    const conns = await prisma.nitradoConnection.findMany({
      where: { status: 'ACTIVE', nitradoServerId: { not: null } },
      select: { id: true, guildId: true, alias: true, encryptedToken: true, nitradoServerId: true },
    });
    for (const c of conns) {
      try {
        await processConnection(profileDir, c);
      } catch (e) {
        logger.warn(`ADM-Sync: processConnection fehlgeschlagen fuer ${c.id}: ${(e as Error).message}`);
      }
    }
  } catch (e) {
    logger.error('ADM-Sync-Cron-Fehler:', e as Error);
  } finally {
    running = false;
  }
}

export function startAdmSyncCron(): void {
  if (timer) return;
  if (!process.env.NITRADO_ADM_DIR) {
    logger.info('ADM-Sync-Cron: NITRADO_ADM_DIR nicht gesetzt — Cron laeuft passiv (no-op).');
  } else {
    logger.info(`ADM-Sync-Cron gestartet (Intervall ${SYNC_INTERVAL_MS / 60_000}min, Dir=${process.env.NITRADO_ADM_DIR})`);
    logger.info('ADM-Sync nutzt persistenten DB-Cursor (NitradoAdmCursor) — Spielzeit-Rewards gehen ueber Restarts nicht verloren.');
  }
  timer = setInterval(() => { void pollOnce(); }, SYNC_INTERVAL_MS);
  timer.unref?.();
}

export function stopAdmSyncCron(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
