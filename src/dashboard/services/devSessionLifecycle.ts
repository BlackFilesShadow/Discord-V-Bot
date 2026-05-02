/**
 * P1 — DevSession Lifecycle Service.
 *
 * Liefert vier Bausteine:
 *   1. cleanupExpiredDevSessions()    — markiert abgelaufene Sessions als
 *                                       revoked und loescht revoked >7d hart
 *   2. startDevSessionCleanupTimer()  — stuendlicher Cron (analog zu
 *                                       startDevUploadCleanupTimer)
 *   3. maybeAutoExtendDevSession()    — verlaengert eine aktive Session bei
 *                                       Activity, gedeckelt durch
 *                                       MAX_TOTAL_LIFETIME_MS
 *   4. forceRevokeDevSession()        — Admin-Force-Revoke mit Audit
 *
 * Alle Mutationen schreiben SECURITY-Audit-Eintraege.
 *
 * Caps & Defaults (ueberschreibbar via env):
 *   - DEV_SESSION_AUTO_EXTEND_THRESHOLD_MS   default 15min
 *   - DEV_SESSION_AUTO_EXTEND_STEP_MS        default 30min
 *   - DEV_SESSION_MAX_LIFETIME_MS            default 4h
 *   - DEV_SESSION_HARD_DELETE_AFTER_MS       default 7d
 */

import prisma from '../../database/prisma';
import { logger, logAudit, logAuditDb } from '../../utils/logger';

// --- Konfiguration --------------------------------------------------------

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;
const DAY = 24 * HOUR;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const SESSION_AUTO_EXTEND_THRESHOLD_MS = envInt('DEV_SESSION_AUTO_EXTEND_THRESHOLD_MS', 15 * MIN);
export const SESSION_AUTO_EXTEND_STEP_MS = envInt('DEV_SESSION_AUTO_EXTEND_STEP_MS', 30 * MIN);
export const SESSION_MAX_LIFETIME_MS = envInt('DEV_SESSION_MAX_LIFETIME_MS', 4 * HOUR);
export const SESSION_HARD_DELETE_AFTER_MS = envInt('DEV_SESSION_HARD_DELETE_AFTER_MS', 7 * DAY);

// --- 1) Cleanup -----------------------------------------------------------

export interface CleanupResult {
  expired: number;       // abgelaufen markiert (revokedAt = expiresAt)
  hardDeleted: number;   // > Retention hart geloescht
}

/**
 * Markiert abgelaufene aber noch aktive Sessions als revoked (mit
 * revokedAt = expiresAt, damit Forensik die natuerliche Endzeit sieht)
 * und loescht Sessions, deren revokedAt aelter als die Retention ist.
 */
export async function cleanupExpiredDevSessions(now: Date = new Date()): Promise<CleanupResult> {
  // 1) Soft: abgelaufene aktive Sessions revoken.
   
  const expiredCandidates = await prisma.devSession.findMany({
    where: { revokedAt: null, expiresAt: { lt: now } },
    select: { id: true, expiresAt: true, userDiscordId: true },
    take: 500,
  });
  let expired = 0;
  for (const s of expiredCandidates) {
     
    const r = await prisma.devSession.updateMany({
      where: { id: s.id, revokedAt: null },
      data: { revokedAt: s.expiresAt },
    });
    if (r.count > 0) {
      expired += r.count;
      logAuditDb('DEV_SESSION_AUTO_REVOKED', 'SECURITY', {
        actorUserId: null,
        details: { sessionId: s.id, userDiscordId: s.userDiscordId, reason: 'expired', expiresAt: s.expiresAt.toISOString() },
      });
    }
  }

  // 2) Hard: revoked Sessions aelter als Retention loeschen.
  const cutoff = new Date(now.getTime() - SESSION_HARD_DELETE_AFTER_MS);
   
  const oldRevoked = await prisma.devSession.findMany({
    where: { revokedAt: { not: null, lt: cutoff } },
    select: { id: true, userDiscordId: true, revokedAt: true },
    take: 500,
  });
  let hardDeleted = 0;
  for (const s of oldRevoked) {
     
    await prisma.devSession.delete({ where: { id: s.id } }).catch((e: unknown) => {
      logger.warn('cleanupExpiredDevSessions: delete failed', { id: s.id, err: (e as Error).message });
    });
    hardDeleted++;
    logAuditDb('DEV_SESSION_HARD_DELETED', 'SECURITY', {
      actorUserId: null,
      details: { sessionId: s.id, userDiscordId: s.userDiscordId, retentionMs: SESSION_HARD_DELETE_AFTER_MS },
    });
  }

  if (expired > 0 || hardDeleted > 0) {
    logger.info('[DevSession] cleanup', { expired, hardDeleted });
  }
  return { expired, hardDeleted };
}

/**
 * Startet einen stuendlichen Cleanup-Cron (1h Intervall) und stoesst
 * den ersten Lauf nach 60s an, um den Boot nicht zu blockieren.
 */
export function startDevSessionCleanupTimer(): NodeJS.Timeout {
  const tick = (): void => {
    cleanupExpiredDevSessions().catch((e: unknown) => {
      logger.error('[DevSession] cleanup error:', e as Error);
    });
  };
  const id = setInterval(tick, HOUR);
  setTimeout(tick, 60_000);
  return id;
}

