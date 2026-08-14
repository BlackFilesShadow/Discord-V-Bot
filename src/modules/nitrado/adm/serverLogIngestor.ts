/**
 * ServerLogIngestor — append-only ADM-Ingestion mit byte-genauem Cursor.
 *
 * `ingestFullFile` bleibt fuer Uploads/Regression erhalten. Der Live-Pfad nutzt
 * `ingestChunk`, dessen `absoluteOffset` immer auf der letzten vollstaendig
 * verarbeiteten Zeilengrenze liegt. Eine angeschnittene Schlusszeile bewegt den
 * Cursor nicht und wird beim naechsten Seek erneut vollstaendig gelesen.
 */

import crypto from 'crypto';
import {
  parseAdmLine,
  newDateContext,
  resolveBaseDate,
  ADM_PARSER_VERSION,
  type ParsedAdmEvent,
  type AdmDateContext,
} from './admLineParser';

export interface RawAdmEvent extends ParsedAdmEvent {
  byteStart: number;
  byteEnd: number;
}

export interface IngestResult {
  events: RawAdmEvent[];
  newOffset: number;
  trailingPartial: string;
  wasReset: boolean;
}

function parseCompleteChunk(
  content: string,
  absoluteOffset: number,
  ctx: AdmDateContext,
): Omit<IngestResult, 'wasReset'> {
  const parts = content.split('\n');
  const trailingPartial = parts[parts.length - 1] ?? '';
  const completeLines = parts.slice(0, -1);
  const events: RawAdmEvent[] = [];
  let pos = absoluteOffset;

  for (const rawLine of completeLines) {
    const lineBytes = Buffer.byteLength(rawLine, 'utf8') + 1;
    const byteStart = pos;
    const byteEnd = pos + lineBytes;
    pos = byteEnd;
    const line = rawLine.replace(/\r$/, '');
    const parsed = parseAdmLine(line, ctx);
    if (parsed) events.push({ ...parsed, byteStart, byteEnd });
  }

  return { events, newOffset: pos, trailingPartial };
}

export function ingestFullFile(
  content: string,
  startOffset: number,
  opts: { fileName?: string; dateCtx?: AdmDateContext } = {},
): IngestResult {
  const totalBytes = Buffer.byteLength(content, 'utf8');
  let offset = startOffset;
  let wasReset = false;
  if (offset > totalBytes) {
    offset = 0;
    wasReset = true;
  }

  const ctx = opts.dateCtx ?? newDateContext(resolveBaseDate(content, opts.fileName));
  const buf = Buffer.from(content, 'utf8');
  const tail = buf.subarray(offset).toString('utf8');
  return { ...parseCompleteChunk(tail, offset, ctx), wasReset };
}

/**
 * Parst einen via Nitrado file_server/seek gelesenen Byte-Bereich. Der Aufrufer
 * muss an einer bekannten Zeilengrenze starten. Der Dateiname liefert den
 * Datumskontext, falls der aktuelle Chunk keinen AdminLog-Header enthaelt.
 */
export function ingestChunk(
  content: string,
  absoluteOffset: number,
  opts: { fileName?: string; dateCtx?: AdmDateContext } = {},
): IngestResult {
  if (!Number.isSafeInteger(absoluteOffset) || absoluteOffset < 0) {
    throw new Error('ADM-Chunk-Offset muss eine nicht-negative sichere Ganzzahl sein');
  }
  const ctx = opts.dateCtx ?? newDateContext(resolveBaseDate(content, opts.fileName));
  return { ...parseCompleteChunk(content, absoluteOffset, ctx), wasReset: false };
}

export function computeEventKey(
  guildId: string,
  nitradoConnId: string,
  fileIdentity: string,
  byteStart: number,
  rawLine: string,
): string {
  return crypto
    .createHash('sha256')
    .update(`${guildId}\u0000${nitradoConnId}\u0000${fileIdentity}\u0000${byteStart}\u0000${rawLine}`)
    .digest('hex');
}

export interface AdmEventScope {
  guildId: string;
  nitradoConnId: string;
}

export interface AdmSourceMeta {
  fileIdentity: string;
  fileName: string;
  lastModifiedAt: number;
  fileSize: number;
}

export interface AdmPersistClient {
  admEvent: { createMany: (args: { data: unknown[]; skipDuplicates?: boolean }) => Promise<{ count: number }> };
  admSourceCursor: { upsert: (args: unknown) => Promise<unknown> };
  $transaction: <T>(fn: (tx: AdmPersistClient) => Promise<T>) => Promise<T>;
}

export async function persistAdmEvents(
  client: AdmPersistClient,
  scope: AdmEventScope,
  meta: AdmSourceMeta,
  result: IngestResult,
  contentFingerprint: string | null,
): Promise<{ inserted: number }> {
  const rows = result.events.map((event) => ({
    eventKey: computeEventKey(scope.guildId, scope.nitradoConnId, meta.fileIdentity, event.byteStart, event.rawLine),
    guildId: scope.guildId,
    nitradoConnId: scope.nitradoConnId,
    sourceFile: meta.fileName,
    sourceByteStart: BigInt(event.byteStart),
    sourceByteEnd: BigInt(event.byteEnd),
    occurredAt: event.occurredAt,
    eventType: event.eventType,
    actorGameId: event.actorGameId,
    actorName: event.actorName,
    targetGameId: event.targetGameId,
    targetName: event.targetName,
    objectType: event.objectType,
    toolOrWeapon: event.toolOrWeapon,
    distanceMeters: event.distanceMeters,
    actorPosition: event.actorPosition,
    targetPosition: event.targetPosition,
    rawLine: event.rawLine,
    parserVersion: ADM_PARSER_VERSION,
    parseStatus: event.parseStatus,
  }));

  return client.$transaction(async (tx) => {
    let inserted = 0;
    if (rows.length > 0) {
      const created = await tx.admEvent.createMany({ data: rows, skipDuplicates: true });
      inserted = created.count;
    }
    await tx.admSourceCursor.upsert({
      where: {
        guildId_nitradoConnId_fileIdentity: {
          guildId: scope.guildId,
          nitradoConnId: scope.nitradoConnId,
          fileIdentity: meta.fileIdentity,
        },
      },
      create: {
        guildId: scope.guildId,
        nitradoConnId: scope.nitradoConnId,
        fileIdentity: meta.fileIdentity,
        fileName: meta.fileName,
        lastModifiedAt: meta.lastModifiedAt,
        lastKnownSize: BigInt(meta.fileSize),
        processedByteOffset: BigInt(result.newOffset),
        trailingPartialLine: result.trailingPartial || null,
        contentFingerprint,
        lastSuccessAt: new Date(),
      },
      update: {
        fileName: meta.fileName,
        lastModifiedAt: meta.lastModifiedAt,
        lastKnownSize: BigInt(meta.fileSize),
        processedByteOffset: BigInt(result.newOffset),
        trailingPartialLine: result.trailingPartial || null,
        contentFingerprint,
        lastSuccessAt: new Date(),
        lastError: null,
      },
    });
    return { inserted };
  });
}
