import type { NextFunction, Request, Response } from 'express';
import { SecurityEventType } from '@prisma/client';

const SECURITY_EVENT_TYPES = new Set<string>(Object.values(SecurityEventType));

/**
 * Ersetzt die Typ-/Choice-Garantien des frueheren `/admin-security` Slash-
 * Commands auf HTTP-Ebene. Manipulierte Dashboard-Requests duerfen weder
 * beliebige Prisma-Enum-Werte noch fraktionale/uebergrosse Laufzeiten an die
 * Business-Route weiterreichen.
 */
export function guardDevSecurityInput(req: Request, res: Response, next: NextFunction): void {
  const method = req.method.toUpperCase();

  if (method === 'GET' && req.path === '/security') {
    const raw = typeof req.query.type === 'string' ? req.query.type.trim().toUpperCase() : 'ALL';
    if (raw !== 'ALL' && !SECURITY_EVENT_TYPES.has(raw)) {
      res.status(400).json({ error: 'Ungültiger Security-Event-Typ.' });
      return;
    }
  }

  if (method === 'PUT' && /^\/security\/ip\/[^/]+$/.test(req.path)) {
    const raw = req.body?.durationHours;
    if (raw !== undefined && raw !== null && raw !== '') {
      const hours = Number(raw);
      if (!Number.isInteger(hours) || hours < 0 || hours > 8760) {
        res.status(400).json({ error: 'durationHours muss eine ganze Zahl zwischen 0 und 8760 sein.' });
        return;
      }
    }
  }

  next();
}
