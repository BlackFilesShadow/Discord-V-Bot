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
import { Prisma } from '@prisma/client';
import crypto from 'crypto';
import prisma from '../../database/prisma';
import { logger } from '../../utils/logger';

const TTL_MS = 60 * 60 * 1000;

function isUniqueClaimCollision(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'P2002';
}

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
  } catch (error) {
    // Nur eine echte Unique-Kollision beweist einen bereits vorhandenen Claim.
    // Bei jedem anderen Store-Fehler duerfen wir den Handler nicht ohne Claim
    // ausfuehren: sein Ergebnis koennte sonst eine Doppelaktion sein.
    if (!isUniqueClaimCollision(error)) {
      logger.warn('Idempotency-Claim-Fehler:', error instanceof Error ? error.message : String(error));
      res.status(503).json({ error: 'Idempotency-Store nicht erreichbar.', code: 'IDEMPOTENCY_STORE_UNAVAILABLE' });
      return;
    }

    // Claim existiert bereits -> gecachtes Ergebnis oder laufende/unklare
    // Verarbeitung.
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
    if (!existing) {
      // P2002 ohne lesbaren Claim ist kein sicherer Freigabebeweis.
      res.status(503).json({ error: 'Idempotency-Claim konnte nicht verifiziert werden.', code: 'IDEMPOTENCY_STORE_UNAVAILABLE' });
      return;
    }
    if (existing.status === 'DONE' && existing.responseStatus != null && existing.expiresAt > new Date()) {
      if (existing.responseBody === null) {
        res.status(existing.responseStatus).end();
      } else {
        res.status(existing.responseStatus).json(existing.responseBody);
      }
      return;
    }

    // Ein PROCESSING-Claim kann nach einem Prozessabbruch bereits eine externe
    // Aktion ausgefuehrt haben, deren DONE-Finalisierung nicht mehr gelang.
    // Ohne transaktionales Outbox-Protokoll ist das Ergebnis nicht beweisbar;
    // deshalb niemals automatisch erneut ausfuehren.
    if (existing.status === 'PROCESSING') {
      res.status(409).json({
        error: 'Anfrage wird bereits verarbeitet oder ihr Ergebnis ist unklar.',
        code: 'IDEMPOTENCY_OUTCOME_UNKNOWN',
      });
      return;
    }

    // Ein abgelaufener, bereits finaler DONE-Eintrag darf atomar erneuert
    // werden. Status + createdAt bilden die beobachtete Version. Hat ein
    // paralleler Request ihn bereits erneuert, bekommt nur dieser Besitz.
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

  // Antwort erfassen und den Claim beim Response-Ende finalisieren. Auch 204,
  // res.end() und Stream-/Attachment-Antworten werden als abgeschlossener
  // Erfolg gespeichert (mit leerem Replay-Body), nie als Retry freigegeben.
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
    if (status >= 200 && status < 300) {
      // eslint-disable-next-line local/no-unscoped-prisma-query -- global, siehe oben
      prisma.idempotencyKey.update({
        where: { hash },
        data: {
          status: 'DONE',
          // Prisma unterscheidet bei Nullable-JSON explizit Datenbank-NULL
          // von JSON-NULL. Fuer Antworten ohne JSON-Body speichern wir NULL.
          responseBody: captured && capturedBody !== undefined
            ? capturedBody as Prisma.InputJsonValue
            : Prisma.DbNull,
          responseStatus: status,
          expiresAt: new Date(Date.now() + TTL_MS),
        },
      }).catch((err: unknown) => logger.error('Idempotency-Finalisierung fehlgeschlagen; Claim bleibt fail-closed:', err instanceof Error ? err.message : String(err)));
    } else {
      // Nicht-2xx oder keine JSON-Antwort -> Claim freigeben (Retry moeglich).
      // eslint-disable-next-line local/no-unscoped-prisma-query -- global, siehe oben
      prisma.idempotencyKey.delete({ where: { hash } }).catch(() => { /* bereits weg */ });
    }
  });
  next();
}
