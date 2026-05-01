/**
 * Token-Validation-Cron — taeglich pro NitradoConnection.
 *
 * - Iteriert alle Connections mit `status=ACTIVE`.
 * - Ruft `validateToken()` ueber den Nitrado-Client.
 * - Bei false: setzt Status `EXPIRED` + sendet Owner-DM mit Re-Connect-Hinweis.
 *
 * Single-instance: simpler `running`-Flag (gleiches Verfahren wie jobWorker).
 */

import type { Client } from 'discord.js';
import prisma from '../../database/prisma';
import { logger, logAudit } from '../../utils/logger';
import { config } from '../../config';
import { decrypt } from '../../utils/security';
import { NitradoClient } from './nitradoClient';
import { setStatus } from './repository';
import { asGuildId, asNitradoConnId } from '../../types/scope';

const VALIDATION_INTERVAL_MS = 24 * 60 * 60 * 1000; // taeglich

let timer: NodeJS.Timeout | null = null;
let running = false;

async function checkOne(
  discord: Client,
  conn: { id: string; guildId: string; alias: string; alias5: string; encryptedToken: string },
): Promise<void> {
  let token: string;
  try {
    token = decrypt(conn.encryptedToken, config.security.encryptionKey);
  } catch (e) {
    logger.warn(`NitradoToken-Decrypt fehlgeschlagen fuer ${conn.id}: ${(e as Error).message}`);
    return;
  }

  const client = new NitradoClient(token);
  const ok = await client.validateToken();
  if (ok) return;

  await setStatus(asGuildId(conn.guildId), asNitradoConnId(conn.id), 'EXPIRED');
  logAudit('NITRADO_TOKEN_EXPIRED', 'NITRADO', { guildId: conn.guildId, nitradoConnId: conn.id, alias: conn.alias });

  // Owner-DM
  try {
    const guild = discord.guilds.cache.get(conn.guildId);
    if (!guild) return;
    const owner = await guild.fetchOwner();
    const dashboardBase = config.dashboard.url ?? `http://localhost:${config.dashboard.port}`;
    const url = `${dashboardBase.replace(/\/$/, '')}/servers/${conn.guildId}`;
    await owner.send(
      `Dein Nitrado-Token fuer **${guild.name}** (Slot \`${conn.alias5}\` — ${conn.alias}) ist **abgelaufen**.\n` +
      `Bitte im Dashboard neu verbinden: ${url}`,
    ).catch(() => undefined);
  } catch {
    // silent
  }
}

async function pollOnce(discord: Client): Promise<void> {
  if (running) return;
  running = true;
  try {
    // eslint-disable-next-line local/no-unscoped-prisma-query -- Cron iteriert alle Guilds; Scope-Operationen sind in checkOne pro Guild gebunden.
    const conns = await prisma.nitradoConnection.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, guildId: true, alias: true, alias5: true, encryptedToken: true },
    });
    for (const c of conns) {
      try {
        await checkOne(discord, c);
      } catch (e) {
        logger.warn(`Token-Validation fuer ${c.id} fehlgeschlagen: ${(e as Error).message}`);
      }
    }
    if (conns.length > 0) {
      logger.info(`Token-Validation: ${conns.length} Connection(s) geprueft`);
    }
  } catch (e) {
    logger.error('Token-Validation-Cron-Fehler:', e as Error);
  } finally {
    running = false;
  }
}

export function startTokenValidationCron(discord: Client): void {
  if (timer) return;
  logger.info(`Token-Validation-Cron gestartet (Intervall ${VALIDATION_INTERVAL_MS / 3_600_000}h)`);
  // Erst-Lauf nach 5 min (damit Bot-Start nicht blockiert wird).
  setTimeout(() => { void pollOnce(discord); }, 5 * 60 * 1000);
  timer = setInterval(() => { void pollOnce(discord); }, VALIDATION_INTERVAL_MS);
}

export function stopTokenValidationCron(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
