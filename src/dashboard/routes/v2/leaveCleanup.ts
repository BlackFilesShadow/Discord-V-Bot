import { Router } from 'express';
import { requireGuildPermission } from '../../middleware/auth';
import { logAuditDb } from '../../../utils/logger';
import {
  getLeaveCleanupConfig,
  setLeaveCleanupConfig,
  type LeaveCleanupConfig,
} from '../../../modules/moderation/leaveCleanupConfig';

export const leaveCleanupRouter = Router({ mergeParams: true });

function parseBody(body: unknown): LeaveCleanupConfig | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const value = (body as Record<string, unknown>).deletePlayerDataOnLeave;
  if (typeof value !== 'boolean') return null;
  return { deletePlayerDataOnLeave: value };
}

leaveCleanupRouter.get('/config', requireGuildPermission('dashboard.access'), async (req, res) => {
  const scope = req.guildScope!;
  res.json(await getLeaveCleanupConfig(scope.guildId));
});

leaveCleanupRouter.post('/config', requireGuildPermission('dashboard.access'), async (req, res) => {
  const scope = req.guildScope!;
  const parsed = parseBody(req.body);
  if (!parsed) {
    res.status(400).json({ error: 'deletePlayerDataOnLeave muss boolean sein.' });
    return;
  }

  const saved = await setLeaveCleanupConfig(scope.guildId, parsed, scope.actorDiscordId);
  logAuditDb('LEAVE_CLEANUP_CONFIG_SAVED', 'MODERATION', {
    actorUserId: req.auth!.userId,
    guildId: scope.guildId,
    details: { deletePlayerDataOnLeave: saved.deletePlayerDataOnLeave },
  });
  res.json(saved);
});
