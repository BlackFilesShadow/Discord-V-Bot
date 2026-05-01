/**
 * Idempotency-Middleware (Haertung A1).
 *
 * Nimmt einen Header `X-Idempotency-Key` entgegen. Wenn vorhanden:
 *  - Erster Aufruf: Handler laeuft, Antwort wird gespeichert (60 min TTL).
 *  - Wiederholungen mit gleichem Key + gleicher Route + gleichem User
 *    liefern die gespeicherte Antwort zurueck, ohne Handler erneut zu rufen.
 *
 * Schluessel = sha256(userId + ':' + method + ':' + path + ':' + key + ':' + bodyHash)
 *  -> verhindert dass derselbe Key fuer verschiedene Routen / Bodies kollidiert.
 */
import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import prisma from '../../database/prisma';
import { logger } from '../../utils/logger';

const TTL_MS = 60 * 60 * 1000;

function hashBody(body: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(body ?? '')).digest('hex');
}

export async function idempotency(req: Request, res: Response, next: NextFunction): Promise<void> {
  const key = req.header('x-idempotency-key');
  if (!key || !req.auth) { next(); return; }
  const trimmed = key.trim();
  if (trimmed.length < 8 || trimmed.length > 128) {
    res.status(400).json({ error: 'X-Idempotency-Key 8..128 Zeichen.' });
    return;
  }
  const hash = crypto.createHash('sha256')
    .update([req.auth.userId, req.method, req.originalUrl, trimmed, hashBody(req.body)].join(':'))
    .digest('hex');

  try {
    // eslint-disable-next-line local/no-unscoped-prisma-query -- IdempotencyKey ist global; Hash enthaelt userId+method+path+body, kein Cross-Guild-Risiko
    const existing = await prisma.idempotencyKey.findUnique({ where: { hash } });
    if (existing && existing.expiresAt > new Date()) {
      res.status(existing.responseStatus).json(existing.responseBody);
      return;
    }
  } catch (e) {
    logger.warn('Idempotency-Lookup-Fehler:', (e as Error).message);
  }

  // Response-Capture
  const originalJson = res.json.bind(res);
  res.json = (body: unknown): Response => {
    const status = res.statusCode;
    if (status >= 200 && status < 300) {
      prisma.idempotencyKey.create({
        data: {
          hash,
          responseBody: (body ?? null) as object,
          responseStatus: status,
          expiresAt: new Date(Date.now() + TTL_MS),
        },
      }).catch((err: unknown) => logger.warn('Idempotency-Persist-Fehler:', err instanceof Error ? err.message : String(err)));
    }
    return originalJson(body);
  };
  next();
}
