import prisma from '../../database/prisma';
import {
  LIVE_SERVER_KNOWLEDGE_CREATED_BY,
  liveServerBindingVersionFromSourceVersion,
  liveServerConnectionIdFromSourceRef,
} from './liveServerKnowledgeConstants';

export const KNOWLEDGE_SOURCE_KINDS = [
  'OWNER_CURATED',
  'OFFICIAL_DOC',
  'GAME_DATASET',
  'LIVE_SERVER',
  'IMPORTED',
  'SYSTEM_DERIVED',
  'UNKNOWN',
] as const;

export const KNOWLEDGE_TRUST_LEVELS = [
  'AUTHORITATIVE',
  'VERIFIED',
  'CURATED',
  'UNVERIFIED',
] as const;

export type KnowledgeSourceKind = typeof KNOWLEDGE_SOURCE_KINDS[number];
export type KnowledgeTrustLevel = typeof KNOWLEDGE_TRUST_LEVELS[number];
export type KnowledgeFreshness = 'FRESH' | 'AGING' | 'STALE' | 'EXPIRED';

export interface KnowledgeProvenanceInput {
  sourceKind?: unknown;
  trustLevel?: unknown;
  sourceRef?: unknown;
  sourceVersion?: unknown;
  observedAt?: unknown;
  validUntil?: unknown;
}

export interface KnowledgeProvenanceMeta {
  sourceKind: KnowledgeSourceKind;
  trustLevel: KnowledgeTrustLevel;
  sourceRef: string | null;
  sourceVersion: string | null;
  observedAt: Date;
  validUntil: Date | null;
  sourceAgeDays: number;
  freshness: KnowledgeFreshness;
  trustScore: number;
  freshnessScore: number;
  qualityFactor: number;
  legacyDefault: boolean;
}

export interface NormalizedKnowledgeProvenance {
  sourceKind: KnowledgeSourceKind;
  trustLevel: KnowledgeTrustLevel;
  sourceRef: string | null;
  sourceVersion: string | null;
  observedAt: Date;
  validUntil: Date | null;
}

export type ProvenanceValidation =
  | { ok: true; value: NormalizedKnowledgeProvenance }
  | { ok: false; message: string };

const TRUST_SCORE: Record<KnowledgeTrustLevel, number> = {
  AUTHORITATIVE: 1,
  VERIFIED: 0.93,
  CURATED: 0.82,
  UNVERIFIED: 0.6,
};

const DAY_MS = 86_400_000;
const MAX_FUTURE_SKEW_MS = 5 * 60_000;

function isSourceKind(value: unknown): value is KnowledgeSourceKind {
  return typeof value === 'string' && (KNOWLEDGE_SOURCE_KINDS as readonly string[]).includes(value);
}

function isTrustLevel(value: unknown): value is KnowledgeTrustLevel {
  return typeof value === 'string' && (KNOWLEDGE_TRUST_LEVELS as readonly string[]).includes(value);
}

function cleanNullableString(value: unknown, max: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const clean = value.trim();
  return clean ? clean.slice(0, max) : null;
}

function parseDate(value: unknown): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : undefined;
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : undefined;
}

export function validateKnowledgeProvenance(
  input: KnowledgeProvenanceInput | null | undefined,
  defaults: { sourceKind: KnowledgeSourceKind; trustLevel: KnowledgeTrustLevel; observedAt?: Date } = {
    sourceKind: 'OWNER_CURATED',
    trustLevel: 'CURATED',
  },
  now = new Date(),
): ProvenanceValidation {
  const sourceKind = input?.sourceKind === undefined ? defaults.sourceKind : input.sourceKind;
  const trustLevel = input?.trustLevel === undefined ? defaults.trustLevel : input.trustLevel;
  if (!isSourceKind(sourceKind)) return { ok: false, message: 'sourceKind ist ungueltig.' };
  if (!isTrustLevel(trustLevel)) return { ok: false, message: 'trustLevel ist ungueltig.' };

  const sourceRef = cleanNullableString(input?.sourceRef, 500);
  if (input?.sourceRef !== undefined && sourceRef === undefined) {
    return { ok: false, message: 'sourceRef muss String oder null sein.' };
  }
  const sourceVersion = cleanNullableString(input?.sourceVersion, 100);
  if (input?.sourceVersion !== undefined && sourceVersion === undefined) {
    return { ok: false, message: 'sourceVersion muss String oder null sein.' };
  }

  const observedAtParsed = parseDate(input?.observedAt);
  if (input?.observedAt !== undefined && observedAtParsed === undefined) {
    return { ok: false, message: 'observedAt ist ungueltig.' };
  }
  const observedAt = observedAtParsed ?? defaults.observedAt ?? now;
  if (observedAt.getTime() > now.getTime() + MAX_FUTURE_SKEW_MS) {
    return { ok: false, message: 'observedAt darf nicht in der Zukunft liegen.' };
  }

  const validUntilParsed = parseDate(input?.validUntil);
  if (input?.validUntil !== undefined && validUntilParsed === undefined) {
    return { ok: false, message: 'validUntil ist ungueltig.' };
  }
  const validUntil = validUntilParsed ?? null;
  if (validUntil && validUntil.getTime() <= observedAt.getTime()) {
    return { ok: false, message: 'validUntil muss nach observedAt liegen.' };
  }

  if (trustLevel === 'AUTHORITATIVE' && !(sourceRef ?? '').trim()) {
    return { ok: false, message: 'AUTHORITATIVE erfordert eine konkrete sourceRef.' };
  }

  return {
    ok: true,
    value: {
      sourceKind,
      trustLevel,
      sourceRef: sourceRef ?? null,
      sourceVersion: sourceVersion ?? null,
      observedAt,
      validUntil,
    },
  };
}

