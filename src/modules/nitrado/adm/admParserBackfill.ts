/**
 * Kontrollierter ADM-Parser-Backfill.
 *
 * WICHTIGER VERTRAG:
 * - arbeitet nur auf bereits persistierten AdmEvent-Zeilen
 * - setzt AdmSourceCursor niemals zurueck
 * - veraendert weder eventKey noch sourceByteStart/sourceByteEnd/createdAt
 * - erzeugt keine GameplayFeedDelivery, Radar-Aktion oder Reward-Wiederholung
 * - fehlende FlagActivityEvent-Zeilen bekommen das historische AdmEvent.createdAt,
 *   damit ein Backfill niemals als neue Live-Aktion ausgespielt wird
 *
 * parserVersion ist zugleich die idempotente Zeilenmarkierung. Ein Crash kann
 * daher gefahrlos erneut laufen; bereits erfolgreich aktualisierte Zeilen fallen
 * aus der naechsten Abfrage heraus.
 */

import {
  ADM_PARSER_VERSION,
  newDateContext,
  parseAdmLine,
  type ParsedAdmEvent,
} from './admLineParser';

const DEFAULT_BATCH_SIZE = 250;
const DEFAULT_MAX_BATCHES = 4;
const COMPLETED_RECHECK_MS = 6 * 60 * 60 * 1000;

export interface AdmParserBackfillScope {
  guildId: string;
  nitradoConnId: string;
}

interface PersistedAdmRow {
  id: string;
  eventKey: string;
  sourceFile: string;
  sourceByteStart: bigint;
  occurredAt: Date | null;
  createdAt: Date;
  rawLine: string;
  parserVersion: number;
}

interface BackfillStateRow {
  completedAt: Date | null;
  lastCheckedAt: Date | null;
}

interface UpdateManyResult {
  count: number;
}

interface AdmParserBackfillTx {
  admEvent: {
    updateMany: (args: unknown) => Promise<UpdateManyResult>;
  };
  flagActivityEvent: {
    createMany: (args: unknown) => Promise<UpdateManyResult>;
  };
}

export interface AdmParserBackfillClient extends AdmParserBackfillTx {
  admEvent: AdmParserBackfillTx['admEvent'] & {
    findMany: (args: unknown) => Promise<PersistedAdmRow[]>;
  };
  admParserBackfillState: {
    upsert: (args: unknown) => Promise<BackfillStateRow>;
    updateMany: (args: unknown) => Promise<UpdateManyResult>;
  };
  $transaction: <T>(fn: (tx: AdmParserBackfillTx) => Promise<T>) => Promise<T>;
}

export interface AdmParserBackfillResult {
  reparsed: number;
  flagRowsCreated: number;
  complete: boolean;
  deferredCompletedRecheck: boolean;
}

interface ReparsePatch {
  parsed: ParsedAdmEvent;
  admEventType: string;
  flagAction: 'RAISED' | 'LOWERED' | null;
}

function historicalDateContext(occurredAt: Date | null) {
  if (!occurredAt) return newDateContext(null);
  return newDateContext(new Date(Date.UTC(
    occurredAt.getUTCFullYear(),
    occurredAt.getUTCMonth(),
    occurredAt.getUTCDate(),
  )));
}

function unknownReparse(rawLine: string, occurredAt: Date | null): ParsedAdmEvent {
  return {
    eventType: 'UNKNOWN',
    occurredAt,
    actorGameId: null,
    actorName: null,
    targetGameId: null,
    targetName: null,
    objectType: null,
    toolOrWeapon: null,
    distanceMeters: null,
    actorPosition: null,
    targetPosition: null,
    rawLine,
    parseStatus: 'UNKNOWN',
  };
}

/**
 * Reparsed eine bereits persistierte timestamp-freie rawLine. Der synthetische
 * Uhrzeit-Prefix dient nur dazu, denselben kanonischen Parser wiederzuverwenden;
 * occurredAt wird danach exakt auf den historischen DB-Wert zurueckgesetzt.
 */
export function buildHistoricalReparsePatch(
  rawLine: string,
  occurredAt: Date | null,
): ReparsePatch {
  const reparsed = parseAdmLine(
    `00:00:00 | ${rawLine}`,
    historicalDateContext(occurredAt),
  ) ?? unknownReparse(rawLine, occurredAt);

  reparsed.occurredAt = occurredAt;
  const flagAction = reparsed.eventType === 'FLAG_RAISED'
    ? 'RAISED'
    : reparsed.eventType === 'FLAG_LOWERED'
      ? 'LOWERED'
      : null;

  // Die zentrale AdmEventType-Enum fuehrt Flaggen absichtlich nicht als eigene
  // Werte. Wie beim Live-Ingest bleibt die Rohzeile dort UNKNOWN; die typisierte
  // Wahrheit liegt parallel in FlagActivityEvent.
  return {
    parsed: reparsed,
    admEventType: flagAction ? 'UNKNOWN' : reparsed.eventType,
    flagAction,
  };
}

function boundedInt(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(value!)));
}

