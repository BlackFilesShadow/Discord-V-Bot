import crypto from 'node:crypto';
import prisma from '../../../database/prisma';

export const MIRROR_LEASE_MS = 5 * 60_000;
export const MIRROR_HEARTBEAT_MS = 30_000;
const LEASE_ACQUIRE_ATTEMPTS = 3;
const RECOVERY_ERROR = 'Nitrado-Mirror nach abgelaufener Lease als verwaist beendet.';

export class NitradoMirrorLeaseLostError extends Error {
  constructor() {
    super('Nitrado-Mirror-Lease ist abgelaufen oder wurde durch Recovery ersetzt.');
    this.name = 'NitradoMirrorLeaseLostError';
  }
}

export interface MirrorLeaseAcquisition {
  snapshotId: string;
  leaseToken: string | null;
  reused: boolean;
}

export interface MirrorLeaseMutationClient {
  nitradoMirrorLease: {
    updateMany(args: unknown): Promise<{ count: number }>;
  };
}

function retryableTransactionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'P2002' || code === 'P2034';
}

function leaseUntil(now: Date): Date {
  return new Date(now.getTime() + MIRROR_LEASE_MS);
}

/**
 * Persistente per-Connection Singleflight-Grenze. Die Serializable-Transaktion
 * stellt sicher, dass zwei parallele Erst-Trigger nicht zwei aktive Snapshots
 * etablieren koennen. Ein kollidierender Create/Serialization-Fehler wird
 * bounded erneut gelesen; der Verlierer verwendet danach die Gewinner-Lease.
 */
export async function acquireMirrorSnapshotLease(input: {
  guildId: string;
  nitradoConnId: string;
  serviceId: string;
  triggeredBy: string;
}): Promise<MirrorLeaseAcquisition> {
  for (let attempt = 1; attempt <= LEASE_ACQUIRE_ATTEMPTS; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const now = new Date();
        const key = {
          guildId_nitradoConnId: {
            guildId: input.guildId,
            nitradoConnId: input.nitradoConnId,
          },
        };
        const existing = await tx.nitradoMirrorLease.findUnique({ where: key });
        if (existing) {
          const snapshot = await tx.nitradoSnapshot.findFirst({
            where: {
              id: existing.snapshotId,
              guildId: input.guildId,
              nitradoConnId: input.nitradoConnId,
            },
            select: { id: true, status: true },
          });

          // Die Lease bleibt absichtlich auch waehrend der terminalen Snapshot-
          // Finalisierung + LIVE_SERVER-Indexierung aktiv. Solange sie gueltig
          // ist, darf kein zweiter Lauf derselben Connection starten.
          if (snapshot && existing.leaseExpiresAt.getTime() > now.getTime()) {
            return { snapshotId: snapshot.id, leaseToken: null, reused: true };
          }

          // Crash-/Restart-Recovery: Nur der noch RUNNING markierte alte Lauf
          // wird terminalisiert. Bereits fertige Snapshots werden nie umgeschrieben.
          if (snapshot?.status === 'RUNNING') {
            await tx.nitradoSnapshot.updateMany({
              where: {
                id: snapshot.id,
                guildId: input.guildId,
                nitradoConnId: input.nitradoConnId,
                status: 'RUNNING',
              },
              data: {
                status: 'FAILED',
                finishedAt: now,
                lastError: RECOVERY_ERROR,
              },
            });
          }
          await tx.nitradoMirrorLease.deleteMany({
            where: {
              guildId: input.guildId,
              nitradoConnId: input.nitradoConnId,
              leaseToken: existing.leaseToken,
            },
          });
        }

        const snapshot = await tx.nitradoSnapshot.create({
          data: {
            guildId: input.guildId,
            nitradoConnId: input.nitradoConnId,
            serviceId: input.serviceId,
            status: 'RUNNING',
            triggeredBy: input.triggeredBy,
          },
          select: { id: true },
        });
        const leaseToken = crypto.randomUUID();
        await tx.nitradoMirrorLease.create({
          data: {
            guildId: input.guildId,
            nitradoConnId: input.nitradoConnId,
            snapshotId: snapshot.id,
            leaseToken,
            heartbeatAt: now,
            leaseExpiresAt: leaseUntil(now),
          },
        });
        return { snapshotId: snapshot.id, leaseToken, reused: false };
      }, { isolationLevel: 'Serializable' });
    } catch (error) {
      if (attempt < LEASE_ACQUIRE_ATTEMPTS && retryableTransactionError(error)) continue;
      throw error;
    }
  }
  throw new Error('Nitrado-Mirror-Lease konnte nicht erworben werden.');
}

