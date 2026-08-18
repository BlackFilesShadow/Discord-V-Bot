import { createHmac, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import prisma from '../../database/prisma';
import { sanitizeLeaveCleanupError } from './leaveCleanupSecurity';

export const LEAVE_CLEANUP_KIND = 'GUILD_LEAVE_CLEANUP_V1' as const;
export const LEAVE_CLEANUP_MAX_ATTEMPTS = 8;
export const LEAVE_CLEANUP_STALE_MS = 5 * 60_000;
export const LEAVE_CLEANUP_WAIT_MS = 30_000;
const LEAVE_JOB_PREFIX = 'leave-job:v1:';
const RECEIPT_PREFIX = 'leave-receipt:v1:';

export type LeaveCleanupStage = 'QUEUED' | 'RUNNING' | 'RETRY_WAIT' | 'COMPLETED' | 'DEAD';
export type LeaveCleanupStep = 'WHITELIST' | 'STATS_SESSIONS' | 'LINK_ECONOMY' | 'GUILD_DATA' | 'COMPLETE';

export interface LeaveCleanupDetails {
  kind: typeof LEAVE_CLEANUP_KIND;
  guildId: string;
  step: LeaveCleanupStep;
  stage: LeaveCleanupStage;
  attempts: number;
  maxAttempts: number;
  claimedAt?: string;
  claimToken?: string;
  lastError?: string;
  completedAt?: string;
}

export interface LeaveCleanupRequestLike {
  id: string;
  userId: string;
  discordId: string;
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  scheduledAt: Date;
  details: unknown;
}

const NEXT_STEP: Record<Exclude<LeaveCleanupStep, 'COMPLETE'>, LeaveCleanupStep> = {
  WHITELIST: 'STATS_SESSIONS',
  STATS_SESSIONS: 'LINK_ECONOMY',
  LINK_ECONOMY: 'GUILD_DATA',
  GUILD_DATA: 'COMPLETE',
};

function cleanSnowflake(value: string, label: string): string {
  const trimmed = value.trim();
  if (!/^\d{17,20}$/.test(trimmed)) throw new Error(`${label} muss eine Discord-Snowflake sein.`);
  return trimmed;
}

function safeError(error: unknown): string {
  return sanitizeLeaveCleanupError(error).slice(0, 1000);
}

/**
 * Parser fuer persistierte Saga-Metadaten. Alte Leave-1A-Requests besitzen
 * noch keinen `step`; diese werden absichtlich als WHITELIST fortgesetzt.
 */
export function readLeaveCleanupDetails(value: unknown): LeaveCleanupDetails | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Partial<LeaveCleanupDetails>;
  if (row.kind !== LEAVE_CLEANUP_KIND || typeof row.guildId !== 'string') return null;
  const attempts = Number.isInteger(row.attempts) && Number(row.attempts) >= 0 ? Number(row.attempts) : 0;
  const maxAttempts = Number.isInteger(row.maxAttempts) && Number(row.maxAttempts) > 0
    ? Number(row.maxAttempts)
    : LEAVE_CLEANUP_MAX_ATTEMPTS;
  const allowedStages: LeaveCleanupStage[] = ['QUEUED', 'RUNNING', 'RETRY_WAIT', 'COMPLETED', 'DEAD'];
  const allowedSteps: LeaveCleanupStep[] = ['WHITELIST', 'STATS_SESSIONS', 'LINK_ECONOMY', 'GUILD_DATA', 'COMPLETE'];
  const stage = allowedStages.includes(row.stage as LeaveCleanupStage) ? row.stage as LeaveCleanupStage : 'QUEUED';
  const step = allowedSteps.includes(row.step as LeaveCleanupStep) ? row.step as LeaveCleanupStep : 'WHITELIST';
  return {
    kind: LEAVE_CLEANUP_KIND,
    guildId: row.guildId,
    step,
    stage,
    attempts,
    maxAttempts,
    ...(typeof row.claimedAt === 'string' ? { claimedAt: row.claimedAt } : {}),
    ...(typeof row.claimToken === 'string' ? { claimToken: row.claimToken } : {}),
    ...(typeof row.lastError === 'string' ? { lastError: row.lastError } : {}),
    ...(typeof row.completedAt === 'string' ? { completedAt: row.completedAt } : {}),
  };
}

