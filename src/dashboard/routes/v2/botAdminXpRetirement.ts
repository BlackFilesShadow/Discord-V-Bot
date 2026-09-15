import { Router } from 'express';
import { requireBotAdmin } from '../../middleware/auth';

/**
 * Fail-closed retirement shim for the former Bot-Admin XP surface.
 *
 * XP configuration is DEV-only after the Admin/DEV command migration and the
 * canonical implementation lives under `/dev/command-center/xp/:guildId`.
 * The legacy BotAdmin implementation used `XpConfig.findFirst()` and could
 * therefore mutate an arbitrary guild's first config row. Intercept the old
 * surface before `botAdminRouter` so stale clients cannot reach that path.
 */
export const botAdminXpRetirementRouter = Router();
// Pfadgebunden statt global: ein ungebundenes .use(requireBotAdmin) wuerde JEDE
// Anfrage unter /bot-admin abfangen (auch /login und /status, die von hier aus
// nie erreichbar sein sollen), bevor botAdminRouter ueberhaupt drankommt.
botAdminXpRetirementRouter.use('/xp', requireBotAdmin);

botAdminXpRetirementRouter.use('/xp', (_req, res) => {
  res.status(410).json({
    error: 'XP-Konfiguration wurde in den DEV Command Center verschoben.',
    code: 'BOTADMIN_XP_RETIRED',
    replacement: '/dev/command-center',
  });
});
