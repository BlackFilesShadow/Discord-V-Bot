/**
 * Idempotency-Middleware (Haertung A1, F-004: atomarer Claim).
 *
 * Nimmt einen Header `X-Idempotency-Key` entgegen. Wenn vorhanden:
 *  - Erster Aufruf: atomarer Claim (create) -> Handler laeuft -> Antwort wird
 *    gespeichert (60 min TTL). Der Claim per Primary-Key `hash` ist atomar,
 *    zwei parallele Requests koennen ihn nicht beide gewinnen.
 *  - Paralleler Zweitaufruf waehrend der Verarbeitung -> 409 (in Bearbeitung).
 *  - Wiederholung nach Abschluss -> gecachte Antwort ohne Handler-Rerun.
 *  - Nicht-2xx-Antwort -> Claim wird freigegeben (Retry moeglich).
 *
 * Schluessel = sha256(userId + ':' + method + ':' + path + ':' + key + ':' + bodyHash)
 *  -> verhindert dass derselbe Key fuer verschiedene Routen / Bodies kollidiert.
 */
import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import prisma from '../../database/prisma';
import { logger } from '../../utils/logger';

const TTL_MS = 60 * 60 * 1000;
// Ein PROCESSING-Claim aelter als dies gilt als verwaist (Crash) und darf
// von einem neuen Request uebernommen werden.
const STALE_PROCESSING_MS = 2 * 60 * 1000;

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

  const now = Date.now();
  let owns = false;
  try {
    // Atomarer Claim: create schlaegt bei existierendem hash (PK) fehl.
    await prisma.idempotencyKey.create({
      data: { hash, status: 'PROCESSING', expiresAt: new Date(now + TTL_MS) },
    });
    owns = true;
  } catch {
    // Claim existiert bereits -> gecachtes Ergebnis, laufende Verarbeitung
    // oder verwaister Claim.
    let existing: {
      status: 'PROCESSING' | 'DONE';
      responseStatus: number | null;
      responseBody: unknown;
      createdAt: Date;
      expiresAt: Date;
    } | null = null;
    try {
      // eslint-disable-next-line local/no-unscoped-prisma-query -- global, siehe oben
      existing = await prisma.idempotencyKey.findUnique({ where: { hash } });
    } catch (e) {
      // Stage 38: fail-closed — never execute a mutation twice when the claim
      // store is unavailable (no silent double side effects).
      logger.warn('Idempotency-Lookup-Fehler:', (e as Error).message);
      res.status(503).json({ error: 'Idempotency-Store nicht erreichbar.', code: 'IDEMPOTENCY_STORE_UNAVAILABLE' });
      return;
    }
    if (!existing) { next(); return; }
    if (existing.status === 'DONE' && existing.responseStatus != null && existing.expiresAt > new Date()) {
      res.status(existing.responseStatus).json(existing.responseBody);
      return;
    }
    const stale = existing.status === 'PROCESSING' && existing.createdAt.getTime() < now - STALE_PROCESSING_MS;
    if (existing.status === 'PROCESSING' && !stale) {
      res.status(409).json({ error: 'Anfrage wird bereits verarbeitet.' });
      return;
    }

    // Verwaister PROCESSING-Claim oder abgelaufener DONE-Eintrag -> atomar per
    // Compare-and-Swap uebernehmen. Status + createdAt bilden die beobachtete
    // Version. Hat ein paralleler Recovery-Request sie bereits geaendert,
    // bekommt nur dieser erste Request Besitz; alle weiteren erhalten 409.
    try {
      // eslint-disable-next-line local/no-unscoped-prisma-query -- global, siehe oben
      const takeover = await prisma.idempotencyKey.updateMany({
        where: {
          hash,
          status: existing.status,
          createdAt: existing.createdAt,
        },
        data: {
          status: 'PROCESSING',
          responseBody: undefined,
          responseStatus: null,
          createdAt: new Date(now),
          expiresAt: new Date(now + TTL_MS),
        },
      });
      if (takeover.count !== 1) {
        res.status(409).json({ error: 'Anfrage wird bereits verarbeitet.' });
        return;
      }
      owns = true;
    } catch {
      res.status(409).json({ error: 'Anfrage wird bereits verarbeitet.' });
      return;
    }
  }

  if (!owns) { next(); return; }

  // Antwort erfassen und den Claim beim Response-Ende finalisieren.
  let capturedBody: unknown;
  let captured = false;
  const originalJson = res.json.bind(res);
  res.json = (body: unknown): Response => {
    capturedBody = body;
    captured = true;
    return originalJson(body);
  };
  res.on('finish', () => {
    const status = res.statusCode;
    if (captured && status >= 200 && status < 300) {
      // eslint-disable-next-line local/no-unscoped-prisma-query -- global, siehe oben
      prisma.idempotencyKey.update({
        where: { hash },
        data: { status: 'DONE', responseBody: (capturedBody ?? null) as object, responseStatus: status, expiresAt: new Date(Date.now() + TTL_MS) },
      }).catch((err: unknown) => logger.warn('Idempotency-Persist-Fehler:', err instanceof Error ? err.message : String(err)));
    } else {
      // Nicht-2xx oder keine JSON-Antwort -> Claim freigeben (Retry moeglich).
      // eslint-disable-next-line local/no-unscoped-prisma-query -- global, siehe oben
      prisma.idempotencyKey.delete({ where: { hash } }).catch(() => { /* bereits weg */ });
    }
  });
  next();
}
