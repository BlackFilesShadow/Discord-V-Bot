import type { NextFunction, Request, Response } from 'express';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function normalizedOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function isHmacOrBrowserReportPath(path: string): boolean {
  return path === '/api/csp-report'
    || path === '/webhooks'
    || path.startsWith('/webhooks/');
}

/**
 * Browser CSRF boundary for cookie-authenticated mutations.
 *
 * CORS does not stop cross-origin HTML forms from sending a request. Modern
 * browsers attach Origin and Sec-Fetch-Site to such mutations, so an explicit
 * exact-origin check is required in addition to SameSite=Lax. Requests without
 * browser provenance headers remain available to non-browser API clients; they
 * still have to pass the normal session/AuthN/AuthZ gates.
 *
 * HMAC-authenticated webhooks are deliberately outside this cookie boundary.
 */
export function createMutationOriginGuard(allowedDashboardUrl: string) {
  const allowedOrigin = normalizedOrigin(allowedDashboardUrl);

  return function requireTrustedMutationOrigin(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    if (SAFE_METHODS.has(req.method.toUpperCase()) || isHmacOrBrowserReportPath(req.path)) {
      next();
      return;
    }

    const originHeader = req.get('origin')?.trim();
    const refererHeader = req.get('referer')?.trim();
    const fetchSite = req.get('sec-fetch-site')?.trim().toLowerCase();

    const origin = originHeader ? normalizedOrigin(originHeader) : null;
    const refererOrigin = !originHeader && refererHeader ? normalizedOrigin(refererHeader) : null;
    const presentedOrigin = originHeader ? origin : refererOrigin;

    const denied = !allowedOrigin
      || fetchSite === 'cross-site'
      || (originHeader !== undefined && presentedOrigin !== allowedOrigin)
      || (!originHeader && refererHeader !== undefined && presentedOrigin !== allowedOrigin);

    if (denied) {
      res.status(403).json({
        error: 'Nicht vertrauenswuerdige Request-Origin.',
        code: 'CSRF_ORIGIN_DENIED',
      });
      return;
    }

    next();
  };
}
