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
import { requireGlobalDeveloperIdentity } from '../middleware/globalDeveloperGate';
import { requireGlobalBotAdminIdentity } from '../middleware/globalBotAdminGate';
import { requireSafeDashboardEconomyScope } from '../middleware/economyScopeGuard';

import { guildsRouter } from './v2/guilds';
import { dashboardRouter } from './v2/dashboard';
import { permissionsRouter } from './v2/permissions';
import { nitradoRouter } from './v2/nitrado';
import { admSourceRouter } from './v2/admSource';
import { economyRouter } from './v2/economy';
import { economyScopeRouter } from './v2/economyScope';
import { economyLinkRouter } from './v2/economyLink';
import { whitelistRouter } from './v2/whitelist';
import { factionsRouter } from './v2/factions';
import { ticketsRouter } from './v2/tickets';
import { casinoRouter } from './v2/casino';
import { killfeedRouter } from './v2/killfeed';
import { welcomeRouter } from './v2/welcome';
import { embedsRouter } from './v2/embeds';
import { reactionEmbedsRouter } from './v2/reactionEmbeds';
import { feedsRouter } from './v2/feeds';
import { translatedPostsRouter } from './v2/translatedPosts';
import { devRouter } from './v2/dev';
import { devUploadsRouter } from './v2/devUploads';
import { devAnalyticsRouter } from './v2/devAnalytics';
import { devStatusRouter } from './v2/devStatus';
import { devNitradoMirrorRouter } from './v2/devNitradoMirror';
import { devIncidentRouter } from './v2/devIncident';
import { devObservabilityRouter } from './v2/devObservability';
import { devStubsRouter } from './v2/devStubs';
import { devCommandCenterRouter } from './v2/devCommandCenter';
import { auditRouter } from './v2/audit';
import { botAdminRouter } from './v2/botAdmin';
import { botAdminCommandCenterRouter } from './v2/botAdminCommandCenter';
import { commandCatalogRouter } from './v2/commandCatalog';

export const v2Router = Router();

v2Router.use(requireAuth);
v2Router.use(idempotency);

v2Router.use('/guilds', guildsRouter);
v2Router.use('/guilds/:guildId/dashboard', dashboardRouter);
v2Router.use('/guilds/:guildId/permissions', permissionsRouter);
v2Router.use('/guilds/:guildId/nitrado', nitradoRouter);
v2Router.use('/guilds/:guildId/adm-source', admSourceRouter);
v2Router.use('/guilds/:guildId/tickets', ticketsRouter);
v2Router.use('/guilds/:guildId/whitelist', whitelistRouter);
v2Router.use('/guilds/:guildId/factions', factionsRouter);

v2Router.use('/guilds/:guildId/economy-scope', economyScopeRouter);
v2Router.use('/guilds/:guildId/economy', requireSafeDashboardEconomyScope, economyRouter);
v2Router.use('/guilds/:guildId/economy-links', economyLinkRouter);
v2Router.use('/guilds/:guildId/casino', requireSafeDashboardEconomyScope, casinoRouter);

v2Router.use('/guilds/:guildId/killfeed', killfeedRouter);
v2Router.use('/guilds/:guildId/welcome', welcomeRouter);
v2Router.use('/guilds/:guildId/embeds', embedsRouter);
v2Router.use('/guilds/:guildId/reaction-embeds', reactionEmbedsRouter);
v2Router.use('/guilds/:guildId/feeds', feedsRouter);
v2Router.use('/guilds/:guildId/translated-posts', translatedPostsRouter);
v2Router.use('/guilds/:guildId/audit', auditRouter);

v2Router.use('/dev/snapshot', requireGlobalDeveloperIdentity);
v2Router.use('/dev/logs', requireGlobalDeveloperIdentity);
v2Router.use('/dev/sessions', requireGlobalDeveloperIdentity);
v2Router.use('/dev', devRouter);

v2Router.use('/dev/uploads', requireGlobalDeveloperIdentity, devUploadsRouter);
v2Router.use('/dev/analytics', requireGlobalDeveloperIdentity, devAnalyticsRouter);
v2Router.use('/dev/status', requireGlobalDeveloperIdentity, devStatusRouter);
v2Router.use('/dev/nitrado-mirror', requireGlobalDeveloperIdentity, devNitradoMirrorRouter);
v2Router.use('/dev/incident', requireGlobalDeveloperIdentity, devIncidentRouter);
v2Router.use('/dev/observability', requireGlobalDeveloperIdentity, devObservabilityRouter);
v2Router.use('/dev/stubs', requireGlobalDeveloperIdentity, devStubsRouter);
v2Router.use('/dev/command-center', requireGlobalDeveloperIdentity, devCommandCenterRouter);

// Discord-/Dashboard-Paritaet: exakt derselbe Live-Katalog wie /help.
v2Router.use('/bot-admin/command-catalog', requireGlobalBotAdminIdentity, commandCatalogRouter);
v2Router.use('/bot-admin/command-center', requireGlobalBotAdminIdentity, botAdminCommandCenterRouter);

// Bot-Admin: Shared Password = Step-up, NICHT Identitaet/Berechtigung.
v2Router.use('/bot-admin', requireGlobalBotAdminIdentity, botAdminRouter);
