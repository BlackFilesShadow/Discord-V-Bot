import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import prisma from '../../database/prisma';
import { config } from '../../config';
import { decrypt, verify2FAToken } from '../../utils/security';
import { logAudit } from '../../utils/logger';
import { validateStepUpInput, type StepUpInput } from './devSecurity';

export type VerifiedDevStepUpResult =
  | { ok: true; mode: 'totp' | 'password' }
  | { ok: false; error: 'reason_missing' | 'reason_too_short' | 'reauth_missing' | 'reauth_invalid' | 'no_credential' | 'rate_limited' };

const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;
interface FailureState { count: number; firstAt: number; lockedUntil: number }
const failures = new Map<string, FailureState>();

function failureKey(req: Request): string {
  return `${String(req.auth?.discordId ?? req.auth?.userId ?? 'unknown')}|${req.ip ?? 'unknown'}`;
}

function locked(key: string): boolean {
  const entry = failures.get(key);
  if (!entry) return false;
  if (entry.lockedUntil > Date.now()) return true;
  if (Date.now() - entry.firstAt > LOCK_MS) failures.delete(key);
  return false;
}

function registerFailure(key: string): void {
  const current = failures.get(key) ?? { count: 0, firstAt: Date.now(), lockedUntil: 0 };
  current.count += 1;
  if (current.count >= MAX_FAILURES) current.lockedUntil = Date.now() + LOCK_MS;
  failures.set(key, current);
}

function constantTimeEqual(a: string, b: string): boolean {
  const ah = crypto.createHash('sha256').update(a).digest();
  const bh = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ah, bh);
}

/**
 * Kryptografische Step-Up-Pruefung fuer privilegierte DEV-Aktionen.
 *
 * - aktive 2FA -> TOTP gegen das verschluesselt gespeicherte Secret
 * - keine aktive 2FA -> erneute Eingabe von DEV_PASSWORD
 * - Credential wird niemals geloggt oder in eine URL geschrieben
 * - 5 Fehlversuche pro Developer/IP sperren Step-Up fuer 15 Minuten
 */
export async function verifyDevStepUp(req: Request, input: StepUpInput): Promise<VerifiedDevStepUpResult> {
  const shape = validateStepUpInput(input);
  if (!shape.ok) return { ok: false, error: shape.error ?? 'reauth_invalid' };
  if (!req.auth) return { ok: false, error: 'no_credential' };

  const key = failureKey(req);
  if (locked(key)) {
    logAudit('DEV_STEP_UP_RATE_LIMITED', 'SECURITY', {
      userId: req.auth.userId, discordId: req.auth.discordId, ip: req.ip,
    });
    return { ok: false, error: 'rate_limited' };
  }

  const reAuth = String(input.reAuth ?? '').trim();
  const tfa = await prisma.twoFactorAuth.findUnique({
    where: { userId: req.auth.userId },
    select: { isEnabled: true, secretEnc: true },
  });

  let valid = false;
  let mode: 'totp' | 'password' = 'password';
  if (tfa?.isEnabled) {
    mode = 'totp';
    if (tfa.secretEnc) {
      try {
        const secret = decrypt(tfa.secretEnc, config.security.encryptionKey);
        valid = verify2FAToken(secret, reAuth);
      } catch {
        valid = false;
      }
    }
  } else {
    const expected = process.env.DEV_PASSWORD;
    if (!expected) {
      logAudit('DEV_STEP_UP_MISCONFIGURED', 'SECURITY', {
        userId: req.auth.userId, discordId: req.auth.discordId, ip: req.ip,
      });
      return { ok: false, error: 'no_credential' };
    }
    valid = constantTimeEqual(reAuth, expected);
  }

  if (!valid) {
    registerFailure(key);
    logAudit('DEV_STEP_UP_FAILED', 'SECURITY', {
      userId: req.auth.userId, discordId: req.auth.discordId, ip: req.ip, mode,
      failureCount: failures.get(key)?.count ?? 1,
    });
    return { ok: false, error: 'reauth_invalid' };
  }

  failures.delete(key);
  logAudit('DEV_STEP_UP_OK', 'SECURITY', {
    userId: req.auth.userId, discordId: req.auth.discordId, ip: req.ip, mode,
    reason: String(input.reason ?? '').trim(),
  });
  return { ok: true, mode };
}

function statusFor(error: VerifiedDevStepUpResult extends { ok: false; error: infer E } ? E : never): number {
  if (error === 'rate_limited') return 429;
  if (error === 'no_credential') return 503;
  if (error === 'reauth_invalid') return 403;
  return 400;
}

/** Verifiziert jede Mutation hinter einem bereits aktiven requireDev-Gate. */
export async function requireVerifiedDevMutationStepUp(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase())) {
    next();
    return;
  }
  const result = await verifyDevStepUp(req, {
    reason: String(req.body?.reason ?? ''),
    reAuth: String(req.body?.reAuth ?? ''),
  });
  if (!result.ok) {
    res.status(statusFor(result.error)).json({ error: result.error });
    return;
  }
  next();
}

/**
 * Alte Command-Center-Exportlinks bleiben als Navigation kompatibel, geben
 * aber keine sensiblen Daten mehr per GET aus. Stattdessen wird auf die
 * geschuetzte Re-Auth-Seite im DEV-Dashboard umgeleitet.
 */
export function redirectLegacyDevExports(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== 'GET') { next(); return; }
  const pkg = req.path.match(/^\/export\/packages\/(\d{17,20})$/);
  if (pkg) {
    res.redirect(303, `/dev/secure-export?kind=packages&discordId=${encodeURIComponent(pkg[1])}`);
    return;
  }
  const user = req.path.match(/^\/export\/user\/(\d{17,20})$/);
  if (user) {
    res.redirect(303, `/dev/secure-export?kind=user&discordId=${encodeURIComponent(user[1])}`);
    return;
  }
  if (req.path === '/export/logs') {
    const category = typeof req.query.category === 'string' ? req.query.category : 'ALL';
    const days = typeof req.query.days === 'string' ? req.query.days : '30';
    res.redirect(303, `/dev/secure-export?kind=logs&category=${encodeURIComponent(category)}&days=${encodeURIComponent(days)}`);
    return;
  }
  next();
}
