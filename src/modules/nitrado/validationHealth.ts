import prisma from '../../database/prisma';
import type { GuildId, NitradoConnId } from '../../types/scope';

const ALERT_AFTER_FAILURES = 3;
const MAX_ERROR_LENGTH = 500;

export interface ValidationHealthClient {
  nitradoValidationHealth: {
    upsert(args: unknown): Promise<{ failureCount: number; lastAlertAt: Date | null }>;
    updateMany(args: unknown): Promise<{ count: number }>;
    deleteMany(args: unknown): Promise<{ count: number }>;
  };
}

export interface ValidationFailureResult {
  failureCount: number;
  shouldAlert: boolean;
  safeMessage: string;
}

/**
 * Entfernt typische Token/API-Key-Muster aus Diagnosetexten, bevor sie in der
 * DB oder in Logs/Owner-Hinweisen landen. Die Funktion ist absichtlich
 * konservativ: lange tokenartige Sequenzen werden ebenfalls redigiert.
 */
export function sanitizeValidationError(input: unknown): string {
  let message = input instanceof Error ? input.message : String(input ?? 'unknown error');
  message = message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(token|access[_-]?token|refresh[_-]?token|api[_-]?key|authorization)\s*[=:]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/\b[A-Fa-f0-9]{40,}\b/g, '[REDACTED]')
    .replace(/\b[A-Za-z0-9_+/.=-]{64,}\b/g, '[REDACTED]')
    .replace(/[\r\n\t]+/g, ' ')
    .trim();
  if (!message) message = 'unknown error';
  return message.slice(0, MAX_ERROR_LENGTH);
}

function defaultClient(): ValidationHealthClient {
  return prisma as unknown as ValidationHealthClient;
}

/**
 * Persistiert einen fehlgeschlagenen Validierungsversuch. Das Inkrement selbst
 * ist DB-atomar. Ab dem dritten Fehler darf genau EINE Instanz pro Fehlerstreak
 * eine Owner-Warnung beanspruchen; das updateMany auf lastAlertAt=null ist der
 * Multi-Replica-Claim gegen doppelte DMs.
 */
export async function recordValidationFailure(
  guildId: GuildId,
  nitradoConnId: NitradoConnId,
  error: unknown,
  now: Date = new Date(),
  client: ValidationHealthClient = defaultClient(),
): Promise<ValidationFailureResult> {
  const safeMessage = sanitizeValidationError(error);
  const where = { guildId_nitradoConnId: { guildId, nitradoConnId } };

  const row = await client.nitradoValidationHealth.upsert({
    where,
    create: {
      guildId,
      nitradoConnId,
      failureCount: 1,
      lastErrorMessage: safeMessage,
      lastFailureAt: now,
      lastAlertAt: null,
    },
    update: {
      failureCount: { increment: 1 },
      lastErrorMessage: safeMessage,
      lastFailureAt: now,
    },
    select: { failureCount: true, lastAlertAt: true },
  });

  let shouldAlert = false;
  if (row.failureCount >= ALERT_AFTER_FAILURES && row.lastAlertAt === null) {
    const claim = await client.nitradoValidationHealth.updateMany({
      where: {
        guildId,
        nitradoConnId,
        failureCount: { gte: ALERT_AFTER_FAILURES },
        lastAlertAt: null,
      },
      data: { lastAlertAt: now },
    });
    shouldAlert = claim.count === 1;
  }

  return { failureCount: row.failureCount, shouldAlert, safeMessage };
}

/** Erfolgreiche Validierung / Tokenrotation beginnt einen komplett neuen Streak. */
export async function resetValidationHealth(
  guildId: GuildId,
  nitradoConnId: NitradoConnId,
  client: ValidationHealthClient = defaultClient(),
): Promise<void> {
  await client.nitradoValidationHealth.updateMany({
    where: { guildId, nitradoConnId },
    data: {
      failureCount: 0,
      lastErrorMessage: null,
      lastFailureAt: null,
      lastAlertAt: null,
    },
  });
}

/** Slot-Loeschung entfernt auch ihren Diagnosezustand. */
export async function deleteValidationHealth(
  guildId: GuildId,
  nitradoConnId: NitradoConnId,
  client: ValidationHealthClient = defaultClient(),
): Promise<void> {
  await client.nitradoValidationHealth.deleteMany({ where: { guildId, nitradoConnId } });
}
