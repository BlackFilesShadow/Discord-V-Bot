/**
 * Killfeed-Watcher — pollt alle 60s pro aktive `KillfeedConfig`.
 *
 * Pro Tick:
 *   1. Alle aktiven Configs laden (gruppiert pro Connection).
 *   2. Pro Connection: ADM-Files listen, neueste Datei waehlen.
 *   3. Wenn modified_at neuer als `lastPolledAt` ODER lastFileName != current
 *      → Datei downloaden, ab `lastByteOffset` parsen, neue Events ableiten.
 *   4. Pro Config (Channel-Filter): Embed posten, KillfeedEvent persistieren,
 *      Socket-Event broadcasten.
 *   5. Cursor (lastFileName, lastByteOffset, lastPolledAt) updaten.
 *
 * Token wird aus `NitradoConnection.encryptedToken` decrypted; Pfad aus
 * `process.env.NITRADO_ADM_DIR`.
 *
 * Strikte Guild-Trennung: jede Persistierung enthaelt guildId + nitradoConnId.
 * Cross-Guild-Posting ist konstruktiv unmoeglich.
 */

import type { Client, GuildTextBasedChannel } from 'discord.js';
import prisma from '../../database/prisma';
import { logger, logAuditDb } from '../../utils/logger';
import { config } from '../../config';
import { decrypt } from '../../utils/security';
import { NitradoClient } from '../nitrado/nitradoClient';
import { parseKills, type KillEvent, type KillCategory } from './admKillParser';
import { buildKillfeedEmbed } from './embedBuilder';
import { emitGuildEvent } from '../../dashboard/socket/emitter';
import { tryGetDashboardClient } from '../../dashboard/clientRegistry';

const POLL_INTERVAL_MS = 60_000;

let timer: NodeJS.Timeout | null = null;
let running = false;

interface ConfigRow {
  id: string;
  guildId: string;
  nitradoConnId: string;
  channelId: string;
  isActive: boolean;
  categories: KillCategory[];
  showShooterCoords: boolean;
  showVictimCoords: boolean;
  showWeapon: boolean;
  showDistance: boolean;
  embedColor: string;
  lastEventAt: Date | null;
  lastEtag: string | null;
  lastFileName: string | null;
  lastByteOffset: bigint;
  conn: {
    id: string;
    nitradoServerId: string | null;
    encryptedToken: string;
  };
}

