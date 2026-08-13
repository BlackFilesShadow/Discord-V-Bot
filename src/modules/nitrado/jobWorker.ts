/**
 * NitradoJob-Worker — Outbox-Pattern fuer Nitrado-API-Calls.
 *
 * Polling alle JOB_POLL_INTERVAL_MS. Pickt PENDING/RUNNING-Jobs deren
 * `nextRunAt <= now`. Jeder Job laeuft mit:
 *   - Status PENDING -> RUNNING
 *   - Dispatch je `operation`
 *   - Bei Erfolg -> DONE
 *   - Bei Fehler:
 *       attempts++ ; if attempts >= maxAttempts -> DEAD
 *       sonst -> PENDING + nextRunAt = now + 30s * 2^attempts (Backoff bis ~1h)
 *
 * Operationen:
 *   - WHITELIST_ADD     payload: { gameId }
 *   - WHITELIST_REMOVE  payload: { gameId }
 *   - KEEPALIVE         payload: {}            -> validateToken()
 *   - DOWNLOAD_ADM      payload: { profileDir? } -> wird vom ADM-Sync genutzt
 *
 * Single-instance: KEINE row-locks im Schema, dafuer atomar via
 * `updateMany({ where: { id, status: 'PENDING' }, data: { status: 'RUNNING' } })`
 * und Pruefung des `count`. Bei Multi-Instance reicht das nicht — dann
 * Postgres-Advisory-Lock einbauen (nicht im MVP).
 */

import prisma from '../../database/prisma';
import { logger, logAudit } from '../../utils/logger';
import { config } from '../../config';
import { decrypt } from '../../utils/security';
import { NitradoClient, NitradoApiError } from './nitradoClient';
import { emitGuildEvent } from '../../dashboard/socket/emitter';

const JOB_POLL_INTERVAL_MS = 10_000;
const MAX_PARALLEL = 4;
const BACKOFF_BASE_SECONDS = 30;
const STALE_RUNNING_MS = 5 * 60 * 1000; // RUNNING-Jobs ohne Update >5min werden recovered

// NIT-008: Retention. DONE kurz, DEAD laenger (Diagnose). Sweep max 1x/Stunde.
const DONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEAD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const RETENTION_INTERVAL_MS = 60 * 60 * 1000;
let lastRetentionAt = 0;

// NIT-007: bekannte Operationen. Alles andere -> sofort permanent DEAD.
const KNOWN_OPERATIONS = new Set(['WHITELIST_ADD', 'WHITELIST_REMOVE', 'KEEPALIVE', 'DOWNLOAD_ADM', 'RESTART_IF_DOWN']);

let timer: NodeJS.Timeout | null = null;
let running = false;

interface JobPayload {
  gameId?: string;
  profileDir?: string;
  [key: string]: unknown;
}

