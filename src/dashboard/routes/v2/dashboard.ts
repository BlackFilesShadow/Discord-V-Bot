/**
 * GET  /api/v2/guilds/:guildId/dashboard
 *   -> Aggregierter State: alias5, alle Slots (mit alias+alias5), Permission-Grants-Count.
 */
import { Router } from 'express';
import { requireGuildPermission } from '../../middleware/auth';
import { getOrCreate as getOrCreateLink } from '../../../modules/dashboard/repository';
import { listSlots } from '../../../modules/nitrado/repository';
import { listGrants } from '../../../modules/permissions/repository';
import { asUserDiscordId } from '../../../types/scope';

export const dashboardRouter = Router({ mergeParams: true });

// Lese-Recht: irgendeine view-Permission reicht; aber Owner-Bypass ist
// eingebaut. Wir nutzen 'whitelist.view' als billigste Standard-Permission;
// wer das nicht hat, hat sowieso nichts auf dem Dashboard zu suchen.
dashboardRouter.get('/', requireGuildPermission('whitelist.view'), async (req, res) => {
  const scope = req.guildScope!;
  const link = await getOrCreateLink(scope.guildId, asUserDiscordId(scope.actorDiscordId));
  const [slots, grants] = await Promise.all([
    listSlots(scope.guildId),
    listGrants(scope.guildId),
  ]);
  res.json({
    guildId: scope.guildId,
    alias5: link.alias5,
    isOwner: scope.isOwner,
    permissions: Array.from(scope.permissions),
    slots: slots.map(s => ({
      id: s.id,
      slot: s.slot,
      alias: s.alias,
      alias5: s.alias5,
      status: s.status,
      nitradoServerId: s.nitradoServerId,
    })),
    grantsCount: grants.length,
  });
});
