/**
 * PermaOnly-Cron — haelt Nitrado-Server permanent online.
 *
 * Pro Iteration:
 *   - Findet alle ServerSettings mit `permaOnly=true`
 *   - Joint NitradoConnection (status=ACTIVE, nitradoServerId vorhanden)
 *   - Enqueued pro Slot einen `RESTART_IF_DOWN`-Job (Worker prueft Status
 *     und startet nur wenn wirklich gestoppt) — Idempotenz-Schutz: wir
 *     enqueuen NICHT, wenn bereits ein PENDING/RUNNING-Job derselben Op
 *     fuer dieselbe Connection existiert.
 *
 * Intervall: 3 Minuten (Nitrado API rate limit-safe; ein Cold-Start
 * dauert eh 30-60s).
 *
 * Single-instance: simpler `running`-Flag.
 */

import prisma from '../../database/prisma';
import { logger } from '../../utils/logger';

const POLL_INTERVAL_MS = 3 * 60 * 1000; // 3 min

let timer: NodeJS.Timeout | null = null;
let running = false;

async function pollOnce(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // eslint-disable-next-line local/no-unscoped-prisma-query -- Cron iteriert alle Guilds; jeder Job ist guild-scoped via job.guildId.
    const slots = await prisma.serverSettings.findMany({
      where: { permaOnly: true },
      select: {
        guildId: true,
        nitradoConnId: true,
        nitradoConn: {
          select: { id: true, status: true, nitradoServerId: true },
        },
      },
    });

    let enqueued = 0;
    for (const slot of slots) {
      const conn = slot.nitradoConn;
      if (!conn || conn.status !== 'ACTIVE' || !conn.nitradoServerId) continue;

      // Idempotenz: bereits laufender RESTART_IF_DOWN-Job fuer diese Conn?
      const existing = await prisma.nitradoJob.findFirst({
        where: {
          guildId: slot.guildId,
          nitradoConnId: slot.nitradoConnId,
          operation: 'RESTART_IF_DOWN',
          status: { in: ['PENDING', 'RUNNING'] },
        },
        select: { id: true },
      });
      if (existing) continue;

      await prisma.nitradoJob.create({
        data: {
          guildId: slot.guildId,
          nitradoConnId: slot.nitradoConnId,
          operation: 'RESTART_IF_DOWN',
          payload: {},
          status: 'PENDING',
          attempts: 0,
          maxAttempts: 3,
          nextRunAt: new Date(),
        },
      });
      enqueued++;
    }

    if (enqueued > 0) {
      logger.info(`PermaOnly-Cron: ${enqueued}/${slots.length} RESTART_IF_DOWN-Job(s) enqueued`);
    }
  } catch (e) {
    logger.error('PermaOnly-Cron-Fehler:', e as Error);
  } finally {
    running = false;
  }
}

export function startPermaOnlyCron(): void {
  if (timer) return;
  logger.info(`PermaOnly-Cron gestartet (Intervall ${POLL_INTERVAL_MS / 60_000} min)`);
  // Erst-Lauf nach 60s.
  setTimeout(() => { void pollOnce(); }, 60_000);
  timer = setInterval(() => { void pollOnce(); }, POLL_INTERVAL_MS);
}

export function stopPermaOnlyCron(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