export async function runAdmParserBackfill(
  client: AdmParserBackfillClient,
  scope: AdmParserBackfillScope,
  options: {
    batchSize?: number;
    maxBatches?: number;
    now?: Date;
  } = {},
): Promise<AdmParserBackfillResult> {
  const now = options.now ?? new Date();
  const batchSize = boundedInt(options.batchSize, DEFAULT_BATCH_SIZE, 2_000);
  const maxBatches = boundedInt(options.maxBatches, DEFAULT_MAX_BATCHES, 20);

  const state = await client.admParserBackfillState.upsert({
    where: {
      guildId_nitradoConnId_targetParserVersion: {
        guildId: scope.guildId,
        nitradoConnId: scope.nitradoConnId,
        targetParserVersion: ADM_PARSER_VERSION,
      },
    },
    create: {
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
      targetParserVersion: ADM_PARSER_VERSION,
      lastCheckedAt: null,
      completedAt: null,
    },
    update: {},
    select: { completedAt: true, lastCheckedAt: true },
  });

  if (
    state.completedAt
    && state.lastCheckedAt
    && now.getTime() - state.lastCheckedAt.getTime() < COMPLETED_RECHECK_MS
  ) {
    return {
      reparsed: 0,
      flagRowsCreated: 0,
      complete: true,
      deferredCompletedRecheck: true,
    };
  }

  let reparsedCount = 0;
  let flagRowsCreated = 0;

  for (let batchNo = 0; batchNo < maxBatches; batchNo += 1) {
    const rows = await client.admEvent.findMany({
      where: {
        guildId: scope.guildId,
        nitradoConnId: scope.nitradoConnId,
        parserVersion: { lt: ADM_PARSER_VERSION },
      },
      orderBy: { id: 'asc' },
      take: batchSize,
      select: {
        id: true,
        eventKey: true,
        sourceFile: true,
        sourceByteStart: true,
        occurredAt: true,
        createdAt: true,
        rawLine: true,
        parserVersion: true,
      },
    });

    if (rows.length === 0) {
      await client.admParserBackfillState.updateMany({
        where: {
          guildId: scope.guildId,
          nitradoConnId: scope.nitradoConnId,
          targetParserVersion: ADM_PARSER_VERSION,
        },
        data: {
          lastCheckedAt: now,
          completedAt: reparsedCount > 0 ? now : state.completedAt ?? now,
        },
      });
      return {
        reparsed: reparsedCount,
        flagRowsCreated,
        complete: true,
        deferredCompletedRecheck: false,
      };
    }

    let claimedInBatch = 0;
    for (const row of rows) {
      const patch = buildHistoricalReparsePatch(row.rawLine, row.occurredAt);
      const result = await client.$transaction(async (tx) => {
        // parserVersion im WHERE ist der row-level Claim gegen parallele Worker.
        // Genau ein Worker darf die historische Zeile auf die neue Semantik heben.
        const claimed = await tx.admEvent.updateMany({
          where: {
            id: row.id,
            guildId: scope.guildId,
            nitradoConnId: scope.nitradoConnId,
            parserVersion: { lt: ADM_PARSER_VERSION },
          },
          data: {
            eventType: patch.admEventType,
            actorGameId: patch.parsed.actorGameId,
            actorName: patch.parsed.actorName,
            targetGameId: patch.parsed.targetGameId,
            targetName: patch.parsed.targetName,
            objectType: patch.parsed.objectType,
            toolOrWeapon: patch.parsed.toolOrWeapon,
            distanceMeters: patch.parsed.distanceMeters,
            actorPosition: patch.parsed.actorPosition,
            targetPosition: patch.parsed.targetPosition,
            parserVersion: ADM_PARSER_VERSION,
            parseStatus: patch.parsed.parseStatus,
          },
        });
        if (claimed.count !== 1) return { claimed: false, flagCreated: 0 };

        let flagCreated = 0;
        if (patch.flagAction) {
          // createMany+skipDuplicates bleibt cross-worker idempotent. createdAt
          // stammt absichtlich vom historischen AdmEvent und NICHT von now().
          const created = await tx.flagActivityEvent.createMany({
            data: [{
              eventKey: row.eventKey,
              guildId: scope.guildId,
              nitradoConnId: scope.nitradoConnId,
              sourceFile: row.sourceFile,
              sourceByteStart: row.sourceByteStart,
              occurredAt: row.occurredAt,
              action: patch.flagAction,
              actorGameId: patch.parsed.actorGameId,
              actorName: patch.parsed.actorName,
              actorPosition: patch.parsed.actorPosition,
              flagType: patch.parsed.objectType,
              totemType: patch.parsed.targetName,
              flagPosition: patch.parsed.targetPosition,
              rawLine: row.rawLine,
              createdAt: row.createdAt,
            }],
            skipDuplicates: true,
          });
          flagCreated = created.count;
        }
        return { claimed: true, flagCreated };
      });

      if (result.claimed) {
        reparsedCount += 1;
        claimedInBatch += 1;
        flagRowsCreated += result.flagCreated;
      }
    }

    await client.admParserBackfillState.updateMany({
      where: {
        guildId: scope.guildId,
        nitradoConnId: scope.nitradoConnId,
        targetParserVersion: ADM_PARSER_VERSION,
      },
      data: {
        processedRows: { increment: BigInt(claimedInBatch) },
        lastCheckedAt: now,
        completedAt: null,
      },
    });

    if (rows.length < batchSize) {
      // Eine weitere Schleifenrunde bestaetigt explizit, dass auch bei einem
      // parallelen Worker keine alte parserVersion-Zeile mehr uebrig ist.
      continue;
    }
  }

  return {
    reparsed: reparsedCount,
    flagRowsCreated,
    complete: false,
    deferredCompletedRecheck: false,
  };
}
