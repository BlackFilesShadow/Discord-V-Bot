/**
 * Token-Validation-Cron — taeglich pro NitradoConnection.
 *
 * - Iteriert ACTIVE + EXPIRED Connections (EXPIRED kann sich nach Tokenwechsel
 *   bzw. externer Korrektur wieder erholen).
 * - Ausschliesslich INVALID setzt Status EXPIRED.
 * - Transiente/technische Fehler werden persistent diagnostiziert, ohne den
 *   Connection-Status zu veraendern.
 * - Nach drei Fehlern in Folge wird genau eine Owner-Warnung pro Streak
 *   beansprucht; eine erfolgreiche Validierung resetten den Streak.
 *
 * Scheduler-Lifecycle: Initial-Timeout und Intervall sind explizit stoppbar
 * und via unref() kein Grund, einen ansonsten beendeten Prozess festzuhalten.
 */

import type { Client } from 'discord.js';
import prisma from '../../database/prisma';
import { logger, logAudit } from '../../utils/logger';
import { config } from '../../config';
import { decrypt } from '../../utils/security';
import { NitradoClient, type TokenValidationResult } from './nitradoClient';
import { setStatus, markValidated } from './repository';
import { recordValidationFailure, sanitizeValidationError } from './validationHealth';
import { asGuildId, asNitradoConnId } from '../../types/scope';

const VALIDATION_INTERVAL_MS = 24 * 60 * 60 * 1000; // taeglich
const INITIAL_VALIDATION_DELAY_MS = 5 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;
let initialTimer: NodeJS.Timeout | null = null;
let running = false;

export interface TokenValidationConnection {
  id: string;
  guildId: string;
  alias: string;
  alias5: string;
  status: string;
  encryptedToken: string;
}

function dashboardUrl(guildId: string): string {
  const dashboardBase = config.dashboard.url ?? `http://localhost:${config.dashboard.port}`;
  return `${dashboardBase.replace(/\/$/, '')}/servers/${guildId}`;
}

async function notifyOwnerExpired(discord: Client, conn: TokenValidationConnection): Promise<void> {
  try {
    const guild = discord.guilds.cache.get(conn.guildId);
    if (!guild) return;
    const owner = await guild.fetchOwner();
    await owner.send(
      `Dein Nitrado-Token fuer **${guild.name}** (Slot \`${conn.alias5}\` — ${conn.alias}) ist **abgelaufen**.\n` +
      `Bitte im Dashboard neu verbinden: ${dashboardUrl(conn.guildId)}`,
    ).catch(() => undefined);
  } catch {
    // Owner-DM ist best-effort; Diagnose bleibt persistent in der DB.
  }
}

async function notifyOwnerRepeatedFailure(
  discord: Client,
  conn: TokenValidationConnection,
  failureCount: number,
): Promise<void> {
  try {
    const guild = discord.guilds.cache.get(conn.guildId);
    if (!guild) return;
    const owner = await guild.fetchOwner();
    await owner.send(
      `Die Nitrado-Verbindung fuer **${guild.name}** (Slot \`${conn.alias5}\` — ${conn.alias}) ` +
      `konnte **${failureCount} Mal in Folge** nicht zuverlaessig validiert werden.\n` +
      `Der Token wurde deshalb **nicht automatisch als abgelaufen markiert**. ` +
      `Bitte pruefe die Verbindung im Dashboard: ${dashboardUrl(conn.guildId)}`,
    ).catch(() => undefined);
  } catch {
    // Best-effort; lastAlertAt dokumentiert den Alert-Versuch und verhindert DM-Flut.
  }
}

async function persistFailure(
  discord: Client,
  conn: TokenValidationConnection,
  reason: unknown,
  allowRepeatedAlert: boolean,
): Promise<void> {
  const guildId = asGuildId(conn.guildId);
  const connId = asNitradoConnId(conn.id);
  const safeMessage = sanitizeValidationError(reason);

  try {
    const health = await recordValidationFailure(guildId, connId, safeMessage);
    // Bestehendes Connection-Feld weiterhin als schnellen Diagnose-Snapshot
    // spiegeln; die Streak-/Alert-Wahrheit liegt in NitradoValidationHealth.
    await prisma.nitradoConnection.updateMany({
      where: { id: conn.id, guildId: conn.guildId },
      data: { lastErrorMessage: health.safeMessage },
    });

    if (allowRepeatedAlert && health.shouldAlert) {
      logAudit('NITRADO_TOKEN_VALIDATION_ALERT', 'NITRADO', {
        guildId: conn.guildId,
        nitradoConnId: conn.id,
        alias: conn.alias,
        failureCount: health.failureCount,
      });
      await notifyOwnerRepeatedFailure(discord, conn, health.failureCount);
    }
  } catch (error) {
    // Diagnose darf die eigentliche Statusentscheidung nie kaputtmachen.
    logger.warn(`Token-Diagnose fuer ${conn.id} konnte nicht persistiert werden: ${sanitizeValidationError(error)}`);
  }
}

