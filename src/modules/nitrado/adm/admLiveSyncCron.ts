/**
 * Kanonischer Live-ADM-Ingest fuer alle aktiven Nitrado-Gameserver.
 *
 * Nitrados file_server/seek liest nur neue Bytes nach AdmSourceCursor. Dieser
 * Pfad ist damit die einzige Datei-Quelle fuer Death/Baufeed, Linking, Rewards
 * und PlayerSessions. Alte Voll-Downloads und NITRADO_ADM_DIR sind nicht mehr
 * Teil der Runtime.
 */

import crypto from 'crypto';
import prisma from '../../../database/prisma';
import { config } from '../../../config';
import { decrypt } from '../../../utils/security';
import { logger, logAudit } from '../../../utils/logger';
import { NitradoClient } from '../nitradoClient';
import { recordAdmSourceError, resolveAdmProfile } from './profileResolver';
import {
  ingestChunk,
  persistAdmEvents,
  type AdmPersistClient,
  type AdmSourceMeta,
} from './serverLogIngestor';
import { newDateContext, resolveBaseDate, type AdmDateContext } from './admLineParser';
import { verifyLinkChallengesInAdmText } from '../../linking/admChallengeVerifier';
import type { LinkClient } from '../../linking/linkService';
import {
  admBindingFileIdentity,
  admBindingFileIdentityPrefix,
} from './bindingState';
import {
  isAdmBindingFenceError,
  readCurrentAdmBinding,
  withFreshAdmBinding,
  type AdmBindingSnapshot,
} from './bindingFence';

const POLL_INTERVAL_MS = 30_000;
const RANGE_BYTES = 512 * 1024;
const BASELINE_TAIL_BYTES = 64 * 1024;
const MAX_FILES_PER_TICK = 8;

let timer: NodeJS.Timeout | null = null;
let running = false;

type LiveConn = AdmBindingSnapshot;

interface AdmFile {
  name: string;
  modified_at: number;
  size: number;
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .slice(0, 1000);
}

function fingerprint(content: string): string | null {
  if (!content) return null;
  return crypto.createHash('sha256').update(content.slice(0, 4096)).digest('hex');
}

function completeLines(content: string): string {
  const lf = content.lastIndexOf('\n');
  const cr = content.lastIndexOf('\r');
  const end = Math.max(lf, cr);
  return end >= 0 ? content.slice(0, end + 1) : '';
}

async function verifyLinkChallengesUnsafe(conn: LiveConn, content: string): Promise<void> {
  const complete = completeLines(content);
  if (!complete) return;
  const summary = await verifyLinkChallengesInAdmText(
    prisma as unknown as LinkClient,
    { guildId: conn.guildId, nitradoConnId: conn.id },
    complete,
    config.security.encryptionKey,
  );
  if (summary.verified > 0) {
    logAudit('LINK_CHALLENGE_VERIFIED', 'LINKING', {
      guildId: conn.guildId,
      nitradoConnId: conn.id,
      verified: summary.verified,
      source: 'ADM_V2_LIVE',
    });
  }
}

function localParts(date: Date, timeZone: string | null): { date: Date; timeMs: number } {
  if (!timeZone) {
    return {
      date: new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())),
      timeMs: (date.getUTCHours() * 3600 + date.getUTCMinutes() * 60 + date.getUTCSeconds()) * 1000,
    };
  }
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const parts = formatter.formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find(part => part.type === type)?.value ?? 0);
  return {
    date: new Date(Date.UTC(value('year'), value('month') - 1, value('day'))),
    timeMs: (value('hour') * 3600 + value('minute') * 60 + value('second')) * 1000,
  };
}

async function dateContextForOffset(
  conn: LiveConn,
  sourceIdentity: string,
  fileName: string,
  offset: number,
  timeZone: string | null,
): Promise<AdmDateContext> {
  if (offset > 0) {
    const previous = await prisma.admEvent.findFirst({
      where: {
        guildId: conn.guildId,
        nitradoConnId: conn.id,
        sourceFile: sourceIdentity,
        sourceByteEnd: { lte: BigInt(offset) },
        occurredAt: { not: null },
      },
      orderBy: { sourceByteEnd: 'desc' },
      select: { occurredAt: true },
    });
    if (previous?.occurredAt) {
      const local = localParts(previous.occurredAt, timeZone);
      const context = newDateContext(local.date, timeZone);
      context.prevTimeMs = local.timeMs;
      return context;
    }
  }
  return newDateContext(resolveBaseDate('', fileName), timeZone);
}

/**
 * Source-Health lebt auf NitradoAdmProfileConfig. FeedConfig.lastErrorMsg bleibt
 * ausschliesslich fuer Discord-Zustellfehler reserviert.
 */
