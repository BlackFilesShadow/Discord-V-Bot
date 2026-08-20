import type { Request, Response } from 'express';
import { config } from '../../config';
import { logAudit } from '../../utils/logger';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function canonicalDashboardOrigin(): string | null {
  try {
    return new URL(config.dashboard.url).origin;
  } catch {
    return null;
  }
}

export function isDevMutationRequest(req: Pick<Request, 'method' | 'originalUrl'>): boolean {
  if (SAFE_METHODS.has(String(req.method).toUpperCase())) return false;
  const path = String(req.originalUrl ?? '').split('?', 1)[0];
  return path === '/api/v2/dev' || path.startsWith('/api/v2/dev/');
}

export function devMutationOriginVerdict(req: Pick<Request, 'get' | 'method' | 'originalUrl'>): {
  ok: boolean;
  reason?: 'dashboard_origin_invalid' | 'origin_missing' | 'origin_invalid' | 'cross_site' | 'origin_mismatch';
} {
  if (!isDevMutationRequest(req as Pick<Request, 'method' | 'originalUrl'>)) return { ok: true };

  const expectedOrigin = canonicalDashboardOrigin();
  if (!expectedOrigin) return { ok: false, reason: 'dashboard_origin_invalid' };

  const secFetchSite = req.get('sec-fetch-site');
  if (secFetchSite === 'cross-site') return { ok: false, reason: 'cross_site' };

  const rawOrigin = req.get('origin');
  if (!rawOrigin) return { ok: false, reason: 'origin_missing' };

  let requestOrigin: string;
  try {
    requestOrigin = new URL(rawOrigin).origin;
  } catch {
    return { ok: false, reason: 'origin_invalid' };
  }
  if (requestOrigin !== expectedOrigin) return { ok: false, reason: 'origin_mismatch' };

  // Browser requests with an Origin matching the canonical dashboard are safe
  // even when Sec-Fetch-Site is absent (older clients). If browsers do send it,
  // only same-origin/same-site/none can reach this point; cross-site was denied.
  return { ok: true };
}

/**
 * DEV mutations use the authenticated dashboard cookie and are therefore
 * CSRF-sensitive. This guard is intentionally fail-closed: a mutating DEV
 * request must carry the canonical Dashboard Origin, and explicit cross-site
 * fetch metadata is denied before any business logic or idempotency claim.
 */
export function enforceDevMutationRequestIntegrity(req: Request, res: Response): boolean {
  const verdict = devMutationOriginVerdict(req);
  if (verdict.ok) return true;

  logAudit('DEV_MUTATION_ORIGIN_DENIED', 'SECURITY', {
    userId: req.auth?.userId ?? null,
    discordId: req.auth?.discordId ?? null,
    method: req.method,
    path: req.originalUrl,
    origin: req.get('origin') ?? null,
    secFetchSite: req.get('sec-fetch-site') ?? null,
    reason: verdict.reason,
    ip: req.ip,
  });
  res.status(403).json({
    error: 'DEV-Mutation nur aus dem kanonischen Dashboard erlaubt.',
    code: 'DEV_ORIGIN_REQUIRED',
  });
  return false;
}