function resultDiagnostic(result: Exclude<TokenValidationResult, { kind: 'VALID' }>): string {
  switch (result.kind) {
    case 'INVALID':
      return `INVALID status=${result.status ?? 'unknown'}`;
    case 'RATE_LIMITED':
      return 'RATE_LIMITED';
    case 'CIRCUIT_OPEN':
      return 'CIRCUIT_OPEN';
    case 'TRANSIENT_FAILURE':
      return `TRANSIENT_FAILURE status=${result.status ?? 'unknown'} message=${result.message}`;
  }
}

/** Einzelpruefung ist exportiert, damit Failure-/Recovery-Semantik ohne Timer
 *  deterministisch regressionsgetestet werden kann. */
export async function validateConnectionTokenOnce(
  discord: Client,
  conn: TokenValidationConnection,
): Promise<void> {
  let token: string;
  try {
    token = decrypt(conn.encryptedToken, config.security.encryptionKey);
  } catch (error) {
    const safe = sanitizeValidationError(error);
    logger.warn(`NitradoToken-Decrypt fehlgeschlagen fuer ${conn.id}: ${safe}`);
    await persistFailure(discord, conn, `DECRYPT_FAILED: ${safe}`, true);
    return;
  }

  const client = new NitradoClient(token);
  let result: TokenValidationResult;
  try {
    result = await client.validateTokenDetailed();
  } catch (error) {
    const safe = sanitizeValidationError(error);
    logger.warn(`Token-Validation fuer ${conn.id} warf einen technischen Fehler: ${safe}`);
    await persistFailure(discord, conn, `VALIDATION_EXCEPTION: ${safe}`, true);
    return;
  }

  if (result.kind === 'VALID') {
    // Auto-Recovery: ACTIVE + Validierungszeitpunkt + Diagnose-Streak reset.
    await markValidated(asGuildId(conn.guildId), asNitradoConnId(conn.id));
    if (conn.status !== 'ACTIVE') {
      logAudit('NITRADO_TOKEN_REACTIVATED', 'NITRADO', {
        guildId: conn.guildId,
        nitradoConnId: conn.id,
        alias: conn.alias,
      });
    }
    return;
  }

  if (result.kind !== 'INVALID') {
    const diagnostic = resultDiagnostic(result);
    logger.warn(`Token-Validation fuer ${conn.id} transient (${diagnostic}) — Status bleibt unveraendert.`);
    await persistFailure(discord, conn, diagnostic, true);
    return;
  }

  // INVALID wird ebenfalls diagnostiziert, besitzt aber bereits seinen eigenen
  // sofortigen Owner-Hinweis. Deshalb kein zusaetzlicher "3 Fehler"-Alert.
  await persistFailure(discord, conn, resultDiagnostic(result), false);

  // Bereits EXPIRED -> keine erneute spezifische DM-Flut.
  if (conn.status !== 'ACTIVE') return;

  await setStatus(asGuildId(conn.guildId), asNitradoConnId(conn.id), 'EXPIRED');
  logAudit('NITRADO_TOKEN_EXPIRED', 'NITRADO', {
    guildId: conn.guildId,
    nitradoConnId: conn.id,
    alias: conn.alias,
  });
  await notifyOwnerExpired(discord, conn);
}

async function pollOnce(discord: Client): Promise<void> {
  if (running) return;
  running = true;
  try {
    // eslint-disable-next-line local/no-unscoped-prisma-query -- Cron iteriert alle Guilds; Scope-Operationen sind in validateConnectionTokenOnce pro Guild gebunden.
    const conns = await prisma.nitradoConnection.findMany({
      where: { status: { in: ['ACTIVE', 'EXPIRED'] } },
      select: { id: true, guildId: true, alias: true, alias5: true, status: true, encryptedToken: true },
    });
    for (const c of conns) {
      try {
        await validateConnectionTokenOnce(discord, c);
      } catch (error) {
        // Letzte Isolation: auch ein unerwarteter Fehler einer Connection darf
        // den Rest des taeglichen Laufs nicht verhindern.
        const safe = sanitizeValidationError(error);
        logger.warn(`Token-Validation fuer ${c.id} fehlgeschlagen: ${safe}`);
        await persistFailure(discord, c, `UNEXPECTED_VALIDATION_ERROR: ${safe}`, true);
      }
    }
    if (conns.length > 0) {
      logger.info(`Token-Validation: ${conns.length} Connection(s) geprueft`);
    }
  } catch (error) {
    logger.error('Token-Validation-Cron-Fehler:', error as Error);
  } finally {
    running = false;
  }
}

export function startTokenValidationCron(discord: Client): void {
  if (timer || initialTimer) return;
  logger.info(`Token-Validation-Cron gestartet (Intervall ${VALIDATION_INTERVAL_MS / 3_600_000}h)`);

  initialTimer = setTimeout(() => {
    initialTimer = null;
    void pollOnce(discord);
  }, INITIAL_VALIDATION_DELAY_MS);
  initialTimer.unref?.();

  timer = setInterval(() => { void pollOnce(discord); }, VALIDATION_INTERVAL_MS);
  timer.unref?.();
}

export function stopTokenValidationCron(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
