import { Router } from 'express';
import { requireGuildOwner } from '../../middleware/auth';
import { logAuditDb } from '../../../utils/logger';
import {
  getLeaveCleanupConfig,
  setLeaveCleanupConfig,
  type LeaveCleanupConfig,
} from '../../../modules/moderation/leaveCleanupConfig';

export const leaveCleanupRouter = Router({ mergeParams: true });

interface LeaveCleanupBody {
  deletePlayerDataOnLeave?: unknown;
}

function parseBody(body: LeaveCleanupBody): LeaveCleanupConfig | null {
  if (typeof body.deletePlayerDataOnLeave !== 'boolean') return null;
  return { deletePlayerDataOnLeave: body.deletePlayerDataOnLeave };
}

leaveCleanupRouter.get('/config', requireGuildOwner, async (req, res) => {
  const scope = req.guildScope!;
  res.json(await getLeaveCleanupConfig(scope.guildId));
});

leaveCleanupRouter.post('/config', requireGuildOwner, async (req, res) => {
  const scope = req.guildScope!;
  const parsed = parseBody(req.body as LeaveCleanupBody);
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
