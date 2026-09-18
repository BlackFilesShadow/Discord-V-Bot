import { Router } from 'express';
import type { Response } from 'express';
import prisma from '../../../database/prisma';
import { config } from '../../../config';
import { decrypt } from '../../../utils/security';
import { logAuditDb } from '../../../utils/logger';
import { requireGuildPermission } from '../../middleware/auth';
import { resolveDashboardGameServer, sendDashboardServerResolutionError } from './serverScope';
import { NitradoApiError, NitradoClient } from '../../../modules/nitrado/nitradoClient';
import {
  canonicalizeRestartPlanInput,
  concreteDailyRestartClock,
  isRestartTask,
  taskCatalogSupportsRestart,
} from '../../../modules/nitrado/restartTaskPlan';
import {
  clearRestartPlan,
  parsePlanTimes,
  saveRestartPlan,
  RestartPlanBindingConflictError,
} from '../../../modules/nitrado/restartTaskPlanStore';
import type { GuildScope, NitradoConnId } from '../../../types/scope';

export const nitradoTasksRouter = Router({ mergeParams: true });

interface Binding {
  id: NitradoConnId;
  nitradoServerId: string;
  encryptedToken: string;
}

async function resolveBinding(
  scope: Pick<GuildScope, 'guildId' | 'actorDiscordId'>,
  slotParam: unknown,
  res: Response,
): Promise<Binding | null> {
  const resolution = await resolveDashboardGameServer(scope.guildId, scope.actorDiscordId, slotParam);
  if (resolution.kind !== 'RESOLVED') {
    sendDashboardServerResolutionError(res, resolution);
    return null;
  }
  const row = await prisma.nitradoConnection.findFirst({
    where: {
      id: resolution.nitradoConnId,
      guildId: scope.guildId,
      status: 'ACTIVE',
      nitradoServerId: { not: null },
    },
    select: {
      id: true,
      nitradoServerId: true,
      encryptedToken: true,
    },
  });
  if (!row?.nitradoServerId) {
    res.status(409).json({
      error: 'Der ausgewaehlte Nitrado-Slot ist nicht aktiv oder besitzt keine bestaetigte Service-ID.',
      code: 'NITRADO_TASK_BINDING_UNAVAILABLE',
    });
    return null;
  }
  return {
    id: resolution.nitradoConnId,
    nitradoServerId: row.nitradoServerId,
    encryptedToken: row.encryptedToken,
  };
}

function remoteError(res: Response, error: unknown): void {
  if (error instanceof NitradoApiError) {
    res.status(error.status === 401 || error.status === 403 ? 502 : 503).json({
      error: 'Die automatischen Aufgaben konnten bei Nitrado nicht zuverlaessig gelesen werden.',
      code: 'NITRADO_TASK_REMOTE_UNAVAILABLE',
    });
    return;
  }
  throw error;
}

