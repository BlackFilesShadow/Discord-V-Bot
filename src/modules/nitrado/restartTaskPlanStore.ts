import { Prisma } from '@prisma/client';
import prisma from '../../database/prisma';
import type { GuildId, NitradoConnId, UserDiscordId } from '../../types/scope';
import type { CanonicalRestartPlan } from './restartTaskPlan';

export const RESTART_PLAN_SYNC_OPERATION = 'RESTART_PLAN_SYNC';
const RESTART_PLAN_MAX_ATTEMPTS = 8;

async function serializableRestartPlanMutation<T>(
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await prisma.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if ((code !== 'P2034' && code !== 'P2002') || attempt === maxAttempts) throw error;
    }
  }
  throw new Error('Restart-Plan-Transaktion konnte nicht abgeschlossen werden.');
}

export interface RestartPlanScope {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  nitradoServerId: string;
}

export async function saveRestartPlan(
  scope: RestartPlanScope,
  actorDiscordId: UserDiscordId,
  plan: CanonicalRestartPlan,
) {
  return serializableRestartPlanMutation(async tx => {
    const current = await tx.nitradoRestartPlan.findUnique({
      where: {
        guildId_nitradoConnId: {
          guildId: scope.guildId,
          nitradoConnId: scope.nitradoConnId,
        },
      },
      select: { revision: true },
    });
    const revision = (current?.revision ?? 0) + 1;
    const row = await tx.nitradoRestartPlan.upsert({
      where: {
        guildId_nitradoConnId: {
          guildId: scope.guildId,
          nitradoConnId: scope.nitradoConnId,
        },
      },
      create: {
        guildId: scope.guildId,
        nitradoConnId: scope.nitradoConnId,
        nitradoServerId: scope.nitradoServerId,
        enabled: true,
        mode: plan.mode,
        intervalHours: plan.intervalHours,
        startTime: plan.startTime,
        times: plan.times,
        revision,
        syncStatus: 'PENDING',
        lastSyncAt: null,
        lastSyncError: null,
        updatedByDiscordId: actorDiscordId,
      },
      update: {
        nitradoServerId: scope.nitradoServerId,
        enabled: true,
        mode: plan.mode,
        intervalHours: plan.intervalHours,
        startTime: plan.startTime,
        times: plan.times,
        revision,
        syncStatus: 'PENDING',
        lastSyncError: null,
        updatedByDiscordId: actorDiscordId,
      },
    });

    // Noch nicht geclaimte aeltere Plan-Syncs sind durch die neue Revision
    // superseded. RUNNING-Jobs bleiben unangetastet und werden im Worker vor
    // jeder Remote-Mutation erneut gegen die aktuelle Revision gefenced.
    await tx.nitradoJob.updateMany({
      where: {
        guildId: scope.guildId,
        nitradoConnId: scope.nitradoConnId,
        operation: RESTART_PLAN_SYNC_OPERATION,
        status: 'PENDING',
      },
      data: {
        status: 'DONE',
        lastError: 'Durch neuere Restart-Plan-Revision ersetzt.',
        updatedAt: new Date(),
      },
    });

    await tx.nitradoJob.create({
      data: {
        guildId: scope.guildId,
        nitradoConnId: scope.nitradoConnId,
        operation: RESTART_PLAN_SYNC_OPERATION,
        payload: { planRevision: revision },
        status: 'PENDING',
        maxAttempts: RESTART_PLAN_MAX_ATTEMPTS,
        nextRunAt: new Date(),
      },
    });
    return row;
  });
}

export async function clearRestartPlan(
  scope: RestartPlanScope,
  actorDiscordId: UserDiscordId,
) {
  return serializableRestartPlanMutation(async tx => {
    const current = await tx.nitradoRestartPlan.findUnique({
      where: {
        guildId_nitradoConnId: {
          guildId: scope.guildId,
          nitradoConnId: scope.nitradoConnId,
        },
      },
      select: {
        revision: true,
        mode: true,
        intervalHours: true,
        startTime: true,
      },
    });
    const revision = (current?.revision ?? 0) + 1;
    const row = await tx.nitradoRestartPlan.upsert({
      where: {
        guildId_nitradoConnId: {
          guildId: scope.guildId,
          nitradoConnId: scope.nitradoConnId,
        },
      },
      create: {
        guildId: scope.guildId,
        nitradoConnId: scope.nitradoConnId,
        nitradoServerId: scope.nitradoServerId,
        enabled: false,
        mode: 'INTERVAL',
        intervalHours: 4,
        startTime: '00:00',
        times: [],
        revision,
        syncStatus: 'PENDING',
        lastSyncAt: null,
        lastSyncError: null,
        updatedByDiscordId: actorDiscordId,
      },
      update: {
        nitradoServerId: scope.nitradoServerId,
        enabled: false,
        times: [],
        revision,
        syncStatus: 'PENDING',
        lastSyncError: null,
        updatedByDiscordId: actorDiscordId,
      },
    });

    await tx.nitradoJob.updateMany({
      where: {
        guildId: scope.guildId,
        nitradoConnId: scope.nitradoConnId,
        operation: RESTART_PLAN_SYNC_OPERATION,
        status: 'PENDING',
      },
      data: {
        status: 'DONE',
        lastError: 'Durch neuere Restart-Plan-Revision ersetzt.',
        updatedAt: new Date(),
      },
    });
    await tx.nitradoJob.create({
      data: {
        guildId: scope.guildId,
        nitradoConnId: scope.nitradoConnId,
        operation: RESTART_PLAN_SYNC_OPERATION,
        payload: { planRevision: revision },
        status: 'PENDING',
        maxAttempts: RESTART_PLAN_MAX_ATTEMPTS,
        nextRunAt: new Date(),
      },
    });
    return row;
  });
}

export function parsePlanTimes(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) return [];
  return value;
}

export async function markRestartPlanSyncPendingError(args: {
  guildId: string;
  nitradoConnId: string;
  revision: number;
  message: string;
}): Promise<void> {
  await prisma.nitradoRestartPlan.updateMany({
    where: {
      guildId: args.guildId,
      nitradoConnId: args.nitradoConnId,
      revision: args.revision,
    },
    data: {
      syncStatus: 'ERROR',
      lastSyncError: args.message.slice(0, 1000),
    },
  });
}

export async function markRestartPlanSynced(args: {
  guildId: string;
  nitradoConnId: string;
  revision: number;
}): Promise<void> {
  await prisma.nitradoRestartPlan.updateMany({
    where: {
      guildId: args.guildId,
      nitradoConnId: args.nitradoConnId,
      revision: args.revision,
    },
    data: {
      syncStatus: 'SYNCED',
      lastSyncAt: new Date(),
      lastSyncError: null,
    },
  });
}
