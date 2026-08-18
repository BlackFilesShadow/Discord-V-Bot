import { randomUUID } from 'node:crypto';
import prisma from '../../database/prisma';

/** RUNNING-Claims gelten ohne erfolgreichen Heartbeat nach fuenf Minuten als verwaist. */
export const NITRADO_JOB_LEASE_STALE_MS = 5 * 60 * 1000;
/** Heartbeat deutlich unterhalb der Stale-Grenze, damit kurze DB-Jitter toleriert werden. */
export const NITRADO_JOB_HEARTBEAT_INTERVAL_MS = 60 * 1000;

export interface NitradoJobClaim {
  id: string;
  guildId: string;
  claimToken: string;
}

export interface ClaimedJobTransition {
  status: 'PENDING' | 'DONE' | 'DEAD';
  attempts?: number;
  lastError?: string | null;
  nextRunAt?: Date;
  updatedAt: Date;
  payload?: Record<string, never>;
}

/**
 * Atomarer PENDING -> RUNNING Claim inklusive durable Lease.
 *
 * Falls aus einem frueheren Crash inkonsistent noch eine Lease an einem
 * PENDING-Job haengt, darf sie nach dem erfolgreichen Status-CAS sicher
 * ersetzt werden: Ein rechtmaessiger aktiver Owner kann zu diesem Zeitpunkt
 * keinen RUNNING-Claim mehr besitzen.
 */
export async function claimNitradoJob(
  args: { id: string; guildId: string; now?: Date },
): Promise<NitradoJobClaim | null> {
  const now = args.now ?? new Date();
  const claimToken = randomUUID();

  return prisma.$transaction(async tx => {
    const claimed = await tx.nitradoJob.updateMany({
      where: { id: args.id, guildId: args.guildId, status: 'PENDING' },
      data: { status: 'RUNNING', updatedAt: now },
    });
    if (claimed.count !== 1) return null;

    await tx.nitradoJobLease.deleteMany({ where: { jobId: args.id } });
    await tx.nitradoJobLease.create({
      data: {
        jobId: args.id,
        guildId: args.guildId,
        claimToken,
        claimedAt: now,
        heartbeatAt: now,
      },
    });

    return { id: args.id, guildId: args.guildId, claimToken };
  });
}

/** Verlaengert ausschliesslich die aktuell besessene Lease. */
export async function heartbeatNitradoJobClaim(
  claim: NitradoJobClaim,
  now = new Date(),
): Promise<boolean> {
  const result = await prisma.nitradoJobLease.updateMany({
    where: {
      jobId: claim.id,
      guildId: claim.guildId,
      claimToken: claim.claimToken,
    },
    data: { heartbeatAt: now },
  });
  return result.count === 1;
}

/**
 * Fuehrt einen terminalen oder Retry-Zustandswechsel nur fuer den aktuellen
 * Lease-Owner aus. Die Lease wird im selben DB-Commit entfernt.
 *
 * Reihenfolge innerhalb der Transaktion ist absichtlich Lease-CAS -> Job-CAS:
 * Wer die Lease nicht mit seinem Claim-Token loeschen kann, darf den Job nicht
 * mehr veraendern. Schlaegt danach der Job-CAS fehl, wird die Lease-Loeschung
 * durch den Throw ebenfalls zurueckgerollt.
 */
export async function transitionClaimedNitradoJob(
  claim: NitradoJobClaim,
  data: ClaimedJobTransition,
): Promise<boolean> {
  return prisma.$transaction(async tx => {
    const owned = await tx.nitradoJobLease.deleteMany({
      where: {
        jobId: claim.id,
        guildId: claim.guildId,
        claimToken: claim.claimToken,
      },
    });
    if (owned.count !== 1) return false;

    const updated = await tx.nitradoJob.updateMany({
      where: { id: claim.id, guildId: claim.guildId, status: 'RUNNING' },
      data,
    });
    if (updated.count !== 1) {
      throw new Error(`NitradoJob ${claim.id}: Lease besessen, RUNNING-Job fuer Transition nicht gefunden.`);
    }
    return true;
  });
}

/**
 * Recovery fuer gecrashte Worker.
 *
 * 1. Durable Leases werden nur nach stale `heartbeatAt` enteignet und im
 *    selben Commit auf PENDING zurueckgesetzt.
 * 2. Fuer rolling deployments werden Legacy-RUNNING-Jobs ohne Lease weiterhin
 *    nach stale `updatedAt` recovered. Sobald alle alten Worker verschwunden
 *    sind, ist dieser Pfad nur noch ein Fail-Safe fuer Inkonsistenzen.
 */
export async function recoverStaleNitradoJobClaims(
  now = new Date(),
  staleMs = NITRADO_JOB_LEASE_STALE_MS,
): Promise<number> {
  const staleBefore = new Date(now.getTime() - staleMs);
  let recovered = 0;

  // eslint-disable-next-line local/no-unscoped-prisma-query -- globaler Worker-Recovery-Sweep ueber die eigene Outbox-Lease-Tabelle.
  const leases = await prisma.nitradoJobLease.findMany({
    where: { heartbeatAt: { lt: staleBefore } },
    select: { jobId: true, guildId: true, claimToken: true },
    take: 200,
  });

  for (const lease of leases) {
    const didRecover = await prisma.$transaction(async tx => {
      const removed = await tx.nitradoJobLease.deleteMany({
        where: {
          jobId: lease.jobId,
          guildId: lease.guildId,
          claimToken: lease.claimToken,
          heartbeatAt: { lt: staleBefore },
        },
      });
      if (removed.count !== 1) return false;

      const job = await tx.nitradoJob.updateMany({
        where: { id: lease.jobId, guildId: lease.guildId, status: 'RUNNING' },
        data: { status: 'PENDING', updatedAt: now },
      });
      return job.count === 1;
    });
    if (didRecover) recovered += 1;
  }

  // eslint-disable-next-line local/no-unscoped-prisma-query -- bounded rolling-deploy recovery fuer RUNNING-Outbox-Jobs ohne Lease.
  const legacyRunning = await prisma.nitradoJob.findMany({
    where: { status: 'RUNNING', updatedAt: { lt: staleBefore } },
    select: { id: true, guildId: true },
    take: 200,
  });

  for (const job of legacyRunning) {
    const lease = await prisma.nitradoJobLease.findUnique({
      where: { jobId: job.id },
      select: { jobId: true },
    });
    if (lease) continue;

    const result = await prisma.nitradoJob.updateMany({
      where: {
        id: job.id,
        guildId: job.guildId,
        status: 'RUNNING',
        updatedAt: { lt: staleBefore },
      },
      data: { status: 'PENDING', updatedAt: now },
    });
    if (result.count === 1) recovered += 1;
  }

  return recovered;
}