nitradoTasksRouter.get('/restart-plan', requireGuildPermission('nitrado.view'), async (req, res) => {
  const scope = req.guildScope!;
  const binding = await resolveBinding(scope, req.query.slot, res);
  if (!binding) return;

  const plan = await prisma.nitradoRestartPlan.findUnique({
    where: {
      guildId_nitradoConnId: {
        guildId: scope.guildId,
        nitradoConnId: binding.id,
      },
    },
  });

  try {
    const token = decrypt(binding.encryptedToken, config.security.encryptionKey);
    const api = new NitradoClient(token);
    const allTasks = await api.listTasks(binding.nitradoServerId);
    let actionSupported: boolean | null = null;
    try {
      const catalog = await api.getTaskActionCatalog(binding.nitradoServerId);
      actionSupported = taskCatalogSupportsRestart(catalog);
    } catch (error) {
      // Der Katalog ist nur ein Capability-Preflight fuer neue Tasks. Ein
      // separater Katalogfehler darf einen erfolgreich gelesenen Taskbestand
      // nicht als unbekannt verwerfen; Speichern bleibt bei null fail-closed.
      if (!(error instanceof NitradoApiError)) throw error;
    }
    const restartTasks = allTasks.filter(isRestartTask);
    const desiredTimes = plan?.enabled ? parsePlanTimes(plan.times) : [];
    const remoteConcreteTimes = restartTasks
      .map(concreteDailyRestartClock)
      .filter((value): value is string => value !== null)
      .sort((a, b) => a.localeCompare(b));
    const sortedDesired = desiredTimes.slice().sort((a, b) => a.localeCompare(b));
    const synchronized = restartTasks.length === sortedDesired.length
      && remoteConcreteTimes.length === sortedDesired.length
      && remoteConcreteTimes.every((time, index) => time === sortedDesired[index]);

    res.json({
      plan: plan ? {
        enabled: plan.enabled,
        mode: plan.mode,
        intervalHours: plan.intervalHours,
        startTime: plan.startTime,
        times: parsePlanTimes(plan.times),
        revision: plan.revision,
        syncStatus: plan.syncStatus,
        lastSyncAt: plan.lastSyncAt,
        lastSyncError: plan.lastSyncError,
        serviceBindingMatches: plan.nitradoServerId === binding.nitradoServerId,
      } : null,
      remote: {
        actionSupported,
        synchronized,
        restartTasks: restartTasks.map(task => ({
          id: task.id,
          time: concreteDailyRestartClock(task),
          hour: task.hour,
          minute: task.minute,
          day: task.day,
          month: task.month,
          weekday: task.weekday,
          lastRun: task.last_run ?? null,
          nextRun: task.next_run ?? null,
          timezone: task.timezone ?? null,
        })),
      },
    });
  } catch (error) {
    remoteError(res, error);
  }
});

nitradoTasksRouter.put('/restart-plan', requireGuildPermission('nitrado.write'), async (req, res) => {
  const scope = req.guildScope!;
  const binding = await resolveBinding(scope, req.query.slot, res);
  if (!binding) return;

  let plan;
  try {
    plan = canonicalizeRestartPlanInput(req.body);
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : 'Ungueltige Neustart-Konfiguration.',
      code: 'NITRADO_RESTART_PLAN_INVALID',
    });
    return;
  }

  let saved;
  try {
    saved = await saveRestartPlan(
      {
        guildId: scope.guildId,
        nitradoConnId: binding.id,
        nitradoServerId: binding.nitradoServerId,
      },
      scope.actorDiscordId,
      plan,
    );
  } catch (error) {
    if (error instanceof RestartPlanBindingConflictError) {
      res.status(409).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }

  logAuditDb('NITRADO_RESTART_PLAN_QUEUED', 'NITRADO', {
    actorUserId: req.auth!.userId,
    guildId: scope.guildId,
    details: {
      nitradoConnId: binding.id,
      revision: saved.revision,
      mode: plan.mode,
      times: plan.times,
    },
  });

  res.status(202).json({
    enabled: true,
    mode: plan.mode,
    intervalHours: plan.intervalHours,
    startTime: plan.startTime,
    times: plan.times,
    revision: saved.revision,
    syncStatus: saved.syncStatus,
  });
});

nitradoTasksRouter.delete('/restart-tasks', requireGuildPermission('nitrado.write'), async (req, res) => {
  const scope = req.guildScope!;
  const binding = await resolveBinding(scope, req.query.slot, res);
  if (!binding) return;

  let saved;
  try {
    saved = await clearRestartPlan(
      {
        guildId: scope.guildId,
        nitradoConnId: binding.id,
        nitradoServerId: binding.nitradoServerId,
      },
      scope.actorDiscordId,
    );
  } catch (error) {
    if (error instanceof RestartPlanBindingConflictError) {
      res.status(409).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }

  logAuditDb('NITRADO_RESTART_TASKS_CLEAR_QUEUED', 'NITRADO', {
    actorUserId: req.auth!.userId,
    guildId: scope.guildId,
    details: {
      nitradoConnId: binding.id,
      revision: saved.revision,
    },
  });

  res.status(202).json({
    enabled: false,
    times: [],
    revision: saved.revision,
    syncStatus: saved.syncStatus,
  });
});
