import crypto from 'node:crypto';
import prisma from '../../../database/prisma';

export const MIRROR_LEASE_MS = 5 * 60_000;
export const MIRROR_HEARTBEAT_MS = 30_000;
const LEASE_ACQUIRE_ATTEMPTS = 3;
const RECOVERY_ERROR = 'Nitrado-Mirror-Lease abgelaufen oder Binding wurde ersetzt.';

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

export function mirrorLeaseBindingKey(input: {
  encryptedToken: string;
  nitradoServerId: string;
  bindingVersion: number;
}): string {
  if (!Number.isSafeInteger(input.bindingVersion) || input.bindingVersion < 0) {
    throw new Error('Ungueltige Mirror-Binding-Version.');
  }
  return crypto
    .createHash('sha256')
    .update(input.encryptedToken)
    .update('\0')
    .update(input.nitradoServerId)
    .update('\0')
    .update(String(input.bindingVersion))
    .digest('hex');
}

function retryableTransactionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'P2002' || code === 'P2034';
}

function leaseUntil(now: Date): Date {
  return new Date(now.getTime() + MIRROR_LEASE_MS);
}

export async function acquireMirrorSnapshotLease(input: {
  guildId: string;
  nitradoConnId: string;
  serviceId: string;
  bindingKey: string;
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

          // Nur exakt dieselbe Token-/Service-/Binding-Generation darf einen
          // aktiven Lauf wiederverwenden. Tokenrotation oder Service-Rebind
          // fenced den alten Lauf sofort aus, auch wenn seine Zeit-Lease noch lebt.
          if (
            snapshot
            && existing.bindingKey === input.bindingKey
            && existing.leaseExpiresAt.getTime() > now.getTime()
          ) {
            return { snapshotId: snapshot.id, leaseToken: null, reused: true };
          }

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
            bindingKey: input.bindingKey,
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

export async function renewMirrorSnapshotLease(input: {
  guildId: string;
  nitradoConnId: string;
  snapshotId: string;
  leaseToken: string;
}): Promise<void> {
  await refreshMirrorLeaseForCommit(prisma as unknown as MirrorLeaseMutationClient, input);
}

/**
 * Das UPDATE dient zugleich als Freshness-CAS und als Row-Lock bis zum Ende der
 * umgebenden Transaktion. Eine parallele Recovery kann dadurch einen laufenden
 * LIVE_SERVER-Knowledge-Commit nicht ueberholen.
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

    const updated = await tx.nitradoSnapshot.updateMany({
      where: {
        id: input.snapshotId,
        guildId: input.guildId,
        nitradoConnId: input.nitradoConnId,
        status: 'RUNNING',
      },
      data: {
        status: input.status,
        finishedAt: new Date(),
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
