import { Router, type Request, type RequestHandler, type Response } from 'express';
import { requireBotAdmin } from '../../middleware/auth';

/**
 * Strict fail-closed contract for the legacy Bot-Admin collection router.
 *
 * The legacy implementation intentionally remains behind this adapter so we can
 * harden public HTTP semantics without duplicating its business logic. Every
 * protected route below runs requireBotAdmin BEFORE validation, avoiding an
 * unauthenticated contract oracle. If validation succeeds, the request falls
 * through to botAdminRouter, whose existing requireBotAdmin remains a second
 * defence-in-depth check.
 */
export const botAdminLegacyContractRouter = Router();

const STRICT_POSITIVE_INT_RE = /^[1-9]\d*$/;
const MAX_PAGE = 1_000_000;
const MAX_PAGE_SIZE = 100;
const MAX_SEARCH_LENGTH = 200;

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

function optionalSearchQuery(field: string): RequestHandler {
  return (req, res, next) => {
    const raw = req.query[field];
    if (raw === undefined) { next(); return; }
    // Repeated query keys are arrays in Express. The legacy handlers interpreted
    // those as an empty search and therefore widened the query to all rows.
    if (typeof raw !== 'string') {
      reject(res, `${field} muss genau einmal als String angegeben werden.`);
      return;
    }
    if (raw.length > MAX_SEARCH_LENGTH) {
      reject(res, `${field} darf maximal ${MAX_SEARCH_LENGTH} Zeichen lang sein.`);
      return;
    }
    next();
  };
}

function optionalBooleanQuery(field: string): RequestHandler {
  return (req, res, next) => {
    const raw = req.query[field];
    if (raw === undefined) { next(); return; }
    if (raw !== 'true' && raw !== 'false') {
      reject(res, `${field} muss true oder false sein.`);
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

function requiredEnumBody(field: string, allowed: readonly string[]): RequestHandler {
  const allowedSet = new Set(allowed);
  return (req, res, next) => {
    const value = req.body && typeof req.body === 'object' ? req.body[field] : undefined;
    if (typeof value !== 'string' || value.length === 0 || !allowedSet.has(value.toUpperCase())) {
      reject(res, `${field} ist ungueltig.`);
      return;
    }
    next();
  };
}

function requiredExactEnumBody(field: string, allowed: readonly string[]): RequestHandler {
  const allowedSet = new Set(allowed);
  return (req, res, next) => {
    const value = req.body && typeof req.body === 'object' ? req.body[field] : undefined;
    if (typeof value !== 'string' || !allowedSet.has(value)) {
      reject(res, `${field} ist ungueltig.`);
      return;
    }
    next();
  };
}

function requiredTrimmedStringBody(field: string, min: number, max: number): RequestHandler {
  return (req, res, next) => {
    const value = req.body && typeof req.body === 'object' ? req.body[field] : undefined;
    if (typeof value !== 'string') {
      reject(res, `${field} muss ein String sein.`);
      return;
    }
    const length = value.trim().length;
    if (length < min || length > max) {
      reject(res, `${field} muss zwischen ${min} und ${max} Zeichen lang sein.`);
      return;
    }
    next();
  };
}

function optionalStringBody(field: string, max: number): RequestHandler {
  return (req, res, next) => {
    const value = req.body && typeof req.body === 'object' ? req.body[field] : undefined;
    if (value === undefined || value === null) { next(); return; }
    if (typeof value !== 'string') {
      reject(res, `${field} muss ein String sein.`);
      return;
    }
    if (value.length > max) {
      reject(res, `${field} darf maximal ${max} Zeichen lang sein.`);
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
const searchQuery = optionalSearchQuery('q');

// List surfaces: strict pagination + strict filters. Unknown filters and
// malformed/repeated search keys must never silently widen a query to all rows.
botAdminLegacyContractRouter.get('/appeals', requireBotAdmin, validateBotAdminPagination, appealStatus);
botAdminLegacyContractRouter.get('/feedback', requireBotAdmin, validateBotAdminPagination, feedbackStatus);
botAdminLegacyContractRouter.get('/validate', requireBotAdmin, validateBotAdminPagination);
botAdminLegacyContractRouter.get('/packages', requireBotAdmin, validateBotAdminPagination, packageStatus, searchQuery);
botAdminLegacyContractRouter.get('/users', requireBotAdmin, validateBotAdminPagination, userFilter, searchQuery);
botAdminLegacyContractRouter.get('/tickets', requireBotAdmin, validateBotAdminPagination, ticketStatus);

// Global Bot-Admin mutation contract. Legacy handlers still own business logic,
// but they may no longer coerce malformed arrays/numbers into valid enum values
// or silently truncate operator-entered notes.
botAdminLegacyContractRouter.post(
  '/appeals/:id/decision',
  requireBotAdmin,
  requiredEnumBody('decision', ['APPROVED', 'DENIED', 'ESCALATED']),
  optionalStringBody('note', 1000),
);
botAdminLegacyContractRouter.patch(
  '/feedback/:id',
  requireBotAdmin,
  requiredEnumBody('status', ['OPEN', 'IN_REVIEW', 'RESOLVED', 'WONTFIX']),
  optionalStringBody('adminNote', 2000),
);
botAdminLegacyContractRouter.post(
  '/broadcast',
  requireBotAdmin,
  requiredEnumBody('target', ['ALL', 'MANUFACTURER', 'ADMIN', 'MODERATOR']),
  requiredTrimmedStringBody('message', 1, 1900),
  optionalBooleanBody('dryRun'),
);
// Export is the one legacy enum that is intentionally lowercase and is not
// normalized downstream. Keep the adapter aligned with that exact contract.
botAdminLegacyContractRouter.post(
  '/export',
  requireBotAdmin,
  requiredExactEnumBody('type', ['packages', 'logs', 'users']),
);
botAdminLegacyContractRouter.post(
  '/packages/:id/status',
  requireBotAdmin,
  requiredEnumBody('status', ['ACTIVE', 'QUARANTINED']),
);
botAdminLegacyContractRouter.delete(
  '/packages/:id',
  requireBotAdmin,
  optionalBooleanQuery('hard'),
);

// Mutations whose old `=== true` / parseInt behaviour could silently convert
// malformed input into a destructive state change.
botAdminLegacyContractRouter.post('/upload/toggle', requireBotAdmin, requiredBooleanBody('enable'));
botAdminLegacyContractRouter.post(
  '/users/:id/toggle-upload',
  requireBotAdmin,
  requiredBooleanBody('enable'),
  optionalStringBody('reason', 500),
);
botAdminLegacyContractRouter.post(
  '/users/:id/manufacturer',
  requireBotAdmin,
  requiredEnumBody('decision', ['APPROVE', 'DENY']),
  optionalStringBody('note', 500),
);
botAdminLegacyContractRouter.post('/users/:id/reset-password', requireBotAdmin, validateResetPasswordExpiry);
