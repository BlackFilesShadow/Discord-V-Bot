/* eslint-disable local/no-unscoped-prisma-query -- Stage 64: intentional cross-tenant system/admin surface (authZ outside Prisma where). */
/**
 * DEV Observability Routes (P3 / Dashboard-2E hardened contract).
 *
 * Alle Endpunkte sind globale Runtime-/Audit-Diagnosen. Deshalb gilt neben
 * requireDev auch der gemeinsame Global-Scope-Guard: eine guild-beschraenkte
 * DevSession darf diese Daten weder lesen noch indirekt ueber Filter abfragen.
 */
import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { requireDev } from '../../middleware/auth';
import {
  getAiSnapshot,
  getPrismaSnapshot,
  queryLogRing,
  readBackupStatus,
} from '../../services/observability';
import prisma from '../../../database/prisma';
import { redactAuditDetails } from '../../../utils/auditRedaction';
import { rejectGlobalOnlyForRestrictedSession } from './devDiagnosticScope';
import {
  AuditQueryValidationError,
  auditCursorFilter,
  decodeAuditCursor,
  encodeAuditCursor,
  parseAuditAction,
  parseAuditCategory,
  parseAuditLimit,
} from './auditContract';

export const devObservabilityRouter = Router();
devObservabilityRouter.use(requireDev);
devObservabilityRouter.use((req, res, next) => {
  if (rejectGlobalOnlyForRestrictedSession(req, res)) return;
  next();
});

class DevObservabilityQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DevObservabilityQueryError';
  }
}

const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/;
const STRICT_UINT_RE = /^(?:0|[1-9]\d*)$/;
const DISCORD_SNOWFLAKE_RE = /^\d{17,20}$/;
const SAFE_INTERNAL_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const LOG_LEVELS = new Set(['error', 'warn', 'info', 'debug']);

function respondValidationError(res: import('express').Response, error: unknown): boolean {
  if (!(error instanceof DevObservabilityQueryError) && !(error instanceof AuditQueryValidationError)) return false;
  res.status(400).json({ error: error.message });
  return true;
}