/** Prisma-JSON darf keine `undefined`-Werte enthalten. */
function detailsJson(details: LeaveCleanupDetails): Prisma.InputJsonObject {
  return {
    kind: details.kind,
    guildId: details.guildId,
    step: details.step,
    stage: details.stage,
    attempts: details.attempts,
    maxAttempts: details.maxAttempts,
    ...(details.claimedAt ? { claimedAt: details.claimedAt } : {}),
    ...(details.claimToken ? { claimToken: details.claimToken } : {}),
    ...(details.lastError ? { lastError: details.lastError } : {}),
    ...(details.completedAt ? { completedAt: details.completedAt } : {}),
  };
}

function withoutClaim(details: LeaveCleanupDetails): LeaveCleanupDetails {
  const { claimedAt: _claimedAt, claimToken: _claimToken, ...rest } = details;
  return rest;
}

function withoutLastError(details: LeaveCleanupDetails): LeaveCleanupDetails {
  const { lastError: _lastError, ...rest } = details;
  return rest;
}

/**
 * Fencing-CAS fuer einen aktiven Claim. Neue Claims tragen einen zufaelligen
 * Token. Bereits vor Leave-1F laufende Legacy-Claims werden bis zum naechsten
 * Reclaim sicher ueber ihren persistierten claimedAt-Wert gefenced.
 */
function claimFence(details: LeaveCleanupDetails): Prisma.DataDeletionRequestWhereInput {
  if (details.claimToken) {
    return { details: { path: ['claimToken'], equals: details.claimToken } };
  }
  if (details.claimedAt) {
    return { details: { path: ['claimedAt'], equals: details.claimedAt } };
  }
  throw new Error('Leave-Cleanup Claim-Fence fehlt.');
}

/**
 * Recovery braucht neben dem stabilen Claim-Token auch exakt den gelesenen
 * Lease-Zeitstempel. Sonst koennte ein alter Recovery-Snapshot eine gerade
 * durch einen erfolgreichen Checkpoint erneuerte Lease dennoch zurueckholen.
 */
function recoveryClaimFence(details: LeaveCleanupDetails): Prisma.DataDeletionRequestWhereInput {
  if (details.claimToken) {
    if (!details.claimedAt) throw new Error('Leave-Cleanup Claim-Zeitstempel fehlt.');
    return {
      AND: [
        { details: { path: ['claimToken'], equals: details.claimToken } },
        { details: { path: ['claimedAt'], equals: details.claimedAt } },
      ],
    };
  }
  return claimFence(details);
}

/** Deterministischer Job-Key nur waehrend der noch offenen Verarbeitung. */
export function leaveCleanupJobKey(guildId: string, discordId: string): string {
  return `${LEAVE_JOB_PREFIX}${cleanSnowflake(guildId, 'guildId')}:${cleanSnowflake(discordId, 'discordId')}`;
}

/**
 * Pseudonymer Abschlussbeleg. Nach erfolgreicher Komplettloeschung koennen die
 * rohen Discord-IDs im DeletionRequest durch diesen HMAC ersetzt werden.
 */
export function leaveCleanupReceiptFingerprint(guildId: string, discordId: string, secret: string): string {
  const scopeGuild = cleanSnowflake(guildId, 'guildId');
  const user = cleanSnowflake(discordId, 'discordId');
  if (secret.length < 32) throw new Error('Leave-Cleanup-HMAC-Secret ist zu kurz.');
  const digest = createHmac('sha256', secret)
    .update(`guild-leave-reset:v1:${scopeGuild}:${user}`)
    .digest('hex');
  return `${RECEIPT_PREFIX}${digest}`;
}

function hasValidRawScope(userId: string, discordId: string, details: LeaveCleanupDetails): boolean {
  try {
    return userId === leaveCleanupJobKey(details.guildId, discordId);
  } catch {
    return false;
  }
}

