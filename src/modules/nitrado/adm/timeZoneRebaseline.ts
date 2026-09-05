import prisma from '../../../database/prisma';
import { newDateContext, parseAdmLine, resolveBaseDate } from './admLineParser';

const DAY_MS = 86_400_000;
const ADM_TIME_PREFIX_RE = /^\d{2}:\d{2}:\d{2}(?:\s*\|?\s*)/;

export interface AdmTimeZoneRebaselineResult {
  updated: boolean;
  eventId: string | null;
  previousOccurredAt: Date | null;
  occurredAt: Date | null;
}

function remoteModifiedAtToDate(value: number): Date | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function wallClockPrefixFromInstant(occurredAt: Date, timeZone: string | null): string | null {
  if (Number.isNaN(occurredAt.getTime())) return null;
  if (!timeZone) {
    return `${pad2(occurredAt.getUTCHours())}:${pad2(occurredAt.getUTCMinutes())}:${pad2(occurredAt.getUTCSeconds())}`;
  }

  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    const parts = formatter.formatToParts(occurredAt);
    const value = (type: Intl.DateTimeFormatPartTypes): number =>
      Number(parts.find(part => part.type === type)?.value ?? Number.NaN);
    const hour = value('hour');
    const minute = value('minute');
    const second = value('second');
    if (![hour, minute, second].every(Number.isFinite)) return null;
    return `${pad2(hour)}:${pad2(minute)}:${pad2(second)}`;
  } catch {
    return null;
  }
}

/**
 * AdmEvent.rawLine intentionally stores only the payload after the HH:mm:ss
 * prefix. To re-interpret an already-consumed event under another timezone we
 * reconstruct that original wall-clock prefix from its currently stored instant
 * using the timezone that produced it. This also heals the production +24h
 * continuation bug: even a day-shifted instant still retains the original
 * wall-clock time-of-day, while resolveAdmWallClockNearReference selects the
 * correct calendar day again from the real remote file mtime.
 */
export function restoreAdmWallClockLine(
  rawLine: string,
  occurredAt: Date | null,
  sourceTimeZone: string | null,
): string | null {
  if (ADM_TIME_PREFIX_RE.test(rawLine)) return rawLine;
  if (!occurredAt) return null;
  const prefix = wallClockPrefixFromInstant(occurredAt, sourceTimeZone);
  return prefix ? `${prefix} | ${rawLine}` : null;
}

/**
 * Resolves one ADM wall-clock line to the UTC instant closest to the file's
 * real modification instant. The filename supplies the session start date;
 * candidate days around the mtime allow long-running sessions and midnight
 * rollovers without hard-coding an offset or timezone.
 */
export function resolveAdmWallClockNearReference(
  rawLine: string,
  fileName: string,
  timeZone: string | null,
  reference: Date,
): Date | null {
  const baseDate = resolveBaseDate('', fileName);
  if (!baseDate || Number.isNaN(reference.getTime())) return null;

  const approximateDay = Math.max(0, Math.round((reference.getTime() - baseDate.getTime()) / DAY_MS));
  let best: { occurredAt: Date; distance: number } | null = null;

  for (let day = Math.max(0, approximateDay - 2); day <= approximateDay + 2; day += 1) {
    const candidateBase = new Date(baseDate.getTime() + day * DAY_MS);
    const event = parseAdmLine(rawLine, newDateContext(candidateBase, timeZone));
    if (!event?.occurredAt) continue;
    const distance = Math.abs(event.occurredAt.getTime() - reference.getTime());
    if (!best || distance < best.distance) best = { occurredAt: event.occurredAt, distance };
  }

  return best?.occurredAt ?? null;
}

/**
 * Rebaselines only the latest already-consumed ADM event after an explicit IANA
 * timezone save. The byte cursor, binding namespace and feed cursors are
 * untouched, so historical bytes cannot be replayed and already delivered
 * events cannot be emitted a second time. admLiveSyncCron will use this corrected
 * latest event as the continuation anchor for the next appended chunk.
 */
export async function rebaselineAdmTimeZoneAnchor(
  scope: { guildId: string; nitradoConnId: string },
  sourceTimeZone: string | null,
  timeZone: string | null,
): Promise<AdmTimeZoneRebaselineResult> {
  const cursor = await prisma.admSourceCursor.findFirst({
    where: { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId },
    orderBy: [{ lastModifiedAt: 'desc' }, { fileName: 'desc' }],
    select: {
      fileIdentity: true,
      fileName: true,
      lastModifiedAt: true,
      processedByteOffset: true,
    },
  });

  if (!cursor || cursor.processedByteOffset <= 0n) {
    return { updated: false, eventId: null, previousOccurredAt: null, occurredAt: null };
  }

  const event = await prisma.admEvent.findFirst({
    where: {
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
      sourceFile: cursor.fileIdentity,
      sourceByteEnd: { lte: cursor.processedByteOffset },
      occurredAt: { not: null },
    },
    orderBy: [{ sourceByteEnd: 'desc' }, { id: 'desc' }],
    select: { id: true, rawLine: true, occurredAt: true },
  });

  if (!event) {
    return { updated: false, eventId: null, previousOccurredAt: null, occurredAt: null };
  }

  const sourceLine = restoreAdmWallClockLine(event.rawLine, event.occurredAt, sourceTimeZone);
  if (!sourceLine) {
    return { updated: false, eventId: event.id, previousOccurredAt: event.occurredAt, occurredAt: null };
  }

  const reference = remoteModifiedAtToDate(cursor.lastModifiedAt) ?? new Date();
  const occurredAt = resolveAdmWallClockNearReference(sourceLine, cursor.fileName, timeZone, reference);
  if (!occurredAt) {
    return { updated: false, eventId: event.id, previousOccurredAt: event.occurredAt, occurredAt: null };
  }

  const changed = event.occurredAt?.getTime() !== occurredAt.getTime();
  if (changed) {
    await prisma.admEvent.updateMany({
      where: {
        id: event.id,
        guildId: scope.guildId,
        nitradoConnId: scope.nitradoConnId,
        sourceFile: cursor.fileIdentity,
      },
      data: { occurredAt },
    });
  }

  return {
    updated: changed,
    eventId: event.id,
    previousOccurredAt: event.occurredAt,
    occurredAt,
  };
}