async function setSourceStatus(conn: LiveConn, message: string | null): Promise<void> {
  await withFreshAdmBinding(conn, async () => {
    await Promise.all([
      prisma.gameplayFeedConfig.updateMany({
        where: { guildId: conn.guildId, nitradoConnId: conn.id, isActive: true },
        data: { lastPolledAt: new Date() },
      }),
      recordAdmSourceError({ id: conn.id, guildId: conn.guildId }, message),
    ]);
  });
}

async function baselineCurrentFile(
  conn: LiveConn,
  client: NitradoClient,
  profileDir: string,
  file: AdmFile,
): Promise<void> {
  let newOffset = file.size;
  let tail = '';
  if (file.size > 0) {
    const length = Math.min(BASELINE_TAIL_BYTES, file.size);
    const start = file.size - length;
    tail = await client.downloadFileRange(conn.nitradoServerId, `${profileDir}/${file.name}`, start, length);
    const newline = tail.lastIndexOf('\n');
    if (newline >= 0) {
      newOffset = start + Buffer.byteLength(tail.slice(0, newline + 1), 'utf8');
    }
  }

  const sourceIdentity = admBindingFileIdentity(conn.bindingVersion, file.name);
  const meta: AdmSourceMeta = {
    fileIdentity: sourceIdentity,
    fileName: file.name,
    sourceFile: sourceIdentity,
    lastModifiedAt: file.modified_at,
    fileSize: file.size,
  };
  await withFreshAdmBinding(conn, () => persistAdmEvents(
    prisma as unknown as AdmPersistClient,
    { guildId: conn.guildId, nitradoConnId: conn.id },
    meta,
    { events: [], newOffset, trailingPartial: '', wasReset: false },
    fingerprint(tail),
  ));
  logger.info(`ADM-Live-Sync ${conn.id}: Baseline ${file.name} bei Byte ${newOffset}/${file.size} (${profileDir}, Binding ${conn.bindingVersion}).`);
}

async function ingestFile(
  conn: LiveConn,
  client: NitradoClient,
  profileDir: string,
  timeZone: string | null,
  file: AdmFile,
  startOffset: number,
): Promise<void> {
  if (!Number.isSafeInteger(file.size) || file.size < 0) throw new Error(`Ungueltige ADM-Dateigroesse fuer ${file.name}`);
  const sourceIdentity = admBindingFileIdentity(conn.bindingVersion, file.name);
  let offset = startOffset > file.size ? 0 : startOffset;
  let context = await dateContextForOffset(conn, sourceIdentity, file.name, offset, timeZone);

  while (offset < file.size) {
    const length = Math.min(RANGE_BYTES, file.size - offset);
    const chunk = await client.downloadFileRange(
      conn.nitradoServerId,
      `${profileDir}/${file.name}`,
      offset,
      length,
    );
    if (chunk.length === 0) break;

    const result = ingestChunk(chunk, offset, { fileName: file.name, dateCtx: context });
    const meta: AdmSourceMeta = {
      fileIdentity: sourceIdentity,
      fileName: file.name,
      sourceFile: sourceIdentity,
      lastModifiedAt: file.modified_at,
      fileSize: file.size,
    };
    await withFreshAdmBinding(conn, async () => {
      await persistAdmEvents(
        prisma as unknown as AdmPersistClient,
        { guildId: conn.guildId, nitradoConnId: conn.id },
        meta,
        result,
        fingerprint(chunk),
      );
      await verifyLinkChallengesUnsafe(conn, chunk);
    });

    if (result.events.length > 0) {
      logger.info(`ADM-Live-Sync ${conn.id}: ${result.events.length} Event(s) aus ${file.name} verarbeitet (Bytes ${offset}-${result.newOffset}, Binding ${conn.bindingVersion}).`);
    }

    if (result.newOffset <= offset) break;
    offset = result.newOffset;
    context = result.events.length > 0
      ? await dateContextForOffset(conn, sourceIdentity, file.name, offset, timeZone)
      : context;
  }
}