function freshnessThresholds(kind: KnowledgeSourceKind): { fresh: number; aging: number } {
  switch (kind) {
    case 'LIVE_SERVER': return { fresh: 1, aging: 7 };
    case 'SYSTEM_DERIVED': return { fresh: 7, aging: 30 };
    case 'IMPORTED':
    case 'UNKNOWN': return { fresh: 30, aging: 90 };
    case 'OFFICIAL_DOC':
    case 'GAME_DATASET':
    case 'OWNER_CURATED':
    default: return { fresh: 90, aging: 365 };
  }
}

export function assessKnowledgeProvenance(
  value: NormalizedKnowledgeProvenance,
  now = new Date(),
  legacyDefault = false,
): KnowledgeProvenanceMeta {
  const observedMs = Math.min(value.observedAt.getTime(), now.getTime());
  const sourceAgeDays = Math.max(0, (now.getTime() - observedMs) / DAY_MS);
  const expired = Boolean(value.validUntil && value.validUntil.getTime() <= now.getTime());
  const thresholds = freshnessThresholds(value.sourceKind);
  const freshness: KnowledgeFreshness = expired
    ? 'EXPIRED'
    : sourceAgeDays <= thresholds.fresh
      ? 'FRESH'
      : sourceAgeDays <= thresholds.aging
        ? 'AGING'
        : 'STALE';
  const freshnessScore = freshness === 'FRESH'
    ? 1
    : freshness === 'AGING'
      ? 0.86
      : freshness === 'STALE'
        ? 0.65
        : 0;
  const trustScore = TRUST_SCORE[value.trustLevel];
  const sourceQuality = 0.65 * trustScore + 0.35 * freshnessScore;
  const qualityFactor = freshness === 'EXPIRED' ? 0 : 0.88 + 0.12 * sourceQuality;
  return {
    ...value,
    sourceAgeDays: Number(sourceAgeDays.toFixed(2)),
    freshness,
    trustScore,
    freshnessScore,
    qualityFactor,
    legacyDefault,
  };
}

export function legacyKnowledgeProvenance(createdAt: Date, now = new Date()): KnowledgeProvenanceMeta {
  return assessKnowledgeProvenance({
    sourceKind: 'OWNER_CURATED',
    trustLevel: 'CURATED',
    sourceRef: null,
    sourceVersion: null,
    observedAt: createdAt,
    validUntil: null,
  }, now, true);
}

function expireLiveServerMeta(meta: KnowledgeProvenanceMeta): KnowledgeProvenanceMeta {
  return {
    ...meta,
    freshness: 'EXPIRED',
    freshnessScore: 0,
    qualityFactor: 0,
  };
}

interface StoredKnowledgeProvenanceRow {
  knowledgeId: string;
  sourceKind: string;
  sourceRef: string | null;
  sourceVersion: string | null;
}

function mirrorCandidateRows(stored: readonly StoredKnowledgeProvenanceRow[]) {
  return stored
    .map((row) => ({
      row,
      nitradoConnId: row.sourceKind === 'LIVE_SERVER'
        ? liveServerConnectionIdFromSourceRef(row.sourceRef)
        : null,
    }))
    .filter((entry): entry is { row: StoredKnowledgeProvenanceRow; nitradoConnId: string } => Boolean(entry.nitradoConnId));
}