/** Multi-Process-race-safe Enqueue unter transaction-scoped Advisory-Lock. */
export async function enqueueLeaveCleanupRequest(args: {
  guildId: string;
  discordId: string;
  now?: Date;
  maxAttempts?: number;
}): Promise<{ id: string; created: boolean }> {
  const now = args.now ?? new Date();
  const guildId = cleanSnowflake(args.guildId, 'guildId');
  const discordId = cleanSnowflake(args.discordId, 'discordId');
  const key = leaveCleanupJobKey(guildId, discordId);
  const maxAttempts = Math.max(1, Math.min(32, Math.trunc(args.maxAttempts ?? LEAVE_CLEANUP_MAX_ATTEMPTS)));

  return prisma.$transaction(async tx => {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    const existing = await tx.dataDeletionRequest.findFirst({
      where: {
        userId: key,
        requestType: 'PARTIAL_DELETION',
        status: { in: ['PENDING', 'IN_PROGRESS', 'FAILED'] },
      },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) return { id: existing.id, created: false };

    const details: LeaveCleanupDetails = {
      kind: LEAVE_CLEANUP_KIND,
      guildId,
      step: 'WHITELIST',
      stage: 'QUEUED',
      attempts: 0,
      maxAttempts,
    };
    const created = await tx.dataDeletionRequest.create({
      data: {
        userId: key,
        discordId,
        requestType: 'PARTIAL_DELETION',
        status: 'PENDING',
        scheduledAt: now,
        details: detailsJson(details),
      },
      select: { id: true },
    });
    return { id: created.id, created: true };
  });
}

/** CAS-Claim: mehrere Worker duerfen lesen, aber nur einer gewinnt. */
export async function claimNextLeaveCleanupRequest(now: Date = new Date()): Promise<LeaveCleanupRequestLike | null> {
  for (let spin = 0; spin < 5; spin++) {
    const candidate = await prisma.dataDeletionRequest.findFirst({
      where: {
        userId: { startsWith: LEAVE_JOB_PREFIX },
        requestType: 'PARTIAL_DELETION',
        status: 'PENDING',
        scheduledAt: { lte: now },
      },
      orderBy: [{ scheduledAt: 'asc' }, { createdAt: 'asc' }],
    });
    if (!candidate) return null;
    const details = readLeaveCleanupDetails(candidate.details);
    if (!details || !hasValidRawScope(candidate.userId, candidate.discordId, details)) {
      const invalidDetails: LeaveCleanupDetails = {
        kind: LEAVE_CLEANUP_KIND,
        guildId: details?.guildId ?? 'invalid',
        step: details?.step ?? 'WHITELIST',
        stage: 'DEAD',
        attempts: details?.attempts ?? 0,
        maxAttempts: details?.maxAttempts ?? 1,
        lastError: 'Ungueltige Leave-Cleanup-Metadaten oder Scope-Zuordnung.',
      };
      await prisma.dataDeletionRequest.updateMany({
        where: { id: candidate.id, status: 'PENDING' },
        data: { status: 'FAILED', details: detailsJson(invalidDetails) },
      });
      continue;
    }

    const claimedDetails: LeaveCleanupDetails = {
      ...withoutLastError(withoutClaim(details)),
      stage: 'RUNNING',
      claimedAt: now.toISOString(),
      claimToken: randomUUID(),
    };
    const claim = await prisma.dataDeletionRequest.updateMany({
      where: { id: candidate.id, status: 'PENDING' },
      data: { status: 'IN_PROGRESS', details: detailsJson(claimedDetails) },
    });
    if (claim.count !== 1) continue;
    return {
      id: candidate.id,
      userId: candidate.userId,
      discordId: candidate.discordId,
      status: 'IN_PROGRESS',
      scheduledAt: candidate.scheduledAt,
      details: claimedDetails,
    };
  }
  return null;
}

/** Restart-/Failover-Recovery fuer abgestorbene Claims. */
export async function recoverStaleLeaveCleanupRequests(
  now: Date = new Date(),
  staleMs: number = LEAVE_CLEANUP_STALE_MS,
): Promise<number> {
  const batchSize = 500;
  let lastId: string | null = null;
  let recovered = 0;

  for (;;) {
    const rows: Array<{ id: string; details: unknown }> = await prisma.dataDeletionRequest.findMany({
      where: {
        userId: { startsWith: LEAVE_JOB_PREFIX },
        requestType: 'PARTIAL_DELETION',
        status: 'IN_PROGRESS',
        ...(lastId ? { id: { gt: lastId } } : {}),
      },
      orderBy: { id: 'asc' },
      take: batchSize,
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      const details = readLeaveCleanupDetails(row.details);
      const claimedAt = details?.claimedAt ? Date.parse(details.claimedAt) : Number.NaN;
      if (!details || !Number.isFinite(claimedAt) || now.getTime() - claimedAt < staleMs) continue;
      const recoveredDetails: LeaveCleanupDetails = {
        ...withoutClaim(details),
        stage: 'QUEUED',
        lastError: 'Stale Claim nach Restart/Failover wieder freigegeben.',
      };
      const result = await prisma.dataDeletionRequest.updateMany({
        where: { id: row.id, status: 'IN_PROGRESS', ...recoveryClaimFence(details) },
        data: {
          status: 'PENDING',
          scheduledAt: now,
          details: detailsJson(recoveredDetails),
        },
      });
      recovered += result.count;
    }

    lastId = rows[rows.length - 1]?.id ?? null;
    if (rows.length < batchSize || !lastId) break;
  }

  return recovered;
}

export function leaveCleanupBackoffMs(attempt: number): number {
  const safeAttempt = Math.max(1, Math.trunc(attempt));
  return Math.min(60 * 60_000, 5_000 * 2 ** Math.min(safeAttempt - 1, 10));
}

/**
 * Persistiert einen erfolgreich abgeschlossenen Substep und erneuert zugleich
 * den Lease-Zeitstempel. Der Claim-Token bleibt stabil, aber Recovery darf den
 * Request danach erst wieder relativ zu diesem neuen Fortschrittszeitpunkt als
 * stale betrachten.
 */
export async function advanceLeaveCleanupStep(
  request: LeaveCleanupRequestLike,
  expectedStep: Exclude<LeaveCleanupStep, 'COMPLETE'>,
  now: Date = new Date(),
): Promise<LeaveCleanupRequestLike> {
  const details = readLeaveCleanupDetails(request.details);
  if (!details || details.step !== expectedStep) {
    throw new Error(`Leave-Cleanup Step-CAS ungueltig; erwartet ${expectedStep}.`);
  }
  const nextStep = NEXT_STEP[expectedStep];
  const nextDetails: LeaveCleanupDetails = {
    ...withoutLastError(details),
    step: nextStep,
    stage: 'RUNNING',
    claimedAt: now.toISOString(),
  };
  const result = await prisma.dataDeletionRequest.updateMany({
    where: { id: request.id, status: 'IN_PROGRESS', userId: request.userId, ...claimFence(details) },
    data: { details: detailsJson(nextDetails) },
  });
  if (result.count !== 1) throw new Error('Leave-Cleanup Step-CAS verloren.');
  return { ...request, details: nextDetails };
}

/**
 * Erwartbares WAITING (Remote-Whitelist, offene Session, aktive Lottery) wird
 * ohne Retry-Verbrauch verschoben. So fuehren normale externe Wartezustaende
 * niemals allein ins Dead-Letter.
 */
export async function deferLeaveCleanupRequest(
  request: LeaveCleanupRequestLike,
  reason: unknown,
  now: Date = new Date(),
  delayMs: number = LEAVE_CLEANUP_WAIT_MS,
): Promise<void> {
  const details = readLeaveCleanupDetails(request.details);
  if (!details) throw new Error('Leave-Cleanup-Request hat ungueltige Metadaten.');
  const safeDelay = Math.max(5_000, Math.min(60 * 60_000, Math.trunc(delayMs)));
  const nextDetails: LeaveCleanupDetails = {
    ...withoutClaim(details),
    stage: 'RETRY_WAIT',
    lastError: safeError(reason),
  };
  const result = await prisma.dataDeletionRequest.updateMany({
    where: { id: request.id, status: 'IN_PROGRESS', userId: request.userId, ...claimFence(details) },
    data: {
      status: 'PENDING',
      scheduledAt: new Date(now.getTime() + safeDelay),
      details: detailsJson(nextDetails),
    },
  });
  if (result.count !== 1) throw new Error('Leave-Cleanup Defer-CAS verloren.');
}

/** Retry/Dead-Letter nur fuer echte Fehler, nicht fuer normale WAITING-Zustaende. */
export async function retryOrDeadLetterLeaveCleanupRequest(
  request: LeaveCleanupRequestLike,
  error: unknown,
  now: Date = new Date(),
): Promise<'RETRY' | 'DEAD'> {
  const details = readLeaveCleanupDetails(request.details);
  if (!details) throw new Error('Leave-Cleanup-Request hat ungueltige Metadaten.');
  const attempts = details.attempts + 1;
  const lastError = safeError(error);
  const dead = attempts >= details.maxAttempts;
  const nextDetails: LeaveCleanupDetails = {
    ...withoutClaim(details),
    attempts,
    stage: dead ? 'DEAD' : 'RETRY_WAIT',
    lastError,
  };
  const result = await prisma.dataDeletionRequest.updateMany({
    where: { id: request.id, status: 'IN_PROGRESS', userId: request.userId, ...claimFence(details) },
    data: dead
      ? { status: 'FAILED', details: detailsJson(nextDetails) }
      : {
          status: 'PENDING',
          scheduledAt: new Date(now.getTime() + leaveCleanupBackoffMs(attempts)),
          details: detailsJson(nextDetails),
        },
  });
  if (result.count !== 1) throw new Error('Leave-Cleanup Retry-CAS verloren.');
  return dead ? 'DEAD' : 'RETRY';
}

/**
 * Abschluss anonymisiert die rohe Discord-ID. Er ist nur nach persistiertem
 * COMPLETE-Checkpoint erlaubt, damit kein Teilcleanup als Erfolg quittiert wird.
 */
export async function completeLeaveCleanupRequest(
  request: LeaveCleanupRequestLike,
  guildId: string,
  secret: string,
  now: Date = new Date(),
): Promise<string> {
  const details = readLeaveCleanupDetails(request.details);
  const scopedGuildId = cleanSnowflake(guildId, 'guildId');
  if (!details || details.guildId !== scopedGuildId) {
    throw new Error('Leave-Cleanup Guild-Scope stimmt nicht mit Request ueberein.');
  }
  if (details.step !== 'COMPLETE') {
    throw new Error(`Leave-Cleanup darf in Step ${details.step} nicht abgeschlossen werden.`);
  }
  const fingerprint = leaveCleanupReceiptFingerprint(scopedGuildId, request.discordId, secret);
  const completedDetails: LeaveCleanupDetails = {
    ...withoutLastError(withoutClaim(details)),
    stage: 'COMPLETED',
    completedAt: now.toISOString(),
  };
  const result = await prisma.dataDeletionRequest.updateMany({
    where: { id: request.id, status: 'IN_PROGRESS', userId: request.userId, ...claimFence(details) },
    data: {
      status: 'COMPLETED',
      completedAt: now,
      userId: fingerprint,
      discordId: fingerprint,
      details: detailsJson(completedDetails),
    },
  });
  if (result.count !== 1) throw new Error('Leave-Cleanup Completion-CAS verloren.');
  return fingerprint;
}

export async function hasCompletedLeaveCleanupReceipt(
  guildId: string,
  discordId: string,
  secret: string,
): Promise<boolean> {
  const fingerprint = leaveCleanupReceiptFingerprint(guildId, discordId, secret);
  const row = await prisma.dataDeletionRequest.findFirst({
    where: {
      userId: fingerprint,
      discordId: fingerprint,
      requestType: 'PARTIAL_DELETION',
      status: 'COMPLETED',
    },
    select: { id: true },
  });
  return !!row;
}