async function processConnection(
  connId: string,
  configs: ConfigRow[],
  profileDir: string,
  client: Client,
): Promise<void> {
  const first = configs[0];
  if (!first.conn.nitradoServerId) return;

  let token: string;
  try {
    token = decrypt(first.conn.encryptedToken, config.security.encryptionKey);
  } catch (e) {
    logger.warn(`Killfeed: Token-Decrypt fehlgeschlagen fuer ${connId}: ${(e as Error).message}`);
    return;
  }
  const nClient = new NitradoClient(token);

  let files: Array<{ name: string; modified_at: number; size: number }>;
  try {
    files = await nClient.listAdmFiles(first.conn.nitradoServerId, profileDir);
  } catch (e) {
    logger.warn(`Killfeed: list fehlgeschlagen fuer ${connId}: ${(e as Error).message}`);
    return;
  }
  if (files.length === 0) return;
  // Aktuellste Datei (live-Log)
  const newest = files.sort((a, b) => b.modified_at - a.modified_at)[0];

  // Gemeinsame State-Aggregation: pro Connection nur EINMAL downloaden.
  // Cursor wird aus dem hoechsten Offset/jungsten lastFileName aller Configs
  // dieser Connection gewaehlt (alle Configs an derselben Connection
  // teilen sich den gleichen Live-File-Stream).
  let cursorOffset = 0n;
  let cursorFile: string | null = null;
  for (const c of configs) {
    if (c.lastFileName === newest.name && c.lastByteOffset > cursorOffset) {
      cursorOffset = c.lastByteOffset;
      cursorFile = c.lastFileName;
    }
  }
  // Datei-Wechsel -> komplett neu lesen
  if (cursorFile !== newest.name) cursorOffset = 0n;

  let content: string;
  try {
    content = await nClient.downloadFile(
      first.conn.nitradoServerId,
      profileDir.replace(/\/$/, '') + '/' + newest.name,
    );
  } catch (e) {
    logger.warn(`Killfeed: download fehlgeschlagen fuer ${connId}/${newest.name}: ${(e as Error).message}`);
    return;
  }

  const totalBytes = BigInt(Buffer.byteLength(content, 'utf8'));
  if (totalBytes <= cursorOffset && cursorFile === newest.name) {
    // Nichts Neues — pro Config einzeln aktualisieren (guildId-Scope erzwungen)
    for (const c of configs) {
      await prisma.killfeedConfig.update({
        where: { id: c.id, guildId: c.guildId },
        data: { lastPolledAt: new Date() },
      });
    }
    return;
  }

  const { events } = parseKills(content, {
    startOffset: Number(cursorOffset),
    fileNameForFallbackDate: newest.name,
  });

  // Pro Config: Filter + Post + Persist
  for (const cfg of configs) {
    const filtered = events.filter(e => cfg.categories.includes(e.category));
    if (filtered.length === 0) {
      await prisma.killfeedConfig.update({
        where: { id: cfg.id, guildId: cfg.guildId },
        data: {
          lastFileName: newest.name,
          lastByteOffset: totalBytes,
          lastPolledAt: new Date(),
          lastErrorMsg: null,
        },
      });
      continue;
    }
    await postEventsForConfig(client, cfg, filtered);
    await prisma.killfeedConfig.update({
      where: { id: cfg.id, guildId: cfg.guildId },
      data: {
        lastFileName: newest.name,
        lastByteOffset: totalBytes,
        lastPolledAt: new Date(),
        lastEventAt: filtered[filtered.length - 1].occurredAt,
        lastErrorMsg: null,
      },
    });
  }
}

async function postEventsForConfig(
  client: Client,
  cfg: ConfigRow,
  events: KillEvent[],
): Promise<void> {
  // Channel auflösen (mit Guild-Verifikation)
  const channel = await client.channels.fetch(cfg.channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || channel.isDMBased()) {
    await prisma.killfeedConfig.update({
      where: { id: cfg.id, guildId: cfg.guildId },
      data: { lastErrorMsg: 'Channel nicht verfuegbar/Text-Channel.' },
    });
    return;
  }
  const tch = channel as GuildTextBasedChannel;
  if (tch.guildId !== cfg.guildId) {
    await prisma.killfeedConfig.update({
      where: { id: cfg.id, guildId: cfg.guildId },
      data: { lastErrorMsg: 'Channel gehoert nicht zur Guild.' },
    });
    logAuditDb('KILLFEED_CHANNEL_MISMATCH', 'KILLFEED', {
      actorUserId: 'system', guildId: cfg.guildId,
      details: { configId: cfg.id, channelId: cfg.channelId, foundGuild: tch.guildId },
    });
    return;
  }

  for (const ev of events) {
    // Persist (Idempotenz via composite-unique sinngemaess: guildId+conn+occurredAt+victim+rawLine)
    const created = await prisma.killfeedEvent.create({
      data: {
        guildId: cfg.guildId,
        nitradoConnId: cfg.nitradoConnId,
        category: ev.category,
        occurredAt: ev.occurredAt,
        shooterName: ev.shooterName ?? null,
        shooterPos: ev.shooterPos ?? null,
        victimName: ev.victimName,
        victimPos: ev.victimPos ?? null,
        weapon: ev.weapon ?? null,
        distance: ev.distance ?? null,
        rawLine: ev.rawLine.slice(0, 4000),
      },
    }).catch(e => {
      logger.warn(`Killfeed: persist fehlgeschlagen fuer ${cfg.id}: ${(e as Error).message}`);
      return null;
    });
    if (!created) continue;

    try {
      const embed = buildKillfeedEmbed(ev, {
        showShooterCoords: cfg.showShooterCoords,
        showVictimCoords: cfg.showVictimCoords,
        showWeapon: cfg.showWeapon,
        showDistance: cfg.showDistance,
        embedColor: cfg.embedColor,
      });
      await tch.send({ embeds: [embed] });
      await prisma.killfeedEvent.updateMany({
        where: { id: created.id, guildId: cfg.guildId },
        data: { postedAt: new Date() },
      });
      emitGuildEvent(cfg.guildId, {
        type: 'killfeed.event',
        payload: {
          guildId: cfg.guildId,
          configId: cfg.id,
          category: ev.category,
          victimName: ev.victimName,
          shooterName: ev.shooterName,
          weapon: ev.weapon,
          distance: ev.distance,
          occurredAt: ev.occurredAt.toISOString(),
        },
      });
    } catch (e) {
      logger.warn(`Killfeed: post fehlgeschlagen fuer ${cfg.id}: ${(e as Error).message}`);
    }
  }
}

