/**
 * P0 — Enterprise Compliance Middleware fuer DEV-Endpoints.
 *
 * Liefert vier Bausteine, die als Stack hinter `requireDev` greifen:
 *   1. enforceDevMfa(userId)            — TwoFactorAuth.isEnabled erforderlich
 *                                         (mit Grace-Period via DEV_MFA_GRACE_PERIOD_END)
 *   2. enforceDevIpAllowlist(req)       — IpList(WHITELIST). Leer = fail-closed
 *                                         (Opt-out via DEV_IP_ALLOWLIST_REQUIRED=false).
 *   3. recordDevAuthFailure(...)        — Persistiert LOGIN_FAILURE/BRUTE_FORCE
 *                                         in SecurityEvent (zusaetzlich zur In-Memory-Map).
 *   4. parseDevScope(scope)/getActiveDevSession(req)
 *                                       — Typisierter DevSession-Scope incl.
 *                                         optionalem guildIdRestrict.
 *
 * Alle Funktionen sind side-effect-arm und ohne Express-Magic, damit sie
 * sowohl in Middleware-Stacks als auch in Socket-Auth-Pfaden wiederverwendbar
 * sind (siehe socket/dev.ts).
 */

import type { Request } from 'express';
import prisma from '../../database/prisma';
import { logger, logAudit } from '../../utils/logger';

// ---------------------------------------------------------------------------
// 1) MFA-Enforcement
// ---------------------------------------------------------------------------

export interface MfaCheckResult {
  ok: boolean;
  reason?: 'no_2fa' | 'grace_active';
  graceUntil?: Date | null;
}

/**
 * Prueft ob TwoFactorAuth fuer den User aktiv ist.
 *
 * Grace-Period (P0-gehaertet, secure-by-default):
 *   - 2FA ist STANDARDMAESSIG hart erforderlich. Ohne 2FA -> ok=false.
 *   - Loophole nur wenn ALLE drei Bedingungen erfuellt sind:
 *       1. ENV `DEV_MFA_GRACE_ALLOW=true` (explizites Opt-in)
 *       2. ENV `DEV_MFA_GRACE_PERIOD_END` ist ein gueltiges ISO-Date in
 *          der Zukunft
 *       3. Grace-Ende liegt max. `DEV_MFA_GRACE_MAX_DAYS` (Default 14) in
 *          der Zukunft, gemessen ab JETZT
 *   - Jede Nutzung wird in `auth.ts` als `DEV_MFA_GRACE_USED` auditiert.
 *
 * Damit kann ein vergessenes/falsch gesetztes `DEV_MFA_GRACE_PERIOD_END`
 * (z.B. Jahr 2099) nicht mehr 2FA dauerhaft umgehen.
 */
export async function enforceDevMfa(userId: string): Promise<MfaCheckResult> {
  const tfa = await prisma.twoFactorAuth.findUnique({
    where: { userId },
    select: { isEnabled: true },
  });
  if (tfa?.isEnabled) return { ok: true };

  // Secure-by-default: Loophole muss EXPLIZIT geoeffnet werden.
  if (process.env.DEV_MFA_GRACE_ALLOW !== 'true') {
    return { ok: false, reason: 'no_2fa', graceUntil: null };
  }

  const graceEnv = process.env.DEV_MFA_GRACE_PERIOD_END;
  if (!graceEnv) return { ok: false, reason: 'no_2fa', graceUntil: null };

  const end = new Date(graceEnv);
  if (Number.isNaN(end.getTime()) || end.getTime() <= Date.now()) {
    return { ok: false, reason: 'no_2fa', graceUntil: null };
  }

  // Hard cap: keine Grace > N Tage in die Zukunft.
  const maxDays = Number(process.env.DEV_MFA_GRACE_MAX_DAYS ?? 14);
  const ceiling = Date.now() + maxDays * 86_400_000;
  if (end.getTime() > ceiling) {
    logger.warn(
      `enforceDevMfa: DEV_MFA_GRACE_PERIOD_END (${graceEnv}) liegt > ${maxDays} Tage in der Zukunft — ignoriert.`,
    );
    return { ok: false, reason: 'no_2fa', graceUntil: null };
  }

  return { ok: true, reason: 'grace_active', graceUntil: end };
}

// ---------------------------------------------------------------------------
// 2) IP-Allowlist (fail-open bei leerer Liste)
// ---------------------------------------------------------------------------

export interface IpCheckResult {
  ok: boolean;
  reason?: 'not_listed' | 'no_list' | 'no_ip';
  listSize: number;
}