function parseStrictUint(raw: unknown, name: string, min: number, max: number): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !STRICT_UINT_RE.test(raw)) {
    throw new DevObservabilityQueryError(`${name} muss eine ganze Zahl zwischen ${min} und ${max} sein.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new DevObservabilityQueryError(`${name} muss eine ganze Zahl zwischen ${min} und ${max} sein.`);
  }
  return value;
}

function parseOptionalQueryText(raw: unknown, name: string, minLength: number, maxLength: number): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') throw new DevObservabilityQueryError(`${name} ist ungueltig.`);
  const value = raw.trim();
  if (!value) return undefined;
  if (value.length < minLength || value.length > maxLength || CONTROL_CHAR_RE.test(value)) {
    throw new DevObservabilityQueryError(`${name} muss ${minLength} bis ${maxLength} gueltige Zeichen enthalten.`);
  }
  return value;
}

function redactDiagnosticText(value: unknown): string {
  const redacted = redactAuditDetails(value);
  return typeof redacted === 'string' ? redacted : String(redacted ?? '');
}

function redactSerializedMeta(meta: string | undefined): string | undefined {
  if (!meta) return meta;
  try {
    return JSON.stringify(redactAuditDetails(JSON.parse(meta)));
  } catch {
    return redactDiagnosticText(meta);
  }
}

devObservabilityRouter.get('/metrics/prisma', (_req, res) => {
  res.json({ buckets: getPrismaSnapshot(), generatedAt: new Date().toISOString() });
});

devObservabilityRouter.get('/metrics/ai', (_req, res) => {
  res.json({ buckets: getAiSnapshot(), generatedAt: new Date().toISOString() });
});

devObservabilityRouter.get('/logs', (req, res) => {
  try {
    const level = parseOptionalQueryText(req.query.level, 'level', 1, 16);
    if (level && !LOG_LEVELS.has(level)) {
      throw new DevObservabilityQueryError('level ist ungueltig.');
    }
    const q = parseOptionalQueryText(req.query.q, 'q', 1, 200);
    const since = parseStrictUint(req.query.since, 'since', 0, Number.MAX_SAFE_INTEGER);
    const limit = parseStrictUint(req.query.n, 'n', 1, 500);

    const entries = queryLogRing({ level, q, sinceTs: since, limit }).map(entry => ({
      ...entry,
      message: redactDiagnosticText(entry.message),
      meta: redactSerializedMeta(entry.meta),
    }));
    res.json({ entries, count: entries.length });
  } catch (error) {
    if (respondValidationError(res, error)) return;
    throw error;
  }
});

devObservabilityRouter.get('/backup/status', async (_req, res) => {
  res.json(await readBackupStatus());
});

devObservabilityRouter.get('/audit/search', async (req, res) => {
  try {
    // `before` war nur timestamp-basiert und kann bei identischen createdAt-
    // Werten Zeilen verlieren. Fuer DEV gilt jetzt derselbe verlustfreie
    // createdAt+id-Cursor wie im kanonischen Guild-Audit.
    if (req.query.before !== undefined) {
      res.status(400).json({ error: 'before wird nicht mehr unterstuetzt; bitte den kanonischen cursor verwenden.' });
      return;
    }

    const limit = parseAuditLimit(req.query.limit);
    const category = parseAuditCategory(req.query.category);
    const action = parseAuditAction(req.query.action);
    const q = parseOptionalQueryText(req.query.q, 'q', 2, 200);
    const cursor = decodeAuditCursor(req.query.cursor);

    if (q && action) {
      throw new DevObservabilityQueryError('q und action duerfen nicht gleichzeitig gesetzt werden.');
    }

    let guildId: string | undefined;
    if (req.query.guildId !== undefined) {
      if (typeof req.query.guildId !== 'string' || !DISCORD_SNOWFLAKE_RE.test(req.query.guildId)) {
        throw new DevObservabilityQueryError('guildId ist ungueltig.');
      }
      guildId = req.query.guildId;
    }

    let actorId: string | undefined;
    if (req.query.actorId !== undefined) {
      if (typeof req.query.actorId !== 'string' || !SAFE_INTERNAL_ID_RE.test(req.query.actorId)) {
        throw new DevObservabilityQueryError('actorId ist ungueltig.');
      }
      actorId = req.query.actorId;
    }

    const actionNeedle = action ?? q;
    const where: Prisma.AuditLogWhereInput = {
      ...(category ? { category } : {}),
      ...(guildId ? { guildId } : {}),
      ...(actorId ? { actorId } : {}),
      ...(actionNeedle ? { action: { contains: actionNeedle, mode: 'insensitive' as const } } : {}),
      ...(cursor ? auditCursorFilter(cursor) : {}),
    };

    const rows = await prisma.auditLog.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: {
        actor: { select: { discordId: true, username: true } },
        target: { select: { discordId: true, username: true } },
      },
    });

    const hasMore = rows.length > limit;
    const visibleRows = rows.slice(0, limit);
    const lastVisible = visibleRows[visibleRows.length - 1];
    const nextCursor = hasMore && lastVisible
      ? encodeAuditCursor({ createdAt: lastVisible.createdAt, id: lastVisible.id })
      : null;

    res.json({
      entries: visibleRows.map(r => ({
        id: r.id,
        action: r.action,
        category: r.category,
        guildId: r.guildId,
        createdAt: r.createdAt.toISOString(),
        actor: r.actor ? { discordId: r.actor.discordId, username: r.actor.username } : null,
        target: r.target ? { discordId: r.target.discordId, username: r.target.username } : null,
        channelId: r.channelId,
        ipAddress: r.ipAddress,
        // Zweite Read-Time-Barriere fuer historische/Legacy-Zeilen.
        details: redactAuditDetails(r.details),
      })),
      limit,
      hasMore,
      nextCursor,
      echo: {
        q: q ?? null,
        category: category ?? null,
        action: action ?? null,
        guildId: guildId ?? null,
        actorId: actorId ?? null,
      },
    });
  } catch (error) {
    if (respondValidationError(res, error)) return;
    throw error;
  }
});