async function generatedLiveServerKnowledgeIds(
  guildId: string,
  mirrorRows: readonly { row: StoredKnowledgeProvenanceRow; nitradoConnId: string }[],
): Promise<Set<string>> {
  if (mirrorRows.length === 0) return new Set();
  const candidateIds = [...new Set(mirrorRows.map((entry) => entry.row.knowledgeId))];
  const systemRows = await prisma.guildKnowledge.findMany({
    where: {
      guildId,
      id: { in: candidateIds },
      createdBy: LIVE_SERVER_KNOWLEDGE_CREATED_BY,
    },
    select: { id: true },
  });
  return new Set(systemRows.map((row) => row.id));
}

async function currentGeneratedLiveServerKnowledgeIds(
  guildId: string,
  mirrorRows: readonly { row: StoredKnowledgeProvenanceRow; nitradoConnId: string }[],
  generatedIds: ReadonlySet<string>,
): Promise<Set<string>> {
  const generated = mirrorRows.filter((entry) => generatedIds.has(entry.row.knowledgeId));
  if (generated.length === 0) return new Set();

  const connIds = [...new Set(generated.map((entry) => entry.nitradoConnId))];
  const [connections, bindings] = await Promise.all([
    prisma.nitradoConnection.findMany({
      where: { guildId, id: { in: connIds } },
      select: { id: true, status: true, nitradoServerId: true },
    }),
    prisma.nitradoAdmBindingState.findMany({
      where: { guildId, nitradoConnId: { in: connIds } },
      select: { nitradoConnId: true, bindingVersion: true, currentServiceId: true },
    }),
  ]);
  const connMap = new Map(connections.map((row) => [row.id, row] as const));
  const bindingMap = new Map(bindings.map((row) => [row.nitradoConnId, row] as const));
  const current = new Set<string>();

  for (const entry of generated) {
    const conn = connMap.get(entry.nitradoConnId);
    const binding = bindingMap.get(entry.nitradoConnId);
    const sourceBindingVersion = liveServerBindingVersionFromSourceVersion(entry.row.sourceVersion);
    if (
      conn?.status === 'ACTIVE'
      && Boolean(conn.nitradoServerId)
      && binding
      && binding.currentServiceId === conn.nitradoServerId
      && sourceBindingVersion !== null
      && sourceBindingVersion === binding.bindingVersion
    ) {
      current.add(entry.row.knowledgeId);
    }
  }
  return current;
}

export async function getKnowledgeProvenanceMap(
  guildId: string,
  rows: readonly { id: string; createdAt: Date }[],
  now = new Date(),
): Promise<Map<string, KnowledgeProvenanceMeta>> {
  const stored = await prisma.guildKnowledgeProvenance.findMany({
    where: { guildId },
    select: {
      knowledgeId: true,
      sourceKind: true,
      trustLevel: true,
      sourceRef: true,
      sourceVersion: true,
      observedAt: true,
      validUntil: true,
    },
  });
  const storedMap = new Map(stored.map((row) => [row.knowledgeId, row] as const));

  // Nitrado-1S: Nur vom Mirror systemgenerierte LIVE_SERVER-Zeilen unterliegen
  // dem Binding-Generation-Gate. Legacy/unversionierte, alte, inaktive oder
  // service-fremde Generationen werden vor dem Ranking als EXPIRED behandelt.
  // Owner-curated Knowledge bleibt von dieser Lifecycle-Regel unberuehrt.
  const mirrorRows = mirrorCandidateRows(stored);
  const generatedMirrorIds = await generatedLiveServerKnowledgeIds(guildId, mirrorRows);
  const currentGeneratedLiveIds = await currentGeneratedLiveServerKnowledgeIds(
    guildId,
    mirrorRows,
    generatedMirrorIds,
  );

  const out = new Map<string, KnowledgeProvenanceMeta>();
  for (const row of rows) {
    const hit = storedMap.get(row.id);
    if (!hit) {
      out.set(row.id, legacyKnowledgeProvenance(row.createdAt, now));
      continue;
    }
    const validated = validateKnowledgeProvenance({
      sourceKind: hit.sourceKind,
      trustLevel: hit.trustLevel,
      sourceRef: hit.sourceRef,
      sourceVersion: hit.sourceVersion,
      observedAt: hit.observedAt,
      validUntil: hit.validUntil,
    }, {
      sourceKind: 'OWNER_CURATED',
      trustLevel: 'CURATED',
      observedAt: row.createdAt,
    }, now);
    if (!validated.ok) {
      out.set(row.id, legacyKnowledgeProvenance(row.createdAt, now));
      continue;
    }
    const assessed = assessKnowledgeProvenance(validated.value, now);
    if (generatedMirrorIds.has(row.id) && !currentGeneratedLiveIds.has(row.id)) {
      out.set(row.id, expireLiveServerMeta(assessed));
      continue;
    }
    out.set(row.id, assessed);
  }
  return out;
}
