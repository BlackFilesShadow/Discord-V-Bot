/**
 * Live ADM ingestion for Gameplay Feeds V2.
 *
 * Only connections with an active GameplayFeedConfig are polled. Nitrado's
 * file_server/seek API reads only bytes after AdmSourceCursor. The old 15-min
 * ADM sync remains responsible for linking/reward/session side effects; both
 * paths share the same idempotent AdmEvent store.
 */

import crypto from 'crypto';
import prisma from '../../../database/prisma';
import { config } from '../../../config';
import { decrypt } from '../../../utils/security';
import { logger } from '../../../utils/logger';
import { NitradoClient } from '../nitradoClient';
import { resolveAdmProfile } from './profileResolver';
import {
  ingestChunk,
  persistAdmEvents,
  type AdmPersistClient,
  type AdmSourceMeta,
} from './serverLogIngestor';
import { newDateContext, resolveBaseDate, type AdmDateContext } from './admLineParser';

const POLL_INTERVAL_MS = 30_000;
const RANGE_BYTES = 512 * 1024;
const BASELINE_TAIL_BYTES = 64 * 1024;
const MAX_FILES_PER_TICK = 8;

let timer: NodeJS.Timeout | null = null;
let running = false;

interface LiveConn {
  id: string;
  guildId: string;
  encryptedToken: string;
  nitradoServerId: string | null;
}

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
  fileName: string,
  offset: number,
  timeZone: string | null,
): Promise<AdmDateContext> {
  if (offset > 0) {
    const previous = await prisma.admEvent.findFirst({
      where: {
        guildId: conn.guildId,
        nitradoConnId: conn.id,
        sourceFile: fileName,
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

async function setFeedSourceError(conn: LiveConn, message: string | null): Promise<void> {
  await prisma.gameplayFeedConfig.updateMany({
    where: { guildId: conn.guildId, nitradoConnId: conn.id, isActive: true },
    data: { lastErrorMsg: message, lastPolledAt: new Date() },
  });
}

async function baselineCurrentFile(
  conn: LiveConn,
  client: NitradoClient,
  profileDir: string,
  file: AdmFile,
): Promise<void> {
  // No historical replay on the first ever V2 start. Anchor on the last full
  // newline where practical, but never read more than a small tail.
  let newOffset = file.size;
  let tail = '';
  if (file.size > 0) {
    const length = Math.min(BASELINE_TAIL_BYTES, file.size);
    const start = file.size - length;
    tail = await client.downloadFileRange(conn.nitradoServerId!, `${profileDir}/${file.name}`, start, length);
    const newline = tail.lastIndexOf('\n');
    if (newline >= 0) {
      newOffset = start + Buffer.byteLength(tail.slice(0, newline + 1), 'utf8');
    }
  }

  const meta: AdmSourceMeta = {
    fileIdentity: file.name,
    fileName: file.name,
    lastModifiedAt: file.modified_at,
    fileSize: file.size,
  };
  await persistAdmEvents(
    prisma as unknown as AdmPersistClient,
    { guildId: conn.guildId, nitradoConnId: conn.id },
    meta,
    { events: [], newOffset, trailingPartial: '', wasReset: false },
    fingerprint(tail),
  );
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
  let offset = startOffset > file.size ? 0 : startOffset;
  let context = await dateContextForOffset(conn, file.name, offset, timeZone);

  while (offset < file.size) {
    const length = Math.min(RANGE_BYTES, file.size - offset);
    const chunk = await client.downloadFileRange(
      conn.nitradoServerId!,
      `${profileDir}/${file.name}`,
      offset,
      length,
    );
    if (chunk.length === 0) break;

    const result = ingestChunk(chunk, offset, { fileName: file.name, dateCtx: context });
    const meta: AdmSourceMeta = {
      fileIdentity: file.name,
      fileName: file.name,
      lastModifiedAt: file.modified_at,
      fileSize: file.size,
    };
    await persistAdmEvents(
      prisma as unknown as AdmPersistClient,
      { guildId: conn.guildId, nitradoConnId: conn.id },
      meta,
      result,
      fingerprint(chunk),
    );

    if (result.newOffset <= offset) break; // trailing partial line; retry next poll
    offset = result.newOffset;
    context = result.events.length > 0
      ? await dateContextForOffset(conn, file.name, offset, timeZone)
      : context;
  }
}

async function processConnection(conn: LiveConn): Promise<void> {
  if (!conn.nitradoServerId) return;
  let token: string;
  try {
    token = decrypt(conn.encryptedToken, config.security.encryptionKey);
  } catch {
    await setFeedSourceError(conn, 'Nitrado-Token konnte nicht entschluesselt werden.');
    return;
  }

  const client = new NitradoClient(token);
  try {
    const profile = await resolveAdmProfile(
      { id: conn.id, guildId: conn.guildId, nitradoServerId: conn.nitradoServerId },
      client,
    );
    const files = (await client.listAdmFiles(conn.nitradoServerId, profile.profileDir))
      .filter(file => Number.isSafeInteger(file.modified_at) && Number.isSafeInteger(file.size) && file.size >= 0)
      .sort((a, b) => a.modified_at - b.modified_at || a.name.localeCompare(b.name));
    if (files.length === 0) {
      await setFeedSourceError(conn, null);
      return;
    }

    const latestCursor = await prisma.admSourceCursor.findFirst({
      where: { guildId: conn.guildId, nitradoConnId: conn.id },
      orderBy: [{ lastModifiedAt: 'desc' }, { fileName: 'desc' }],
    });

    if (!latestCursor) {
      await baselineCurrentFile(conn, client, profile.profileDir, files[files.length - 1]);
      await setFeedSourceError(conn, null);
      return;
    }

    const candidates: AdmFile[] = [];
    for (const file of files) {
      const cursor = await prisma.admSourceCursor.findUnique({
        where: {
          guildId_nitradoConnId_fileIdentity: {
            guildId: conn.guildId,
            nitradoConnId: conn.id,
            fileIdentity: file.name,
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
      const cursor = await prisma.admSourceCursor.findUnique({
        where: {
          guildId_nitradoConnId_fileIdentity: {
            guildId: conn.guildId,
            nitradoConnId: conn.id,
            fileIdentity: file.name,
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
    await setFeedSourceError(conn, null);
  } catch (error) {
    const message = safeError(error);
    logger.warn(`ADM-Live-Sync ${conn.id}: ${message}`);
    await setFeedSourceError(conn, message);
  }
}

export async function runAdmLiveSyncOnce(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // Only feed-enabled scopes need low-latency Nitrado polling.
    // eslint-disable-next-line local/no-unscoped-prisma-query -- global producer discovery; exact scope enforced below
    const feeds = await prisma.gameplayFeedConfig.findMany({
      where: { isActive: true },
      select: { guildId: true, nitradoConnId: true },
      distinct: ['guildId', 'nitradoConnId'],
    });
    if (feeds.length === 0) return;

    const ids = Array.from(new Set(feeds.map(feed => feed.nitradoConnId)));
    // eslint-disable-next-line local/no-unscoped-prisma-query -- IDs originate from scoped active feed configs
    const connections = await prisma.nitradoConnection.findMany({
      where: { id: { in: ids }, status: 'ACTIVE', nitradoServerId: { not: null } },
      select: { id: true, guildId: true, encryptedToken: true, nitradoServerId: true },
    });
    const allowedScopes = new Set(feeds.map(feed => `${feed.guildId}\u0000${feed.nitradoConnId}`));
    for (const connection of connections) {
      if (!allowedScopes.has(`${connection.guildId}\u0000${connection.id}`)) continue;
      await processConnection(connection);
    }
  } catch (error) {
    logger.error('ADM-Live-Sync Fehler:', error as Error);
  } finally {
    running = false;
  }
}

export function startAdmLiveSyncCron(): void {
  if (timer) return;
  timer = setInterval(() => { void runAdmLiveSyncOnce(); }, POLL_INTERVAL_MS);
  timer.unref?.();
  void runAdmLiveSyncOnce();
}

export function stopAdmLiveSyncCron(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
