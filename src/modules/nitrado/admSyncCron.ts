/**
 * ADM-Sync-Cron — alle 15 min.
 *
 * Pro `NitradoConnection(status=ACTIVE, nitradoServerId!=null)`:
 *   1. Liste ADM-Files im konfigurierten Profile-Verzeichnis
 *      (`process.env.NITRADO_ADM_DIR`, sonst Skip).
 *   2. Verarbeite nur Dateien mit `modified_at > cursor`. Der Cursor wird
 *      persistent in `NitradoAdmCursor` (pro guildId+nitradoConnId) gehalten,
 *      sodass nach einem Bot-Restart KEINE Spielzeit-Rewards verloren gehen.
 *   3. Download → `parseAdm` → `aggregateMinutesByPlayer`.
 *   4. Pro (steam64, minutes): wenn `EconomyLink(guildId, nitradoConnId, gameId)`
 *      existiert und Economy `enabled` ist → Reward
 *      `floor(minutes * playtimeRewardPercent / 100)` Coins atomar in Wallet
 *      gutschreiben + `EconomyTransaction(type=PLAYTIME_REWARD)` + Link.lastSeenAt.
 *
 * Erststart (kein Cursor vorhanden): Cursor wird auf "jetzt" verankert und KEIN
 * historischer Backlog verarbeitet. Folgelaeufe lesen/schreiben den DB-Cursor.
 *
 * Fehlerverhalten: Der Cursor wird nur bis zur letzten VOLLSTAENDIG erfolgreich
 * verarbeiteten Datei gesetzt. Schlaegt der Download einer Datei fehl, wird die
 * Verarbeitung dort abgebrochen — es wird nicht ueber die fehlerhafte Datei
 * hinausgesprungen (sie wird im naechsten Lauf erneut versucht).
 */

import prisma from '../../database/prisma';
import { logger, logAudit } from '../../utils/logger';
import { config } from '../../config';
import { decrypt } from '../../utils/security';
import { NitradoClient } from './nitradoClient';
import { parseAdm, aggregateMinutesByPlayer } from './admParser';
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

  // EconomyConfig laden (1x pro Guild)
  const cfg = await prisma.economyConfig.findUnique({ where: { guildId: conn.guildId } });
  if (!cfg || !cfg.enabled || cfg.playtimeRewardPercent <= 0) {
    // Economy aus: Dateien gelten als "gesehen", Cursor vorruecken (wie bisher).
    const last = fresh[fresh.length - 1];
    try {
      await saveCursor(conn.guildId, conn.id, last.modified_at, last.name);
    } catch (e) {
      logger.warn(`ADM-Sync: Cursor-Save (Economy aus) fehlgeschlagen fuer ${conn.id}: ${(e as Error).message}`);
    }
    return;
  }
  const pct = cfg.playtimeRewardPercent;

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
    const sessions = parseAdm(content, file.name);
    const perPlayer = aggregateMinutesByPlayer(sessions);

    for (const [steam64, minutes] of perPlayer) {
      if (minutes <= 0) continue;
      const link = await prisma.economyLink.findUnique({
        where: {
          guildId_nitradoConnId_gameId: { guildId: conn.guildId, nitradoConnId: conn.id, gameId: steam64 },
        },
      });
      if (!link) continue;
      const reward = BigInt(Math.floor((minutes * pct) / 100));
      if (reward <= 0n) continue;

      try {
        await prisma.$transaction(async tx => {
          await tx.economyAccount.upsert({
            where: { guildId_userDiscordId: { guildId: conn.guildId, userDiscordId: link.userDiscordId } },
            create: {
              guildId: conn.guildId,
              userDiscordId: link.userDiscordId,
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
              userDiscordId: link.userDiscordId,
              delta: reward,
              type: 'PLAYTIME_REWARD',
              reason: `ADM ${file.name}: ${minutes}min × ${pct}%`,
              actorDiscordId: null,
            },
          });
          // eslint-disable-next-line local/no-unscoped-prisma-query -- link.id stammt aus vorheriger guildId-gescopter findUnique-Query (siehe oben).
          await tx.economyLink.update({
            where: { id: link.id },
            data: { lastSeenAt: new Date() },
          });
        });
        totalRewardedPlayers++;
        emitGuildEvent(conn.guildId, {
          type: 'economy.tx',
          payload: { guildId: conn.guildId, userDiscordId: link.userDiscordId, type: 'PLAYTIME_REWARD' },
        });
      } catch (e) {
        logger.warn(`ADM-Sync: Reward fehlgeschlagen fuer ${conn.id}/${steam64}: ${(e as Error).message}`);
      }
    }
    // Datei vollstaendig verarbeitet → als erfolgreichen Cursor-Stand merken.
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
}

export function stopAdmSyncCron(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