async function pollOnce(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const profileDir = process.env.NITRADO_ADM_DIR;
    if (!profileDir) return;

    const client = tryGetDashboardClient();
    if (!client) return; // ohne Discord-Client koennen wir nicht posten

    // Aktive Configs incl. ihrer Connection laden
    // eslint-disable-next-line local/no-unscoped-prisma-query -- Killfeed-Cron iteriert alle Guilds; jede Mutation darunter ist guildId-gescopt.
    const rows = await prisma.killfeedConfig.findMany({
      where: { isActive: true, categories: { isEmpty: false } },
      include: {
        nitradoConn: {
          select: { id: true, nitradoServerId: true, encryptedToken: true, status: true },
        },
      },
    });
    const usable = rows.filter(r => r.nitradoConn.status === 'ACTIVE' && r.nitradoConn.nitradoServerId);
    // Group by connId
    const byConn = new Map<string, ConfigRow[]>();
    for (const r of usable) {
      const row: ConfigRow = {
        id: r.id,
        guildId: r.guildId,
        nitradoConnId: r.nitradoConnId,
        channelId: r.channelId,
        isActive: r.isActive,
        categories: r.categories as KillCategory[],
        showShooterCoords: r.showShooterCoords,
        showVictimCoords: r.showVictimCoords,
        showWeapon: r.showWeapon,
        showDistance: r.showDistance,
        embedColor: r.embedColor,
        lastEventAt: r.lastEventAt,
        lastEtag: r.lastEtag,
        lastFileName: r.lastFileName,
        lastByteOffset: r.lastByteOffset,
        conn: {
          id: r.nitradoConn.id,
          nitradoServerId: r.nitradoConn.nitradoServerId,
          encryptedToken: r.nitradoConn.encryptedToken,
        },
      };
      const list = byConn.get(r.nitradoConnId) ?? [];
      list.push(row);
      byConn.set(r.nitradoConnId, list);
    }
    for (const [connId, configs] of byConn) {
      try {
        await processConnection(connId, configs, profileDir, client);
      } catch (e) {
        logger.warn(`Killfeed: processConnection fehlgeschlagen fuer ${connId}: ${(e as Error).message}`);
      }
    }
  } catch (e) {
    logger.error('Killfeed-Watcher-Fehler:', e as Error);
  } finally {
    running = false;
  }
}

export function startKillfeedWatcher(): void {
  if (timer) return;
  if (!process.env.NITRADO_ADM_DIR) {
    logger.info('Killfeed-Watcher: NITRADO_ADM_DIR nicht gesetzt — Watcher passiv.');
  } else {
    logger.info(`Killfeed-Watcher gestartet (Intervall ${POLL_INTERVAL_MS / 1000}s)`);
  }
  timer = setInterval(() => { void pollOnce(); }, POLL_INTERVAL_MS);
}

export function stopKillfeedWatcher(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

// Test-only helper — fuer Unit-Tests des Embed-Posting-Pfads.
export const __test__ = { pollOnce };
