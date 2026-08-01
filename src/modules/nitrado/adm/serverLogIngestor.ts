/**
 * ServerLogIngestor (Phase 3, Schritt 2) — append-only ADM-Ingestion mit
 * byte-genauem Cursor.
 *
 * Kern-Invarianten:
 *  - `processedByteOffset` liegt IMMER auf einer Zeilengrenze (nach einem \n).
 *    Dadurch wird ab genau diesem Offset geparst — es geht KEINE erste neue
 *    Zeile verloren (KILL-001).
 *  - Eine unvollstaendige letzte Zeile wird NICHT verarbeitet; der Offset
 *    bleibt davor stehen, bis die Zeile (mit \n) vollstaendig ist.
 *  - Schrumpft die Datei (totalBytes < offset) -> Truncation/Rotation ->
 *    Reset auf 0 (KILL-002). Event-Dedupe (eventKey) verhindert Doppelposts.
 *  - Jedes Ereignis erhaelt einen deterministischen eventKey -> idempotent
 *    gegen erneute Verarbeitung (ADM-001/002).
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

/**
 * Verarbeitet den vollstaendigen Dateiinhalt ab `startOffset` (Zeilengrenze).
 * Der Datumskontext wird bei Bedarf aus dem Header/Dateinamen abgeleitet.
 */
export function ingestFullFile(
  content: string,
  startOffset: number,
  opts: { fileName?: string; dateCtx?: AdmDateContext } = {},
): IngestResult {
  const totalBytes = Buffer.byteLength(content, 'utf8');
  let offset = startOffset;
  let wasReset = false;
  if (offset > totalBytes) {
    // Datei geschrumpft -> Truncation/Rotation -> von vorne.
    offset = 0;
    wasReset = true;
  }

  const ctx = opts.dateCtx ?? newDateContext(resolveBaseDate(content, opts.fileName));

  const buf = Buffer.from(content, 'utf8');
  const tail = buf.subarray(offset).toString('utf8'); // offset ist Zeilengrenze -> UTF-8-sicher
  const parts = tail.split('\n');
  const trailingPartial = parts[parts.length - 1]; // letzte (unvollstaendige) Zeile, evtl. ''
  const completeLines = parts.slice(0, -1);

  const events: RawAdmEvent[] = [];
  let pos = offset;
  for (const rawLine of completeLines) {
    const lineBytes = Buffer.byteLength(rawLine, 'utf8') + 1; // + '\n'
    const byteStart = pos;
    const byteEnd = pos + lineBytes;
    pos = byteEnd;
    const line = rawLine.replace(/\r$/, ''); // CRLF-tolerant
    const parsed = parseAdmLine(line, ctx);
    if (parsed) events.push({ ...parsed, byteStart, byteEnd });
  }

  return { events, newOffset: pos, trailingPartial, wasReset };
}

/**
 * Deterministischer, global eindeutiger Ereignisschluessel (sha256, 64 hex).
 * Enthaelt Server-Scope + Dateiidentitaet + Byteposition + Rohzeile ->
 * dieselbe Zeile erzeugt IMMER denselben Key (Idempotenz), verschiedene
 * Server/Dateien kollidieren nicht.
 */
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

/** Prisma-Teilschnittstelle (fuer Testbarkeit ohne echten Client). */
export interface AdmPersistClient {
  admEvent: { createMany: (args: { data: unknown[]; skipDuplicates?: boolean }) => Promise<{ count: number }> };
  admSourceCursor: { upsert: (args: unknown) => Promise<unknown> };
  $transaction: <T>(fn: (tx: AdmPersistClient) => Promise<T>) => Promise<T>;
}

/**
 * Persistiert Ereignisse + Cursor ATOMAR. Doppelte eventKeys werden
 * uebersprungen (skipDuplicates) -> erneute Verarbeitung ist idempotent.
 */
export async function persistAdmEvents(
  client: AdmPersistClient,
  scope: AdmEventScope,
  meta: AdmSourceMeta,
  result: IngestResult,
  contentFingerprint: string | null,
): Promise<{ inserted: number }> {
  const rows = result.events.map((ev) => ({
    eventKey: computeEventKey(scope.guildId, scope.nitradoConnId, meta.fileIdentity, ev.byteStart, ev.rawLine),
    guildId: scope.guildId,
    nitradoConnId: scope.nitradoConnId,
    sourceFile: meta.fileName,
    sourceByteStart: BigInt(ev.byteStart),
    sourceByteEnd: BigInt(ev.byteEnd),
    occurredAt: ev.occurredAt,
    eventType: ev.eventType,
    actorGameId: ev.actorGameId,
    actorName: ev.actorName,
    targetGameId: ev.targetGameId,
    targetName: ev.targetName,
    objectType: ev.objectType,
    toolOrWeapon: ev.toolOrWeapon,
    distanceMeters: ev.distanceMeters,
    actorPosition: ev.actorPosition,
    targetPosition: ev.targetPosition,
    rawLine: ev.rawLine,
    parserVersion: ADM_PARSER_VERSION,
    parseStatus: ev.parseStatus,
  }));

  return client.$transaction(async (tx) => {
    let inserted = 0;
    if (rows.length > 0) {
      const r = await tx.admEvent.createMany({ data: rows, skipDuplicates: true });
      inserted = r.count;
    }
    await tx.admSourceCursor.upsert({
      where: { guildId_nitradoConnId_fileIdentity: { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId, fileIdentity: meta.fileIdentity } },
      create: {
        guildId: scope.guildId, nitradoConnId: scope.nitradoConnId,
        fileIdentity: meta.fileIdentity, fileName: meta.fileName,
        lastModifiedAt: meta.lastModifiedAt, lastKnownSize: BigInt(meta.fileSize),
        processedByteOffset: BigInt(result.newOffset), trailingPartialLine: result.trailingPartial || null,
        contentFingerprint, lastSuccessAt: new Date(),
      },
      update: {
        fileName: meta.fileName, lastModifiedAt: meta.lastModifiedAt, lastKnownSize: BigInt(meta.fileSize),
        processedByteOffset: BigInt(result.newOffset), trailingPartialLine: result.trailingPartial || null,
        contentFingerprint, lastSuccessAt: new Date(), lastError: null,
      },
    });
    return { inserted };
  });
}
