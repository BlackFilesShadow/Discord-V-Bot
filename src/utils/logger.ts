import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';
import fs from 'fs';

const LOG_DIR = process.env.LOG_DIR || './logs';

// Log-Verzeichnis erstellen
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

/**
 * Revisionssicheres, unveränderliches Logging-System.
 * Sektion 4 & 11: Logging aller Aktionen, revisionssicher, unveränderbar, Export/Analyse.
 */

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `[${timestamp}] ${level}: ${message}${metaStr}`;
  })
);

// Tägliche Rotation für revisionssichere Aufbewahrung
const dailyRotateTransport = new DailyRotateFile({
  filename: path.join(LOG_DIR, 'app-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  maxSize: '50m',
  maxFiles: '365d', // 1 Jahr Aufbewahrung
  zippedArchive: true,
  format: logFormat,
});

// Separate Security-Logs
const securityTransport = new DailyRotateFile({
  filename: path.join(LOG_DIR, 'security-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  maxSize: '50m',
  maxFiles: '365d',
  zippedArchive: true,
  format: logFormat,
  level: 'warn',
});

// Audit-Log (unveränderbar)
const auditTransport = new DailyRotateFile({
  filename: path.join(LOG_DIR, 'audit-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  maxSize: '100m',
  maxFiles: '730d', // 2 Jahre
  zippedArchive: true,
  format: logFormat,
});

// Error-Log
const errorTransport = new DailyRotateFile({
  filename: path.join(LOG_DIR, 'error-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  maxSize: '50m',
  maxFiles: '365d',
  zippedArchive: true,
  format: logFormat,
  level: 'error',
});

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: logFormat,
  defaultMeta: { service: 'discord-v-bot' },
  transports: [
    dailyRotateTransport,
    errorTransport,
    new winston.transports.Console({ format: consoleFormat }),
  ],
});

// Security Logger
export const securityLogger = winston.createLogger({
  level: 'info',
  format: logFormat,
  defaultMeta: { service: 'discord-v-bot-security' },
  transports: [securityTransport],
});

// Audit Logger (revisionssicher, unveränderbar)
export const auditLogger = winston.createLogger({
  level: 'info',
  format: logFormat,
  defaultMeta: { service: 'discord-v-bot-audit', immutable: true },
  transports: [auditTransport],
});

/**
 * Strukturiertes Audit-Log erstellen.
 * Alle Aktionen werden revisionssicher erfasst.
 *
 * PII/Secret-Schutz: Felder, deren Key (case-insensitive) ein typisches Secret-Wort enthaelt,
 * werden zu '[REDACTED]'. Verteidigt gegen versehentliches Logging von Tokens/Passwoertern,
 * wenn ein Aufrufer ein ganzes Request-Body als details uebergibt.
 */
const SECRET_KEY_RE = /(token|secret|password|passwd|api[-_]?key|authorization|bearer|cookie|session|otp|2fa|nonce|client[-_]?secret|encryption[-_]?key|refresh[-_]?token|access[-_]?token)/i;

function redactSecrets(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (SECRET_KEY_RE.test(k)) {
      out[k] = '[REDACTED]';
    } else if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      out[k] = redactSecrets(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function logAudit(action: string, category: string, details: Record<string, unknown>): void {
  const safe = redactSecrets(details);
  auditLogger.info(action, {
    category,
    ...safe,
    timestamp: new Date().toISOString(),
    immutable: true,
  });
}

/**
 * Audit-Log mit DB-Persistenz (Phase 6E).
 * Schreibt zusaetzlich zu Winston in die `AuditLog`-Tabelle, damit das
 * Dashboard-Audit-Panel echte historische Daten anzeigen kann.
 *
 * Wichtige Felder in `meta`:
 *   - actorUserId  (User.id, NICHT discordId — fuer FK)
 *   - guildId      (string, fuer Per-Guild-Filter)
 *   - targetUserId (User.id, optional)
 *   - channelId    (optional)
 *
 * Best-effort: DB-Fehler werden geschluckt und nur ins normale Log geschrieben.
 */
export function logAuditDb(
  action: string,
  category: string,
  meta: {
    actorUserId?: string | null;
    guildId?: string | null;
    targetUserId?: string | null;
    channelId?: string | null;
    details?: Record<string, unknown>;
    ip?: string | null;
    userAgent?: string | null;
  },
): void {
  // 1. Winston (immer)
  logAudit(action, category, {
    actor: meta.actorUserId, guildId: meta.guildId,
    target: meta.targetUserId, channel: meta.channelId,
    ...meta.details,
  });

  // 2. DB (best-effort, async, kein await)
  void persistAuditRow(action, category, meta).catch((e: unknown) => {
    logger.warn('logAuditDb: DB-Persistierung fehlgeschlagen', {
      action, category, err: (e as Error).message,
    });
  });
}

async function persistAuditRow(
  action: string,
  category: string,
  meta: {
    actorUserId?: string | null;
    guildId?: string | null;
    targetUserId?: string | null;
    channelId?: string | null;
    details?: Record<string, unknown>;
    ip?: string | null;
    userAgent?: string | null;
  },
): Promise<void> {
  // Lazy-Import gegen Zirkularitaet (logger laedt prisma laedt logger).
  const prismaMod = await import('../database/prisma.js');
  // CJS/ESM-Interop: Bei `export default` mit Node16+CJS landet der echte
  // Client je nach Bundler unter `.default` oder `.default.default`.
  const raw = prismaMod.default as unknown as { auditLog?: unknown; default?: { auditLog?: unknown } };
  const prisma = (raw && 'auditLog' in raw && raw.auditLog
    ? raw
    : raw?.default) as unknown as { auditLog: { create: (args: { data: Record<string, unknown> }) => Promise<unknown> } };
  if (!prisma?.auditLog) throw new Error('PrismaClient.auditLog nicht verfuegbar (Interop-Problem)');
  await prisma.auditLog.create({
    data: {
      actorId: meta.actorUserId ?? null,
      targetId: meta.targetUserId ?? null,
      action,
      // Cast: Migration `20260502120000_add_audit_categories_v2` erweitert das Enum.
      category: category as never,
      details: (meta.details ?? null) as never,
      channelId: meta.channelId ?? null,
      guildId: meta.guildId ?? null,
      ipAddress: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      isImmutable: true,
    },
  });
}

/**
 * Security-Event loggen.
 */
export function logSecurity(event: string, severity: string, details: Record<string, unknown>): void {
  securityLogger.warn(event, {
    severity,
    ...details,
    timestamp: new Date().toISOString(),
  });
}