export async function executeJob(jobId: string): Promise<void> {
  // Hole Job + zugehoerige Connection getrennt — `NitradoJob` hat im Schema
  // keine deklarierte Prisma-Relation zu `NitradoConnection` (nur die FK-Spalte
  // `nitradoConnId`), daher ist `include: { nitradoConn }` zur Laufzeit ungueltig.
  // eslint-disable-next-line local/no-unscoped-prisma-query -- Worker hat Job-ID aus eigenem PENDING->RUNNING-Claim, Scope ist im executeJob-Body durch Job.guildId gebunden.
  const job = await prisma.nitradoJob.findUnique({ where: { id: jobId } });
  if (!job) return;

  let conn: { id: string; guildId: string; encryptedToken: string; nitradoServerId: string | null; status: string } | null = null;
  try {
    conn = await prisma.nitradoConnection.findFirst({
      where: { id: job.nitradoConnId, guildId: job.guildId },
      select: { id: true, guildId: true, encryptedToken: true, nitradoServerId: true, status: true },
    });
  } catch (e) {
    await failJob(job.id, job.guildId, job.attempts, job.maxAttempts, `Connection-Lookup fehlgeschlagen: ${(e as Error).message}`, true);
    return;
  }

  if (!conn || conn.status !== 'ACTIVE') {
    await failJob(job.id, job.guildId, job.attempts, job.maxAttempts, 'Connection inaktiv oder geloescht', /*permanent*/ true);
    return;
  }

  const payload = (job.payload as JobPayload | null) ?? {};

  // NIT-007: Unbekannte Operationen sind permanent ungueltig -> sofort DEAD,
  // statt sie sinnlos maxAttempts-mal zu wiederholen.
  if (!KNOWN_OPERATIONS.has(job.operation)) {
    await failJob(job.id, job.guildId, job.attempts, job.maxAttempts, `Unbekannte Operation: ${job.operation}`, true);
    return;
  }

  // NIT-005: Token-Entschluesselung + Client-Konstruktion lagen frueher
  // AUSSERHALB des Fehlerblocks -> ein korrupter Token liess den Job dauerhaft
  // auf RUNNING haengen (nur alle 5min via Stale-Recovery, endlos). Jetzt
  // deterministisch permanent DEAD.
  let client: NitradoClient;
  try {
    const token = decrypt(conn.encryptedToken, config.security.encryptionKey);
    client = new NitradoClient(token);
  } catch (e) {
    await failJob(job.id, job.guildId, job.attempts, job.maxAttempts, `Token-Entschluesselung fehlgeschlagen: ${(e as Error).message}`, true);
    return;
  }

  try {
    switch (job.operation) {
      case 'WHITELIST_ADD': {
        if (!conn.nitradoServerId) throw new Error('Kein nitradoServerId fuer WHITELIST_ADD');
        if (typeof payload.gameId !== 'string') throw new Error('payload.gameId fehlt');
        await client.addToWhitelist(conn.nitradoServerId, payload.gameId);
        break;
      }
      case 'WHITELIST_REMOVE': {
        if (!conn.nitradoServerId) throw new Error('Kein nitradoServerId fuer WHITELIST_REMOVE');
        if (typeof payload.gameId !== 'string') throw new Error('payload.gameId fehlt');
        await client.removeFromWhitelist(conn.nitradoServerId, payload.gameId);
        break;
      }
      case 'KEEPALIVE': {
        const ok = await client.validateToken();
        if (!ok) throw new Error('Token ungueltig');
        break;
      }
      case 'DOWNLOAD_ADM': {
        // Echte ADM-Verarbeitung laeuft im ADM-Sync-Cron. Hier nur Token-Check.
        const ok = await client.validateToken();
        if (!ok) throw new Error('Token ungueltig');
        break;
      }
      case 'RESTART_IF_DOWN': {
        if (!conn.nitradoServerId) throw new Error('Kein nitradoServerId fuer RESTART_IF_DOWN');
        const status = await client.getServiceStatus(conn.nitradoServerId);
        // KEEP-004: Nur einen explizit gestoppten Service starten. `suspended`
        // ist ein administrativer Zustand und darf niemals automatisch umgangen werden.
        if (status === 'stopped') {
          await client.start(conn.nitradoServerId);
          logAudit('NITRADO_AUTO_START', 'NITRADO', { guildId: job.guildId, jobId: job.id, details: { nitradoConnId: conn.id, statusBefore: status } });
        } else {
          logger.debug(`PermaOnly skip: server ${conn.nitradoServerId} status=${status}`);
        }
        break;
      }
      default:
        throw new Error(`Unbekannte Operation: ${job.operation}`);
    }

    await prisma.nitradoJob.updateMany({
      where: { id: job.id, guildId: job.guildId },
      data: { status: 'DONE', lastError: null, updatedAt: new Date() },
    });
    logAudit('NITRADO_JOB_DONE', 'NITRADO', { guildId: job.guildId, jobId: job.id, operation: job.operation });
    emitGuildEvent(job.guildId, { type: 'nitrado.job.updated', payload: { guildId: job.guildId, jobId: job.id, status: 'DONE' } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const httpStatus = e instanceof NitradoApiError ? e.status : null;
    // 4xx ausser 429 = permanent
    const permanent = httpStatus !== null && httpStatus >= 400 && httpStatus < 500 && httpStatus !== 429;
    await failJob(job.id, job.guildId, job.attempts, job.maxAttempts, msg, permanent);
  }
}

async function failJob(
  id: string, guildId: string, attempts: number, maxAttempts: number, errorMsg: string, permanent: boolean,
): Promise<void> {
  const nextAttempts = attempts + 1;
  const dead = permanent || nextAttempts >= maxAttempts;
  if (dead) {
    await prisma.nitradoJob.updateMany({
      where: { id, guildId },
      data: { status: 'DEAD', attempts: nextAttempts, lastError: errorMsg.slice(0, 1000), updatedAt: new Date() },
    });
    logAudit('NITRADO_JOB_DEAD', 'NITRADO', { guildId, jobId: id, attempts: nextAttempts, error: errorMsg });
    emitGuildEvent(guildId, { type: 'nitrado.job.updated', payload: { guildId, jobId: id, status: 'DEAD' } });
  } else {
    const backoffSec = BACKOFF_BASE_SECONDS * Math.pow(2, nextAttempts - 1);
    const nextRunAt = new Date(Date.now() + backoffSec * 1000);
    await prisma.nitradoJob.updateMany({
      where: { id, guildId },
      data: { status: 'PENDING', attempts: nextAttempts, lastError: errorMsg.slice(0, 1000), nextRunAt, updatedAt: new Date() },
    });
    logger.warn(`NitradoJob ${id} fehlgeschlagen (${nextAttempts}/${maxAttempts}), retry in ${backoffSec}s: ${errorMsg}`);
    emitGuildEvent(guildId, { type: 'nitrado.job.updated', payload: { guildId, jobId: id, status: 'PENDING' } });
  }
}

async function pollOnce(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // Recovery: RUNNING-Jobs, die laenger als STALE_RUNNING_MS keine
    // updatedAt-Aenderung mehr hatten, sind nach Crash/Deploy verwaist
    // und werden wieder auf PENDING zurueckgesetzt.
    const staleCutoff = new Date(Date.now() - STALE_RUNNING_MS);
    // eslint-disable-next-line local/no-unscoped-prisma-query -- Recovery-Sweep ueber alle Guilds; betrifft nur eigene Job-Outbox.
    const stale = await prisma.nitradoJob.updateMany({
      where: { status: 'RUNNING', updatedAt: { lt: staleCutoff } },
      data: { status: 'PENDING', updatedAt: new Date() },
    });
    if (stale.count > 0) {
      logger.warn(`NitradoJob-Worker: ${stale.count} verwaiste RUNNING-Jobs auf PENDING zurueckgesetzt`);
    }

    // NIT-008: Retention-Sweep (hoechstens 1x/Stunde). Alte abgeschlossene Jobs
    // entfernen; DEAD laenger halten fuer Diagnose.
    if (Date.now() - lastRetentionAt > RETENTION_INTERVAL_MS) {
      lastRetentionAt = Date.now();
      const [doneDel, deadDel] = await Promise.all([
        // eslint-disable-next-line local/no-unscoped-prisma-query -- Retention-Sweep ueber alle Guilds; loescht nur eigene, abgeschlossene Outbox-Jobs.
        prisma.nitradoJob.deleteMany({ where: { status: 'DONE', updatedAt: { lt: new Date(Date.now() - DONE_RETENTION_MS) } } }),
        // eslint-disable-next-line local/no-unscoped-prisma-query -- Retention-Sweep ueber alle Guilds; loescht nur eigene, DEAD-Outbox-Jobs.
        prisma.nitradoJob.deleteMany({ where: { status: 'DEAD', updatedAt: { lt: new Date(Date.now() - DEAD_RETENTION_MS) } } }),
      ]);
      if (doneDel.count + deadDel.count > 0) {
        logger.info(`NitradoJob-Retention: ${doneDel.count} DONE + ${deadDel.count} DEAD entfernt.`);
      }
    }

    // Atomar: PENDING -> RUNNING fuer max MAX_PARALLEL Jobs deren nextRunAt erreicht ist.
    // WICHTIG: Pro nitradoConnId NUR ein Job parallel — Whitelist-Settings sind
    // Read-Modify-Write auf einem geteilten String und MUESSEN serialisiert werden,
    // sonst ueberschreiben sich konkurrente Updates gegenseitig (Datenverlust).
    // eslint-disable-next-line local/no-unscoped-prisma-query -- Worker scannt globale Outbox; Scope-Check erfolgt im executeJob.
    const candidates = await prisma.nitradoJob.findMany({
      where: { status: 'PENDING', nextRunAt: { lte: new Date() } },
      orderBy: { nextRunAt: 'asc' },
      take: MAX_PARALLEL * 4, // genug Vorrat damit auch bei Conn-Konflikten MAX_PARALLEL erreicht wird
      select: { id: true, guildId: true, nitradoConnId: true },
    });
    if (candidates.length === 0) return;

    // Per-Conn-Serialisierung: pro nitradoConnId hoechstens 1 Job in dieser Iteration.
    // Aktuell laufende RUNNING-Jobs zaehlen ebenfalls als "Conn belegt".
    // eslint-disable-next-line local/no-unscoped-prisma-query -- nur RUNNING-Connection-IDs ermitteln
    const runningConns = await prisma.nitradoJob.findMany({
      where: { status: 'RUNNING' },
      select: { nitradoConnId: true },
    });
    const busyConns = new Set(runningConns.map(r => r.nitradoConnId));
    const filtered: typeof candidates = [];
    for (const c of candidates) {
      if (filtered.length >= MAX_PARALLEL) break;
      if (busyConns.has(c.nitradoConnId)) continue;
      busyConns.add(c.nitradoConnId);
      filtered.push(c);
    }
    if (filtered.length === 0) return;

    const claimed: Array<{ id: string; guildId: string }> = [];
    for (const c of filtered) {
      const upd = await prisma.nitradoJob.updateMany({
        where: { id: c.id, guildId: c.guildId, status: 'PENDING' },
        data: { status: 'RUNNING', updatedAt: new Date() },
      });
      if (upd.count === 1) claimed.push({ id: c.id, guildId: c.guildId });
    }
    if (claimed.length === 0) return;

    await Promise.allSettled(claimed.map(c => executeJob(c.id)));
  } catch (e) {
    logger.error('NitradoJob-Worker pollOnce-Fehler:', e as Error);
  } finally {
    running = false;
  }
}

export function startNitradoJobWorker(): void {
  if (timer) return;
  logger.info(`NitradoJob-Worker gestartet (Intervall ${JOB_POLL_INTERVAL_MS}ms, Parallel ${MAX_PARALLEL})`);
  timer = setInterval(() => { void pollOnce(); }, JOB_POLL_INTERVAL_MS);
  // F-013/NIT-010: Der Poll-Timer darf einen ansonsten beendeten Prozess
  // nicht kuenstlich am Leben halten; Shutdown wird ueber den expliziten Stop-Hook gesteuert.
  timer.unref?.();
}

export function stopNitradoJobWorker(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

/**
 * NIT-010: Geordneter Shutdown — stoppt neue Polls und wartet, bis ein evtl.
 * laufender Poll (in-flight Jobs) fertig ist, bevor Prisma getrennt wird.
 */
export async function drainAndStopJobWorker(timeoutMs = 10_000): Promise<void> {
  stopNitradoJobWorker();
  const start = Date.now();
  while (running && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (running) {
    logger.warn('NitradoJob-Worker: Drain-Timeout — laufender Poll wurde nicht rechtzeitig fertig.');
  }
}