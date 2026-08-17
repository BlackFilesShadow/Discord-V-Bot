import { createHmac } from 'node:crypto';
import prisma from '../../database/prisma';

/**
 * Leave-1A — interne, persistente Grundlage fuer den spaeteren Guild-Leave-Reset.
 *
 * WICHTIG: Diese Etappe wird absichtlich noch NICHT aus guildMemberRemove
 * aufgerufen. Erst wenn Whitelist/Nitrado, Linking, Economy und Stats als
 * vollstaendige Saga-Schritte implementiert und getestet sind, darf der
 * Dashboard-Toggle den Enqueue-Pfad freischalten.
 *
 * Die bestehende DataDeletionRequest-Tabelle ist die kanonische persistente
 * Deletion-Queue. Dadurch entsteht keine zweite konkurrierende Job-Infrastruktur.
 */

export const LEAVE_CLEANUP_KIND = 'GUILD_LEAVE_CLEANUP_V1' as const;
export const LEAVE_CLEANUP_MAX_ATTEMPTS = 8;
export const LEAVE_CLEANUP_STALE_MS = 5 * 60_000;
const LEAVE_JOB_PREFIX = 'leave-job:v1:';
const RECEIPT_PREFIX = 'leave-receipt:v1:';

export type LeaveCleanupStage = 'QUEUED' | 'RUNNING' | 'RETRY_WAIT' | 'COMPLETED' | 'DEAD';

export interface LeaveCleanupDetails {
  kind: typeof LEAVE_CLEANUP_KIND;
  guildId: string;
  stage: LeaveCleanupStage;
  attempts: number;
  maxAttempts: number;
  claimedAt?: string;
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

function cleanSnowflake(value: string, label: string): string {
  const trimmed = value.trim();
  if (!/^\d{17,20}$/.test(trimmed)) throw new Error(`${label} muss eine Discord-Snowflake sein.`);
  return trimmed;
}

function safeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/[\r\n\t]+/g, ' ').slice(0, 1000);
}

function asDetails(value: unknown): LeaveCleanupDetails | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Partial<LeaveCleanupDetails>;
  if (row.kind !== LEAVE_CLEANUP_KIND || typeof row.guildId !== 'string') return null;
  const attempts = Number.isInteger(row.attempts) && Number(row.attempts) >= 0 ? Number(row.attempts) : 0;
  const maxAttempts = Number.isInteger(row.maxAttempts) && Number(row.maxAttempts) > 0
    ? Number(row.maxAttempts)
    : LEAVE_CLEANUP_MAX_ATTEMPTS;
  const allowedStages: LeaveCleanupStage[] = ['QUEUED', 'RUNNING', 'RETRY_WAIT', 'COMPLETED', 'DEAD'];
  const stage = allowedStages.includes(row.stage as LeaveCleanupStage) ? row.stage as LeaveCleanupStage : 'QUEUED';
  return {
    kind: LEAVE_CLEANUP_KIND,
    guildId: row.guildId,
    stage,
    attempts,
    maxAttempts,
    ...(typeof row.claimedAt === 'string' ? { claimedAt: row.claimedAt } : {}),
    ...(typeof row.lastError === 'string' ? { lastError: row.lastError } : {}),
    ...(typeof row.completedAt === 'string' ? { completedAt: row.completedAt } : {}),
  };
}

/** Deterministischer Job-Key nur waehrend der noch offenen Verarbeitung. */
export function leaveCleanupJobKey(guildId: string, discordId: string): string {
  return `${LEAVE_JOB_PREFIX}${cleanSnowflake(guildId, 'guildId')}:${cleanSnowflake(discordId, 'discordId')}`;
}

/**
 * Pseudonymer Abschlussbeleg. Nach erfolgreicher Komplettloeschung koennen die
 * rohen Discord-IDs im DeletionRequest durch diesen HMAC ersetzt werden.
 * Der Guild-Scope ist Bestandteil des HMAC und verhindert Cross-Guild-Linkage.
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

/**
 * Enqueue ist race-safe auf Anwendungsebene: ein offener Request pro
 * Guild+Discord-ID wird wiederverwendet. Der eigentliche Leave-Event-Wiring-Pfad
 * folgt erst in einer spaeteren Etappe.
 */
export async function enqueueLeaveCleanupRequest(args: {
  guildId: string;
  discordId: string;
  now?: Date;
  maxAttempts?: number;
}): Promise<{ id: string; created: boolean }> {
  const now = args.now ?? new Date();
  const key = leaveCleanupJobKey(args.guildId, args.discordId);
  const existing = await prisma.dataDeletionRequest.findFirst({
    where: {
      userId: key,
      requestType: 'PARTIAL_DELETION',
      status: { in: ['PENDING', 'IN_PROGRESS'] },
    },
    select: { id: true },
    orderBy: { createdAt: 'desc' },
  });
  if (existing) return { id: existing.id, created: false };

  const maxAttempts = Math.max(1, Math.min(32, Math.trunc(args.maxAttempts ?? LEAVE_CLEANUP_MAX_ATTEMPTS)));
  const created = await prisma.dataDeletionRequest.create({
    data: {
      userId: key,
      discordId: cleanSnowflake(args.discordId, 'discordId'),
      requestType: 'PARTIAL_DELETION',
      status: 'PENDING',
      scheduledAt: now,
      details: {
        kind: LEAVE_CLEANUP_KIND,
        guildId: cleanSnowflake(args.guildId, 'guildId'),
        stage: 'QUEUED',
        attempts: 0,
        maxAttempts,
      },
    },
    select: { id: true },
  });
  return { id: created.id, created: true };
}

