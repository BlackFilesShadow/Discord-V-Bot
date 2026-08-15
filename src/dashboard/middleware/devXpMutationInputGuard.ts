import type { NextFunction, Request, Response } from 'express';
import prisma from '../../database/prisma';

const XP_ROUTE = /^\/xp\/(\d{17,20})$/;

/**
 * HTTP-Precondition fuer DEV-XP-Mutationen.
 *
 * Der bestehende Business-Handler erzeugt eine fehlende XpConfig per Upsert.
 * Deshalb muessen numerisch ungueltige PATCH-Requests bereits vor dem Handler
 * abgewiesen werden, damit ein 400 niemals als Nebeneffekt eine Config-Zeile
 * anlegt. Objekt-/Guild-Referenzen werden separat durch devXpScopeGuard geprueft.
 */
export async function guardDevXpMutationInput(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (req.method.toUpperCase() !== 'PATCH') {
    next();
    return;
  }

  const match = XP_ROUTE.exec(req.path);
  if (!match) {
    next();
    return;
  }

  const body = req.body ?? {};
  const parsed: Record<string, number> = {};
  const intField = (name: string, min: number, max: number): boolean => {
    if (body[name] === undefined) return true;
    const value = Number(body[name]);
    if (!Number.isInteger(value) || value < min || value > max) return false;
    parsed[name] = value;
    return true;
  };

  if (
    !intField('messageXpMin', 0, 10000)
    || !intField('messageXpMax', 0, 10000)
    || !intField('voiceXpPerMinute', 0, 10000)
    || !intField('maxLevel', 1, 100)
  ) {
    res.status(400).json({ error: 'Ungültiger XP-Zahlenwert.' });
    return;
  }

  if (body.levelMultiplier !== undefined) {
    const multiplier = Number(body.levelMultiplier);
    if (!Number.isFinite(multiplier) || multiplier < 0 || multiplier > 100) {
      res.status(400).json({ error: 'levelMultiplier 0..100.' });
      return;
    }
  }

  // Express 4 propagiert abgelehnte async-Middleware-Promises nicht automatisch.
  // Den einzigen I/O-Schritt deshalb lokal fail-closed behandeln.
  let current: { messageXpMin: number; messageXpMax: number } | null;
  try {
    current = await prisma.xpConfig.findUnique({
      where: { id: match[1] },
      select: { messageXpMin: true, messageXpMax: true },
    });
  } catch {
    res.status(503).json({ error: 'XP-Konfiguration kann aktuell nicht sicher geprüft werden.' });
    return;
  }

  // Prisma-Wahrheit fuer eine noch nicht persistierte Config:
  // messageXpMin @default(15), messageXpMax @default(25).
  const effectiveMin = parsed.messageXpMin ?? current?.messageXpMin ?? 15;
  const effectiveMax = parsed.messageXpMax ?? current?.messageXpMax ?? 25;
  if (effectiveMin > effectiveMax) {
    res.status(400).json({ error: 'Min-XP darf nicht größer als Max-XP sein.' });
    return;
  }

  next();
}