// --- 2) Auto-Extension bei Activity ---------------------------------------

export interface AutoExtendInput {
  id: string;
  createdAt: Date;
  expiresAt: Date;
  userDiscordId: string;
}

export interface AutoExtendResult {
  extended: boolean;
  newExpiresAt: Date;
  reason?: 'within_threshold' | 'capped' | 'no_window';
}

/**
 * Verlaengert eine Session, wenn sie binnen `SESSION_AUTO_EXTEND_THRESHOLD_MS`
 * ablaeuft. Cap: Die Gesamtlebensdauer (createdAt..neuExpiresAt) darf
 * `SESSION_MAX_LIFETIME_MS` nicht ueberschreiten.
 *
 * Side-Effect-frei wenn keine Verlaengerung noetig ist (returnt extended=false).
 */
export async function maybeAutoExtendDevSession(
  s: AutoExtendInput,
  now: Date = new Date(),
): Promise<AutoExtendResult> {
  const remaining = s.expiresAt.getTime() - now.getTime();
  if (remaining > SESSION_AUTO_EXTEND_THRESHOLD_MS) {
    return { extended: false, newExpiresAt: s.expiresAt, reason: 'no_window' };
  }
  const hardCap = new Date(s.createdAt.getTime() + SESSION_MAX_LIFETIME_MS);
  if (s.expiresAt.getTime() >= hardCap.getTime()) {
    return { extended: false, newExpiresAt: s.expiresAt, reason: 'capped' };
  }
  const proposed = new Date(s.expiresAt.getTime() + SESSION_AUTO_EXTEND_STEP_MS);
  const newExpiresAt = proposed.getTime() > hardCap.getTime() ? hardCap : proposed;

   
  const r = await prisma.devSession.updateMany({
    where: { id: s.id, revokedAt: null, expiresAt: { gt: now } },
    data: { expiresAt: newExpiresAt },
  });
  if (r.count === 0) {
    // Race: Session wurde inzwischen revoked oder lief ab.
    return { extended: false, newExpiresAt: s.expiresAt };
  }
  logAuditDb('DEV_SESSION_EXTENDED', 'SECURITY', {
    actorUserId: null,
    details: {
      sessionId: s.id,
      userDiscordId: s.userDiscordId,
      previousExpiresAt: s.expiresAt.toISOString(),
      newExpiresAt: newExpiresAt.toISOString(),
      capReached: newExpiresAt.getTime() === hardCap.getTime(),
    },
  });
  return { extended: true, newExpiresAt, reason: 'within_threshold' };
}

// --- 3) Force-Revoke (Admin) ----------------------------------------------

export interface ForceRevokeInput {
  sessionId: string;
  byUserId: string;
  byDiscordId: string;
  reason: string;
  ip?: string | null;
}

export interface ForceRevokeResult {
  ok: boolean;
  revoked: number;
  error?: 'not_found' | 'already_revoked' | 'reason_too_short';
}

const FORCE_REVOKE_REASON_MIN = 6;

export async function forceRevokeDevSession(input: ForceRevokeInput): Promise<ForceRevokeResult> {
  const reason = (input.reason ?? '').trim();
  if (reason.length < FORCE_REVOKE_REASON_MIN) {
    return { ok: false, revoked: 0, error: 'reason_too_short' };
  }
   
  const session = await prisma.devSession.findUnique({
    where: { id: input.sessionId },
    select: { id: true, userDiscordId: true, revokedAt: true, expiresAt: true },
  });
  if (!session) return { ok: false, revoked: 0, error: 'not_found' };
  if (session.revokedAt) return { ok: false, revoked: 0, error: 'already_revoked' };

   
  const r = await prisma.devSession.updateMany({
    where: { id: input.sessionId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (r.count === 0) return { ok: false, revoked: 0, error: 'already_revoked' };

  logAudit('DEV_SESSION_FORCE_REVOKED', 'SECURITY', {
    actorUserId: input.byUserId, ip: input.ip ?? null,
    sessionId: input.sessionId, targetUserDiscordId: session.userDiscordId, reason,
  });
  logAuditDb('DEV_SESSION_FORCE_REVOKED', 'SECURITY', {
    actorUserId: input.byUserId,
    details: {
      sessionId: input.sessionId,
      targetUserDiscordId: session.userDiscordId,
      reason,
      byDiscordId: input.byDiscordId,
    },
    ip: input.ip ?? null,
  });
  return { ok: true, revoked: r.count };
}

// --- 4) Aktive Sessions auflisten (Admin-UI) ------------------------------

export interface ActiveDevSessionRow {
  id: string;
  userDiscordId: string;
  createdAt: Date;
  expiresAt: Date;
  scope: unknown;
  remainingMs: number;
  totalLifetimeMs: number;
}

export async function listActiveDevSessions(now: Date = new Date()): Promise<ActiveDevSessionRow[]> {
   
  const rows = await prisma.devSession.findMany({
    where: { revokedAt: null, expiresAt: { gt: now } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, userDiscordId: true, createdAt: true, expiresAt: true, scope: true },
    take: 200,
  });
  return rows.map(r => ({
    ...r,
    remainingMs: Math.max(0, r.expiresAt.getTime() - now.getTime()),
    totalLifetimeMs: r.expiresAt.getTime() - r.createdAt.getTime(),
  }));
}
