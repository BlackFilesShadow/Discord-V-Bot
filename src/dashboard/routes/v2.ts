/**
 * Phase 2C — REST-Routen v2 fuer das Self-Service-Dashboard.
 *
 * Mount-Punkt: /api/v2/...
 * Eigene Subroutes je Domaene; alle Mutation-Routes durch
 * `idempotency`-Middleware gesichert (Haertung A1).
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { idempotency } from '../middleware/idempotency';

import { guildsRouter } from './v2/guilds';
import { dashboardRouter } from './v2/dashboard';
import { permissionsRouter } from './v2/permissions';
import { nitradoRouter } from './v2/nitrado';
import { economyRouter } from './v2/economy';
import { economyLinkRouter } from './v2/economyLink';
import { whitelistRouter } from './v2/whitelist';
import { factionsRouter } from './v2/factions';
import { ticketsRouter } from './v2/tickets';
import { casinoRouter } from './v2/casino';
import { devRouter } from './v2/dev';
import { devUploadsRouter } from './v2/devUploads';
import { devAnalyticsRouter } from './v2/devAnalytics';
import { devStatusRouter } from './v2/devStatus';
import { devNitradoMirrorRouter } from './v2/devNitradoMirror';
import { auditRouter } from './v2/audit';

export const v2Router = Router();

// requireAuth fuer ALLE v2-Routen
v2Router.use(requireAuth);
// Idempotenz fuer Schreib-Routen
v2Router.use(idempotency);

v2Router.use('/guilds', guildsRouter); // listet eigene Guilds
v2Router.use('/guilds/:guildId/dashboard', dashboardRouter);
v2Router.use('/guilds/:guildId/permissions', permissionsRouter);
v2Router.use('/guilds/:guildId/nitrado', nitradoRouter);
v2Router.use('/guilds/:guildId/tickets', ticketsRouter);
v2Router.use('/guilds/:guildId/whitelist', whitelistRouter);
v2Router.use('/guilds/:guildId/factions', factionsRouter);
v2Router.use('/guilds/:guildId/economy', economyRouter);
v2Router.use('/guilds/:guildId/economy-links', economyLinkRouter);
v2Router.use('/guilds/:guildId/casino', casinoRouter);
v2Router.use('/guilds/:guildId/audit', auditRouter);
v2Router.use('/dev/uploads', devUploadsRouter);
v2Router.use('/dev/analytics', devAnalyticsRouter);
v2Router.use('/dev/status', devStatusRouter);
v2Router.use('/dev/nitrado-mirror', devNitradoMirrorRouter);
v2Router.use('/dev', devRouter);