/** Erneuert nur eine noch gueltige, exakt tokengebundene Lease. */
export async function renewMirrorSnapshotLease(input: {
  guildId: string;
  nitradoConnId: string;
  snapshotId: string;
  leaseToken: string;
}): Promise<void> {
  await refreshMirrorLeaseForCommit(prisma as unknown as MirrorLeaseMutationClient, input);
}

/**
 * Frischt die Lease auf einem beliebigen Prisma-Client auf. Innerhalb einer
 * Transaktion ist dies bewusst ein UPDATE: PostgreSQL haelt dadurch den Row-Lock
 * bis zum Commit. Eine parallele Recovery kann die Lease nicht ersetzen, waehrend
 * LIVE_SERVER-Wissen fuer diesen Snapshot committed wird.
 */
export async function refreshMirrorLeaseForCommit(
  client: MirrorLeaseMutationClient,
  input: {
    guildId: string;
    nitradoConnId: string;
    snapshotId: string;
    leaseToken: string;
  },
): Promise<void> {
  const now = new Date();
  const updated = await client.nitradoMirrorLease.updateMany({
    where: {
      guildId: input.guildId,
      nitradoConnId: input.nitradoConnId,
      snapshotId: input.snapshotId,
      leaseToken: input.leaseToken,
      leaseExpiresAt: { gt: now },
    },
    data: {
      heartbeatAt: now,
      leaseExpiresAt: leaseUntil(now),
    },
  });
  if (updated.count !== 1) throw new NitradoMirrorLeaseLostError();
}

/**
 * Terminalisiert einen Snapshot nur, solange dieser Prozess die exakte,
 * unexpired Lease noch besitzt. Die Lease bleibt danach absichtlich bestehen,
 * bis die nachgelagerte LIVE_SERVER-Indexierung fertig oder verworfen ist.
 */
export async function finalizeMirrorSnapshotLease(input: {
  guildId: string;
  nitradoConnId: string;
  snapshotId: string;
  leaseToken: string;
  status: 'OK' | 'PARTIAL' | 'FAILED';
  totalFiles: number;
  totalDirs: number;
  totalBytes: bigint;
  storedBytes: bigint;
  oversizeFiles: number;
  errorCount: number;
  lastError: string | null;
}): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    try {
      await refreshMirrorLeaseForCommit(tx as unknown as MirrorLeaseMutationClient, input);
    } catch (error) {
      if (error instanceof NitradoMirrorLeaseLostError) return false;
      throw error;
    }

    const finishedAt = new Date();
    const updated = await tx.nitradoSnapshot.updateMany({
      where: {
        id: input.snapshotId,
        guildId: input.guildId,
        nitradoConnId: input.nitradoConnId,
        status: 'RUNNING',
      },
      data: {
        status: input.status,
        finishedAt,
        totalFiles: input.totalFiles,
        totalDirs: input.totalDirs,
        totalBytes: input.totalBytes,
        storedBytes: input.storedBytes,
        oversizeFiles: input.oversizeFiles,
        errorCount: input.errorCount,
        lastError: input.lastError,
      },
    });
    return updated.count === 1;
  });
}

/** Gibt ausschliesslich die exakt tokengebundene Lease frei. */
export async function releaseMirrorSnapshotLease(input: {
  guildId: string;
  nitradoConnId: string;
  snapshotId: string;
  leaseToken: string;
}): Promise<boolean> {
  const released = await prisma.nitradoMirrorLease.deleteMany({
    where: {
      guildId: input.guildId,
      nitradoConnId: input.nitradoConnId,
      snapshotId: input.snapshotId,
      leaseToken: input.leaseToken,
    },
  });
  return released.count === 1;
}