/**
 * CAS-Claim: mehrere Worker duerfen denselben Kandidaten lesen, aber nur einer
 * darf PENDING -> IN_PROGRESS gewinnen.
 */
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
    const details = asDetails(candidate.details);
    if (!details) {
      await prisma.dataDeletionRequest.updateMany({
        where: { id: candidate.id, status: 'PENDING' },
        data: { status: 'FAILED', details: { kind: LEAVE_CLEANUP_KIND, guildId: 'invalid', stage: 'DEAD', attempts: 0, maxAttempts: 1, lastError: 'Ungueltige Leave-Cleanup-Metadaten.' } },
      });
      continue;
    }

    const claimedDetails: LeaveCleanupDetails = {
      ...details,
      stage: 'RUNNING',
      claimedAt: now.toISOString(),
      lastError: undefined,
    };
    const claim = await prisma.dataDeletionRequest.updateMany({
      where: { id: candidate.id, status: 'PENDING' },
      data: { status: 'IN_PROGRESS', details: claimedDetails as unknown as object },
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

/** Restart-Recovery fuer vor Prozessabbruch haengengebliebene Claims. */
export async function recoverStaleLeaveCleanupRequests(
  now: Date = new Date(),
  staleMs: number = LEAVE_CLEANUP_STALE_MS,
): Promise<number> {
  const rows = await prisma.dataDeletionRequest.findMany({
    where: {
      userId: { startsWith: LEAVE_JOB_PREFIX },
      requestType: 'PARTIAL_DELETION',
      status: 'IN_PROGRESS',
    },
    take: 500,
  });
  let recovered = 0;
  for (const row of rows) {
    const details = asDetails(row.details);
    const claimedAt = details?.claimedAt ? Date.parse(details.claimedAt) : Number.NaN;
    if (!details || !Number.isFinite(claimedAt) || now.getTime() - claimedAt < staleMs) continue;
    const result = await prisma.dataDeletionRequest.updateMany({
      where: { id: row.id, status: 'IN_PROGRESS' },
      data: {
        status: 'PENDING',
        scheduledAt: now,
        details: { ...details, stage: 'QUEUED', claimedAt: undefined, lastError: 'Stale Claim nach Restart wieder freigegeben.' } as unknown as object,
      },
    });
    recovered += result.count;
  }
  return recovered;
}

export function leaveCleanupBackoffMs(attempt: number): number {
  const safeAttempt = Math.max(1, Math.trunc(attempt));
  return Math.min(60 * 60_000, 5_000 * 2 ** Math.min(safeAttempt - 1, 10));
}

/** Retry/Dead-Letter-Transition nach einem fehlgeschlagenen Saga-Schritt. */
export async function retryOrDeadLetterLeaveCleanupRequest(
  request: LeaveCleanupRequestLike,
  error: unknown,
  now: Date = new Date(),
): Promise<'RETRY' | 'DEAD'> {
  const details = asDetails(request.details);
  if (!details) throw new Error('Leave-Cleanup-Request hat ungueltige Metadaten.');
  const attempts = details.attempts + 1;
  const lastError = safeError(error);
  const dead = attempts >= details.maxAttempts;
  const nextDetails: LeaveCleanupDetails = {
    ...details,
    attempts,
    stage: dead ? 'DEAD' : 'RETRY_WAIT',
    claimedAt: undefined,
    lastError,
  };
  const result = await prisma.dataDeletionRequest.updateMany({
    where: { id: request.id, status: 'IN_PROGRESS' },
    data: dead
      ? { status: 'FAILED', details: nextDetails as unknown as object }
      : {
          status: 'PENDING',
          scheduledAt: new Date(now.getTime() + leaveCleanupBackoffMs(attempts)),
          details: nextDetails as unknown as object,
        },
  });
  if (result.count !== 1) throw new Error('Leave-Cleanup Retry-CAS verloren.');
  return dead ? 'DEAD' : 'RETRY';
}

/**
 * Abschluss anonymisiert die fuer die Verarbeitung benoetigte rohe Discord-ID.
 * Der pseudonyme Receipt bleibt fuer spaetere Anti-Churn-Pruefungen erhalten.
 */
export async function completeLeaveCleanupRequest(
  request: LeaveCleanupRequestLike,
  guildId: string,
  secret: string,
  now: Date = new Date(),
): Promise<string> {
  const details = asDetails(request.details);
  if (!details || details.guildId !== cleanSnowflake(guildId, 'guildId')) {
    throw new Error('Leave-Cleanup Guild-Scope stimmt nicht mit Request ueberein.');
  }
  const fingerprint = leaveCleanupReceiptFingerprint(guildId, request.discordId, secret);
  const completedDetails: LeaveCleanupDetails = {
    ...details,
    stage: 'COMPLETED',
    claimedAt: undefined,
    completedAt: now.toISOString(),
    lastError: undefined,
  };
  const result = await prisma.dataDeletionRequest.updateMany({
    where: { id: request.id, status: 'IN_PROGRESS', userId: request.userId },
    data: {
      status: 'COMPLETED',
      completedAt: now,
      userId: fingerprint,
      discordId: fingerprint,
      details: completedDetails as unknown as object,
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