/**
 * Prueft ob die Request-IP in der DEV-IP-Allowlist (IpList.listType=WHITELIST) ist.
 *
 * Verhalten (secure-by-default, P0-gehaertet):
 *   - Liste leer  -> fail-CLOSED (ok=false, reason='no_list'), AUSSER es ist
 *                    explizit `DEV_IP_ALLOWLIST_REQUIRED=false` gesetzt; dann
 *                    fail-open (Notfall-/Bootstrap-Override).
 *   - IP fehlt    -> fail-closed (ok=false, reason='no_ip')
 *   - IP gelistet -> ok=true
 *   - IP fehlt in Liste -> ok=false, reason='not_listed'
 *
 * Whitelist-Eintraege mit `expiresAt` in der Vergangenheit werden ignoriert.
 */
export async function enforceDevIpAllowlist(req: Request): Promise<IpCheckResult> {
  const ip = req.ip ?? null;
  const count = await prisma.ipList.count({
    where: {
      listType: 'WHITELIST',
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
  });
  if (count === 0) {
    // Secure-by-default: leere Allowlist sperrt DEV-Zugriff. Nur ein
    // explizites Opt-out erlaubt Bootstrap ohne Allowlist.
    if (process.env.DEV_IP_ALLOWLIST_REQUIRED === 'false') {
      return { ok: true, reason: 'no_list', listSize: 0 };
    }
    return { ok: false, reason: 'no_list', listSize: 0 };
  }
  if (!ip) return { ok: false, reason: 'no_ip', listSize: count };

  const hit = await prisma.ipList.findFirst({
    where: {
      listType: 'WHITELIST',
      ipAddress: ip,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    select: { id: true },
  });
  if (hit) return { ok: true, listSize: count };
  return { ok: false, reason: 'not_listed', listSize: count };
}

// ---------------------------------------------------------------------------
// 3) Brute-Force-Persistenz (zusaetzlich zur In-Memory-Map in dev.ts)
// ---------------------------------------------------------------------------

export interface AuthFailureContext {
  userId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  reason: string;
  failureCount?: number;
  lockedUntil?: Date | null;
}

/**
 * Persistiert einen DEV-Login-Fehlversuch in SecurityEvent.
 *
 * Best-effort (no-await fuer Caller). Eskaliert auf BRUTE_FORCE/CRITICAL,
 * sobald `failureCount` den Schwellwert erreicht.
 */
export function recordDevAuthFailure(ctx: AuthFailureContext): void {
  void persistDevAuthFailure(ctx).catch((e: unknown) => {
    logger.warn('recordDevAuthFailure: DB-Persist fehlgeschlagen', { err: (e as Error).message });
  });
}

const BRUTE_THRESHOLD = 5;

async function persistDevAuthFailure(ctx: AuthFailureContext): Promise<void> {
  const isBrute = (ctx.failureCount ?? 0) >= BRUTE_THRESHOLD || !!ctx.lockedUntil;
  await prisma.securityEvent.create({
    data: {
      userId: ctx.userId ?? null,
      eventType: isBrute ? 'BRUTE_FORCE' : 'LOGIN_FAILURE',
      severity: isBrute ? 'CRITICAL' : 'MEDIUM',
      description: isBrute
        ? `DEV-Login Brute-Force erkannt (${ctx.failureCount} Fehlversuche).`
        : `DEV-Login Fehlversuch (${ctx.reason}).`,
      details: {
        scope: 'dev',
        reason: ctx.reason,
        failureCount: ctx.failureCount ?? null,
        lockedUntil: ctx.lockedUntil ? ctx.lockedUntil.toISOString() : null,
      },
      ipAddress: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
    },
  });
}

/**
 * Persistiert einen erfolgreichen DEV-Login als SecurityEvent (LOW),
 * damit Audit-/Forensik-Pages zeitliche Zugriffsmuster sehen.
 */
export async function recordDevAuthSuccess(ctx: { userId: string; ip?: string | null; userAgent?: string | null; sessionId: string }): Promise<void> {
  try {
    await prisma.securityEvent.create({
      data: {
        userId: ctx.userId,
        eventType: 'CUSTOM',
        severity: 'LOW',
        description: 'DEV-Login erfolgreich.',
        details: { scope: 'dev', sessionId: ctx.sessionId },
        ipAddress: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
      },
    });
  } catch (e) {
    logger.warn('recordDevAuthSuccess: DB-Persist fehlgeschlagen', { err: (e as Error).message });
  }
}

// ---------------------------------------------------------------------------
// 4) DevSession-Scope-Parser (typisiert)
// ---------------------------------------------------------------------------

export interface DevSessionScope {
  /** Klassische Flags (Bestand). */
  logs?: boolean;
  snapshot?: boolean;
  /**
   * Multi-Guild-Schutz: wenn gesetzt, duerfen DEV-Endpoints, die auf
   * einzelne Guilds aggregieren, NUR Daten dieser Guild ausliefern.
   * Leer/undefined = global view (Bestandsverhalten).
   */
  guildIdRestrict?: string;
  /** Step-Up-Profil (P2). */
  readOnly?: boolean;
  allowMutations?: boolean;
  allowMirrorTrigger?: boolean;
}

export function parseDevScope(raw: unknown): DevSessionScope {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const scope: DevSessionScope = {};
  if (typeof r.logs === 'boolean') scope.logs = r.logs;
  if (typeof r.snapshot === 'boolean') scope.snapshot = r.snapshot;
  if (typeof r.guildIdRestrict === 'string' && r.guildIdRestrict.trim().length > 0) {
    scope.guildIdRestrict = r.guildIdRestrict.trim();
  }
  if (typeof r.readOnly === 'boolean') scope.readOnly = r.readOnly;
  if (typeof r.allowMutations === 'boolean') scope.allowMutations = r.allowMutations;
  if (typeof r.allowMirrorTrigger === 'boolean') scope.allowMirrorTrigger = r.allowMirrorTrigger;
  return scope;
}

export interface ActiveDevSession {
  id: string;
  userDiscordId: string;
  scope: DevSessionScope;
  expiresAt: Date;
}

/**
 * Laedt die aktive DevSession des aktuell eingeloggten Users (oder null).
 * Wird von `requireDev` schon aufgerufen — andere Routen koennen die Funktion
 * nutzen, um auf den Scope zuzugreifen ohne eigene Query.
 */
export async function getActiveDevSession(req: Request): Promise<ActiveDevSession | null> {
  if (!req.auth) return null;
  const s = await prisma.devSession.findFirst({
    where: { userDiscordId: req.auth.discordId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, userDiscordId: true, scope: true, expiresAt: true },
  });
  if (!s) return null;
  return { id: s.id, userDiscordId: s.userDiscordId, scope: parseDevScope(s.scope), expiresAt: s.expiresAt };
}

// ---------------------------------------------------------------------------
// 5) Step-Up-Re-Auth (P2-Vorbereitung — als Helper schon nutzbar)
// ---------------------------------------------------------------------------

export interface StepUpInput {
  reason?: string;
  reAuth?: string;
}

export interface StepUpResult {
  ok: boolean;
  error?: 'reason_missing' | 'reason_too_short' | 'reauth_missing' | 'reauth_invalid' | 'no_credential';
}

const STEP_UP_REASON_MIN = 6;
const STEP_UP_REASON_MAX = 500;

/**
 * Validiert ein Step-Up: erfordert
 *   - Reason (6..500 Zeichen)
 *   - Re-Auth-Token: TOTP wenn 2FA aktiv ist, sonst Passwort-Reconfirm
 *
 * Token-Validierung erfolgt verlagert in den Caller (auth.ts wraps
 * verify2FAToken) — diese Helper-Funktion validiert NUR Form/Pflichtfelder
 * und stellt eine konsistente API bereit.
 */
export function validateStepUpInput(input: StepUpInput): StepUpResult {
  const reason = (input.reason ?? '').trim();
  if (!reason) return { ok: false, error: 'reason_missing' };
  if (reason.length < STEP_UP_REASON_MIN) return { ok: false, error: 'reason_too_short' };
  if (reason.length > STEP_UP_REASON_MAX) return { ok: false, error: 'reason_too_short' };
  const reAuth = (input.reAuth ?? '').trim();
  if (!reAuth) return { ok: false, error: 'reauth_missing' };
  if (reAuth.length < 4) return { ok: false, error: 'reauth_invalid' };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 6) Convenience-Audit-Wrapper fuer DEV-Aktionen
// ---------------------------------------------------------------------------

/**
 * Loggt eine DEV-Privileg-Aktion in beide Senken (Winston + AuditLog-DB).
 * Duenn ueber logAuditDb, um `category='SECURITY'` und Standardfelder
 * konsistent zu setzen.
 */
export function logDevAction(
  action: string,
  req: Request,
  details: Record<string, unknown>,
): void {
  logAudit(action, 'SECURITY', {
    actorUserId: req.auth?.userId, ip: req.ip, ua: req.headers['user-agent'], ...details,
  });
  // DB-Persistenz via Lazy-Import gegen Zirkularitaet
  void (async () => {
    try {
      const { logAuditDb } = await import('../../utils/logger.js');
      logAuditDb(action, 'SECURITY', {
        actorUserId: req.auth?.userId ?? null,
        guildId: typeof details.guildId === 'string' ? details.guildId : null,
        details,
        ip: req.ip ?? null,
        userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
      });
    } catch (e) {
      logger.warn('logDevAction: lazy-import failed', { err: (e as Error).message });
    }
  })();
}