async function processConnection(scope: { id: string; guildId: string }): Promise<void> {
  let conn: LiveConn | null;
  try {
    conn = await readCurrentAdmBinding(scope);
  } catch (error) {
    const message = safeError(error);
    if (isAdmBindingFenceError(error)) logger.debug(`ADM-Live-Sync ${scope.id}: Binding-Lock busy/stale, Poll verworfen.`);
    else logger.warn(`ADM-Live-Sync ${scope.id}: Binding-Snapshot fehlgeschlagen: ${message}`);
    return;
  }
  if (!conn) return;

  let token: string;
  try {
    token = decrypt(conn.encryptedToken, config.security.encryptionKey);
  } catch {
    try {
      await setSourceStatus(conn, 'Nitrado-Token konnte nicht entschluesselt werden.');
    } catch (error) {
      if (!isAdmBindingFenceError(error)) logger.warn(`ADM-Live-Sync ${conn.id}: Source-Status konnte nicht geschrieben werden: ${safeError(error)}`);
    }
    return;
  }

  const client = new NitradoClient(token);
  const writeFence = <T>(work: () => Promise<T>): Promise<T> => withFreshAdmBinding(conn!, work);
  try {
    const profile = await resolveAdmProfile(
      { id: conn.id, guildId: conn.guildId, nitradoServerId: conn.nitradoServerId },
      client,
      writeFence,
    );
    const files = (await client.listAdmFiles(conn.nitradoServerId, profile.profileDir))
      .filter(file => Number.isSafeInteger(file.modified_at) && Number.isSafeInteger(file.size) && file.size >= 0)
      .sort((a, b) => a.modified_at - b.modified_at || a.name.localeCompare(b.name));
    if (files.length === 0) {
      await setSourceStatus(conn, `Keine .ADM-Dateien im aufgeloesten Verzeichnis ${profile.profileDir} gefunden.`);
      return;
    }

    const namespacePrefix = admBindingFileIdentityPrefix(conn.bindingVersion);
    const latestCursor = await prisma.admSourceCursor.findFirst({
      where: {
        guildId: conn.guildId,
        nitradoConnId: conn.id,
        ...(namespacePrefix ? { fileIdentity: { startsWith: namespacePrefix } } : {}),
      },
      orderBy: [{ lastModifiedAt: 'desc' }, { fileName: 'desc' }],
    });

    if (!latestCursor) {
      await baselineCurrentFile(conn, client, profile.profileDir, files[files.length - 1]);
      await setSourceStatus(conn, null);
      return;
    }

    const candidates: AdmFile[] = [];
    for (const file of files) {
      const fileIdentity = admBindingFileIdentity(conn.bindingVersion, file.name);
      const cursor = await prisma.admSourceCursor.findUnique({
        where: {
          guildId_nitradoConnId_fileIdentity: {
            guildId: conn.guildId,
            nitradoConnId: conn.id,
            fileIdentity,
          },
        },
      });
      if (cursor) {
        if (file.size !== Number(cursor.processedByteOffset) || file.size < Number(cursor.lastKnownSize)) candidates.push(file);
        continue;
      }
      if (
        file.modified_at > latestCursor.lastModifiedAt
        || (file.modified_at === latestCursor.lastModifiedAt && file.name > latestCursor.fileName)
      ) candidates.push(file);
    }

    for (const file of candidates.slice(0, MAX_FILES_PER_TICK)) {
      const fileIdentity = admBindingFileIdentity(conn.bindingVersion, file.name);
      const cursor = await prisma.admSourceCursor.findUnique({
        where: {
          guildId_nitradoConnId_fileIdentity: {
            guildId: conn.guildId,
            nitradoConnId: conn.id,
            fileIdentity,
          },
        },
      });
      await ingestFile(
        conn,
        client,
        profile.profileDir,
        profile.timeZone,
        file,
        cursor ? Number(cursor.processedByteOffset) : 0,
      );
    }
    await setSourceStatus(conn, null);
  } catch (error) {
    if (isAdmBindingFenceError(error)) {
      logger.debug(`ADM-Live-Sync ${conn.id}: Remote-Ergebnis wegen geaenderter/beschaeftigter Binding verworfen.`);
      return;
    }
    const message = safeError(error);
    logger.warn(`ADM-Live-Sync ${conn.id}: ${message}`);
    try {
      await setSourceStatus(conn, message);
    } catch (statusError) {
      if (!isAdmBindingFenceError(statusError)) {
        logger.warn(`ADM-Live-Sync ${conn.id}: Source-Status konnte nicht geschrieben werden: ${safeError(statusError)}`);
      }
    }
  }
}

export async function runAdmLiveSyncOnce(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // Der globale Sweep traegt bewusst nur stabile IDs. Token, Service und
    // Binding-Version werden pro Connection danach unter dem Config-Lock frisch
    // gelesen; damit kann kein alter Sweep-Snapshot Remote-Daten persistieren.
    // eslint-disable-next-line local/no-unscoped-prisma-query -- globaler Producer-Sweep; processConnection bleibt Guild+Connection scoped.
    const connections = await prisma.nitradoConnection.findMany({
      where: { status: 'ACTIVE', nitradoServerId: { not: null } },
      select: { id: true, guildId: true },
    });
    for (const connection of connections) await processConnection(connection);
  } catch (error) {
    logger.error('ADM-Live-Sync Fehler:', error as Error);
  } finally {
    running = false;
  }
}

export function startAdmLiveSyncCron(): void {
  if (timer) return;
  logger.info(`ADM-V2-Live-Sync gestartet (Intervall ${POLL_INTERVAL_MS / 1000}s, per-Server-Quelle).`);
  timer = setInterval(() => { void runAdmLiveSyncOnce(); }, POLL_INTERVAL_MS);
  timer.unref?.();
  void runAdmLiveSyncOnce();
}

export function stopAdmLiveSyncCron(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
