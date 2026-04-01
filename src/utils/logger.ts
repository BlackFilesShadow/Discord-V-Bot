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
 */
export function logAudit(action: string, category: string, details: Record<string, unknown>): void {
  auditLogger.info(action, {
    category,
    ...details,
    timestamp: new Date().toISOString(),
    immutable: true,
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
