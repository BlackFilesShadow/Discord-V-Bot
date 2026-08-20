import { Router, type Request, type RequestHandler, type Response } from 'express';
import { requireBotAdmin } from '../../middleware/auth';

/**
 * Strict fail-closed contract for the legacy Bot-Admin collection router.
 *
 * The legacy implementation intentionally remains behind this adapter so we can
 * harden public HTTP semantics without duplicating its business logic.  Every
 * protected route below runs requireBotAdmin BEFORE validation, avoiding an
 * unauthenticated contract oracle.  If validation succeeds, the request falls
 * through to botAdminRouter, whose existing requireBotAdmin remains a second
 * defence-in-depth check.
 */
export const botAdminLegacyContractRouter = Router();

const STRICT_POSITIVE_INT_RE = /^[1-9]\d*$/;
const MAX_PAGE = 1_000_000;
const MAX_PAGE_SIZE = 100;

function reject(res: Response, error: string): void {
  res.status(400).json({ error });
}

function parseStrictQueryInteger(
  raw: unknown,
  field: string,
  min: number,
  max: number,
): { ok: true; value?: number } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true };
  if (typeof raw !== 'string' || !STRICT_POSITIVE_INT_RE.test(raw)) {
    return { ok: false, error: `${field} muss eine ganze Zahl zwischen ${min} und ${max} sein.` };
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    return { ok: false, error: `${field} muss eine ganze Zahl zwischen ${min} und ${max} sein.` };
  }
  return { ok: true, value };
}

export const validateBotAdminPagination: RequestHandler = (req, res, next) => {
  const page = parseStrictQueryInteger(req.query.page, 'page', 1, MAX_PAGE);
  if (!page.ok) { reject(res, page.error); return; }
  const pageSize = parseStrictQueryInteger(req.query.pageSize, 'pageSize', 1, MAX_PAGE_SIZE);
  if (!pageSize.ok) { reject(res, pageSize.error); return; }
  next();
};

function enumQuery(field: string, allowed: readonly string[]): RequestHandler {
  const allowedSet = new Set(allowed);
  return (req, res, next) => {
    const raw = req.query[field];
    if (raw === undefined) { next(); return; }
    if (typeof raw !== 'string' || raw.length === 0) {
      reject(res, `${field} ist ungueltig.`);
      return;
    }
    if (!allowedSet.has(raw.toUpperCase())) {
      reject(res, `${field} ist ungueltig.`);
      return;
    }
    next();
  };
}

function requiredBooleanBody(field: string): RequestHandler {
  return (req, res, next) => {
    if (!req.body || typeof req.body !== 'object' || typeof req.body[field] !== 'boolean') {
      reject(res, `${field} muss true oder false sein.`);
      return;
    }
    next();
  };
}

function optionalBooleanBody(field: string): RequestHandler {
  return (req, res, next) => {
    const value = req.body && typeof req.body === 'object' ? req.body[field] : undefined;
    if (value !== undefined && typeof value !== 'boolean') {
      reject(res, `${field} muss true oder false sein.`);
      return;
    }
    next();
  };
}

export const validateResetPasswordExpiry: RequestHandler = (req: Request, res, next) => {
  const raw = req.body && typeof req.body === 'object' ? req.body.expiryMinutes : undefined;
  if (raw === undefined) { next(); return; } // Legacy default 30 Minuten bleibt kompatibel.

  let value: number | null = null;
  if (typeof raw === 'number' && Number.isInteger(raw)) {
    value = raw;
  } else if (typeof raw === 'string' && STRICT_POSITIVE_INT_RE.test(raw)) {
    value = Number(raw);
  }

  if (value === null || !Number.isSafeInteger(value) || value < 5 || value > 1440) {
    reject(res, 'expiryMinutes muss eine ganze Zahl zwischen 5 und 1440 sein.');
    return;
  }
  next();
};

const appealStatus = enumQuery('status', ['PENDING', 'APPROVED', 'DENIED', 'ESCALATED']);
const feedbackStatus = enumQuery('status', ['OPEN', 'IN_REVIEW', 'RESOLVED', 'WONTFIX']);
const packageStatus = enumQuery('status', ['ACTIVE', 'QUARANTINED', 'DELETED', 'VALIDATING']);
const ticketStatus = enumQuery('status', ['PENDING', 'OPEN', 'DENIED', 'CLOSED']);
const userFilter = enumQuery('filter', ['ALL', 'MANUFACTURER', 'ADMIN', 'MODERATOR', 'BANNED', 'PENDING_VERIFICATION']);

// List surfaces: strict pagination + strict filters. Unknown filters must never
// silently widen a query to all rows.
botAdminLegacyContractRouter.get('/appeals', requireBotAdmin, validateBotAdminPagination, appealStatus);
botAdminLegacyContractRouter.get('/feedback', requireBotAdmin, validateBotAdminPagination, feedbackStatus);
botAdminLegacyContractRouter.get('/validate', requireBotAdmin, validateBotAdminPagination);
botAdminLegacyContractRouter.get('/packages', requireBotAdmin, validateBotAdminPagination, packageStatus);
botAdminLegacyContractRouter.get('/users', requireBotAdmin, validateBotAdminPagination, userFilter);
botAdminLegacyContractRouter.get('/tickets', requireBotAdmin, validateBotAdminPagination, ticketStatus);

// Mutations whose old `=== true` / parseInt behaviour could silently convert
// malformed input into a destructive state change.
botAdminLegacyContractRouter.post('/upload/toggle', requireBotAdmin, requiredBooleanBody('enable'));
botAdminLegacyContractRouter.post('/users/:id/toggle-upload', requireBotAdmin, requiredBooleanBody('enable'));
botAdminLegacyContractRouter.post('/users/:id/reset-password', requireBotAdmin, validateResetPasswordExpiry);
botAdminLegacyContractRouter.post('/broadcast', requireBotAdmin, optionalBooleanBody('dryRun'));
