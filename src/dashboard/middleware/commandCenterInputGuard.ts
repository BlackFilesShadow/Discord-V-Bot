import { AuditCategory, SecurityEventType } from '@prisma/client';
import type { RequestHandler } from 'express';

/**
 * Discord-Slash-Choices wurden vor der Dashboard-Migration bereits durch
 * Discord validiert. HTTP-Clients koennen diese UI-Grenzen umgehen, deshalb
 * werden dieselben choice-artigen Felder jetzt an der API-Grenze fail-closed
 * validiert, bevor sie als Prisma-Enums oder Betriebsaktionen verwendet werden.
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

  if (req.method === 'POST' && req.path === '/export/logs') {
    const category = normalizedValue(req.body?.category);
    if (category && category !== 'ALL' && !AUDIT_CATEGORIES.has(category)) {
      res.status(400).json({ error: 'Unbekannte Audit-Kategorie.' });
      return;
    }
  }

  if (req.method === 'POST' && req.path === '/commands/reload') {
    const rawScope = req.body?.scope;
    // Fehlender Scope verwendet die risikoaermere Operation. Ein unbekannter
    // Scope darf niemals implizit auf "reload + deploy" eskalieren.
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
