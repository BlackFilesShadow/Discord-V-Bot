import { AuditCategory, SecurityEventType } from '@prisma/client';
import type { RequestHandler } from 'express';

/**
 * Discord-Slash-Choices wurden vor der Dashboard-Migration durch Discord
 * validiert. HTTP-Clients koennen UI-Grenzen umgehen, deshalb werden die noch
 * im Command Center vorhandenen choice-artigen Felder an der API-Grenze
 * fail-closed validiert. Secure Exports besitzen ihren eigenen Router-Guard.
 */
const AUDIT_CATEGORIES = new Set<string>(Object.values(AuditCategory));
const SECURITY_EVENT_TYPES = new Set<string>(Object.values(SecurityEventType));

function normalizedValue(value: unknown): string {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

export const guardDevCommandCenterInput: RequestHandler = (req, res, next) => {
  if (req.method === 'GET' && req.path === '/security') {
    const type = normalizedValue(req.query.type);
    if (type && type !== 'ALL' && !SECURITY_EVENT_TYPES.has(type)) {
      res.status(400).json({ error: 'Unbekannter Security-Event-Typ.' });
      return;
    }
  }

  if (req.method === 'POST' && req.path === '/commands/reload') {
    const rawScope = req.body?.scope;
    if (rawScope === undefined || rawScope === null || rawScope === '') {
      req.body = { ...(req.body ?? {}), scope: 'deploy' };
    } else if (rawScope !== 'deploy' && rawScope !== 'all') {
      res.status(400).json({ error: 'scope muss deploy oder all sein.' });
      return;
    }
  }

  next();
};

export const guardBotAdminCommandCenterInput: RequestHandler = (req, res, next) => {
  if (req.method === 'GET' && req.path === '/audit') {
    const category = normalizedValue(req.query.category);
    if (category && !AUDIT_CATEGORIES.has(category)) {
      res.status(400).json({ error: 'Unbekannte Audit-Kategorie.' });
      return;
    }
  }

  next();
};
