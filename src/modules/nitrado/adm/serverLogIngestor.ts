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
  /**
   * Optionaler persistierter Event-Source-Key. Standard bleibt der echte
   * Dateiname; der Live-Pfad kann fuer spaetere Service-Bindings einen
   * namespaceten Wert verwenden, ohne Cursor-Diagnosefelder zu veraendern.
   */
  sourceFile?: string;
  lastModifiedAt: number;
  fileSize: number;
}

interface AdmCursorState {
  lastModifiedAt: number;
  lastKnownSize: bigint;
  processedByteOffset: bigint;
  trailingPartialLine: string | null;
  contentFingerprint: string | null;
}

export interface AdmPersistClient {
  admEvent: { createMany: (args: { data: unknown[]; skipDuplicates?: boolean }) => Promise<{ count: number }> };
  admSourceCursor: {
    findUnique: (args: unknown) => Promise<AdmCursorState | null>;
    upsert: (args: unknown) => Promise<unknown>;
  };
  $queryRawUnsafe: <T = unknown>(query: string, ...values: unknown[]) => Promise<T>;
  $transaction: <T>(fn: (tx: AdmPersistClient) => Promise<T>) => Promise<T>;
}

function admPersistLockKey(scope: AdmEventScope, fileIdentity: string): string {
  return `adm-persist:${scope.guildId}:${scope.nitradoConnId}:${fileIdentity}`;
}

function shouldAcceptCursorSnapshot(
  current: AdmCursorState | null,
  meta: AdmSourceMeta,
  result: IngestResult,
): boolean {
  if (!current) return true;

  const incomingSize = BigInt(meta.fileSize);
  const incomingOffset = BigInt(result.newOffset);
  const confirmedReset = result.wasReset
    || (
      meta.lastModifiedAt > current.lastModifiedAt
      && incomingSize < current.lastKnownSize
      && incomingOffset <= incomingSize
    );
  if (confirmedReset) return true;

  // Ein langsamer Replica-Snapshot darf einen bereits frischeren Dateistand
  // niemals zurueckschreiben. Bei gleicher mtime gilt kleinere Datei/Offset
  // ebenfalls als stale; groessere Datei bei gleichem Offset kann dagegen eine
  // neue unvollstaendige Schlusszeile repraesentieren und bleibt zulaessig.
  if (meta.lastModifiedAt < current.lastModifiedAt) return false;
  if (meta.lastModifiedAt === current.lastModifiedAt && incomingSize < current.lastKnownSize) return false;
  if (incomingOffset < current.processedByteOffset) return false;
  return true;
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
    sourceFile: meta.sourceFile ?? meta.fileName,
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
    // DB-weite Commit-Grenze pro Guild+Gameserver+ADM-Datei. Remote-I/O bleibt
    // ausserhalb dieses Locks; nur Event-Dedup + Cursor-Wahrheit werden zwischen
    // mehreren Bot-Replikas serialisiert.
    await tx.$queryRawUnsafe(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      admPersistLockKey(scope, meta.fileIdentity),
    );

    const cursorWhere = {
      guildId_nitradoConnId_fileIdentity: {
        guildId: scope.guildId,
        nitradoConnId: scope.nitradoConnId,
        fileIdentity: meta.fileIdentity,
      },
    };
    const current = await tx.admSourceCursor.findUnique({
      where: cursorWhere,
      select: {
        lastModifiedAt: true,
        lastKnownSize: true,
        processedByteOffset: true,
        trailingPartialLine: true,
        contentFingerprint: true,
      },
    });

    // Die Freshness-Entscheidung muss VOR jedem Event-Write fallen. Sonst
    // koennte eine langsame Replika zwar den Cursor nicht mehr zuruecksetzen,
    // aber alte/rotierte Zeilen unter neuen eventKeys trotzdem persistieren.
    if (!shouldAcceptCursorSnapshot(current, meta, result)) {
      return { inserted: 0 };
    }

    let inserted = 0;
    if (rows.length > 0) {
      const created = await tx.admEvent.createMany({ data: rows, skipDuplicates: true });
      inserted = created.count;
    }

    await tx.admSourceCursor.upsert({
      where: cursorWhere,
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
