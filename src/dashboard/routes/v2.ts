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
import { killfeedRouter } from './v2/killfeed';
import { welcomeRouter } from './v2/welcome';
import { devRouter } from './v2/dev';
import { devUploadsRouter } from './v2/devUploads';
import { devAnalyticsRouter } from './v2/devAnalytics';
import { devStatusRouter } from './v2/devStatus';
import { devNitradoMirrorRouter } from './v2/devNitradoMirror';
import { devIncidentRouter } from './v2/devIncident';
import { devObservabilityRouter } from './v2/devObservability';
import { devStubsRouter } from './v2/devStubs';
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
v2Router.use('/guilds/:guildId/killfeed', killfeedRouter);
v2Router.use('/guilds/:guildId/welcome', welcomeRouter);
v2Router.use('/guilds/:guildId/audit', auditRouter);
// WICHTIG: devRouter MUSS vor allen spezifischeren /dev/* Sub-Routern stehen.
// Grund: devStatusRouter (mounted /dev/status) installiert requireDev als
// Router-Middleware. Ohne diese Reihenfolge wuerde GET /api/v2/dev/status
// (das im devRouter ohne requireDev liegt, damit das Frontend Eligibility
// pollen kann) durch requireDev mit 403 abgebrochen — Login + UI brechen.
// devRouter ruft fuer nicht registrierte Pfade next() auf und faellt sauber
// auf die spezifischeren Sub-Router durch.
v2Router.use('/dev', devRouter);
v2Router.use('/dev/uploads', devUploadsRouter);
v2Router.use('/dev/analytics', devAnalyticsRouter);
v2Router.use('/dev/status', devStatusRouter);
v2Router.use('/dev/nitrado-mirror', devNitradoMirrorRouter);
v2Router.use('/dev/incident', devIncidentRouter);
v2Router.use('/dev/observability', devObservabilityRouter);
v2Router.use('/dev/stubs', devStubsRouter);
