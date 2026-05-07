/**
 * Audit-Log-Retention-Scheduler.
 *
 * Zweck (P0-Hardening, Compliance/DSGVO):
 * Audit-Logs wachsen unbegrenzt. Daily-Job loescht Eintraege aelter als
 * `AUDIT_LOG_RETENTION_DAYS` (Default 90). Run laeuft 1x bei Boot (sofort,
 * mit kurzem Delay) und dann alle 24h. unref() damit ein offener Handle
 * den Bot-Shutdown nicht blockiert.
 *
 * ENV:
 *   AUDIT_LOG_RETENTION_DAYS     Anzahl Tage (default 90; 0 = deaktiviert)
 *
 * Sicherheit:
 *   - Loescht NUR isImmutable=false (immutable Eintraege bleiben unangetastet).
 *   - Batched per `deleteMany` mit `lt`-Cutoff — keine Pagination noetig
 *     (Postgres handled das transaktional).
 */
import prisma from '../../database/prisma';
import { logger } from '../../utils/logger';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 60_000; // 1 min nach Boot, damit ready/restore zuerst durchlaufen

let scheduled = false;

function getRetentionDays(): number {
  const raw = Number(process.env.AUDIT_LOG_RETENTION_DAYS ?? 90);
  if (!Number.isFinite(raw) || raw < 0) return 90;
  return Math.floor(raw);
}

export async function runAuditLogRetentionOnce(): Promise<{ deleted: number; cutoff: Date | null }> {
  const days = getRetentionDays();
  if (days === 0) {
    logger.info('auditLogRetention: deaktiviert (AUDIT_LOG_RETENTION_DAYS=0)');
    return { deleted: 0, cutoff: null };
  }
  const cutoff = new Date(Date.now() - days * ONE_DAY_MS);
  try {
    const res = await prisma.auditLog.deleteMany({
      where: {
        createdAt: { lt: cutoff },
        isImmutable: false,
      },
    });
    if (res.count > 0) {
      logger.info(`auditLogRetention: ${res.count} Eintraege geloescht (cutoff ${cutoff.toISOString()}, retentionDays=${days})`);
    }
    return { deleted: res.count, cutoff };
  } catch (e) {
    logger.warn('auditLogRetention: deleteMany fehlgeschlagen', { err: (e as Error).message });
    return { deleted: 0, cutoff };
  }
}

/**
 * Registriert den Daily-Run. Idempotent: mehrfache Aufrufe sind no-ops.
 */
export function startAuditLogRetentionScheduler(): void {
  if (scheduled) return;
  scheduled = true;
  // Initial-Run mit Delay (nicht sofort, um Boot nicht zu belasten).
  const initial = setTimeout(() => { void runAuditLogRetentionOnce(); }, STARTUP_DELAY_MS);
  initial.unref?.();
  // Daily.
  const interval = setInterval(() => { void runAuditLogRetentionOnce(); }, ONE_DAY_MS);
  interval.unref?.();
  logger.info(`auditLogRetention: Scheduler aktiv (retentionDays=${getRetentionDays()})`);
}
