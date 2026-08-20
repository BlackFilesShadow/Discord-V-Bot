/**
 * Phase 2C — REST-Routen v2 fuer das Self-Service-Dashboard.
 *
 * Mount-Punkt: /api/v2/...
 * Eigene Subroutes je Domaene; alle Mutation-Routes durch
 * `idempotency`-Middleware gesichert (Haertung A1).
 */

import '../expressAsyncErrors';
import { Router } from 'express';
import { requireAuth, requireDev, requireBotAdmin } from '../middleware/auth';
import { idempotency } from '../middleware/idempotency';
import { requireGlobalDeveloperIdentity } from '../middleware/globalDeveloperGate';
import { requireGlobalBotAdminIdentity } from '../middleware/globalBotAdminGate';
import { requireSafeDashboardEconomyScope } from '../middleware/economyScopeGuard';
import { requireGuildAnyPermission } from '../middleware/guildDomainAccess';
import { factionApiErrorBoundary, factionApiPreflight, factionMutationSerialization } from '../middleware/factionApiHardening';
import { guardBotAdminCommandCenterInput, guardDevCommandCenterInput } from '../middleware/commandCenterInputGuard';
import { requireVerifiedDevMutationStepUp, redirectLegacyDevExports } from '../middleware/devStepUp';
import { guardDevAdminTarget } from '../middleware/devAdminTargetGuard';
import { guardDevXpGuildObjects } from '../middleware/devXpScopeGuard';
import { guardDevXpMutationInput } from '../middleware/devXpMutationInputGuard';
import { guardDevSecurityInput } from '../middleware/devSecurityInputGuard';
import { guardBotAdminGuildReferences } from '../middleware/botAdminGuildReferenceGuard';
import { v2AsyncErrorBoundary } from '../middleware/v2AsyncErrorBoundary';

import { guildsRouter } from './v2/guilds';
import { dashboardRouter } from './v2/dashboard';
import { permissionsRouter } from './v2/permissions';
import { nitradoRouter } from './v2/nitrado';
import { admSourceRouter } from './v2/admSource';
import { economyRouter } from './v2/economy';
import { economyVirtualAccountsRouter } from './v2/economyVirtualAccounts';
import { economyLotteryRouter } from './v2/economyLottery';
import { economyBlackMarketRouter } from './v2/economyBlackMarket';
import { economyScopeRouter } from './v2/economyScope';
import { economyLinkRouter } from './v2/economyLink';
import { whitelistRouter } from './v2/whitelist';
import { factionsRouter } from './v2/factions';
import { ticketsRouter } from './v2/tickets';
import { casinoRouter } from './v2/casino';
import { killfeedRouter } from './v2/killfeed';
import { welcomeRouter } from './v2/welcome';
import { goodbyeRouter } from './v2/goodbye';
import { leaveCleanupRouter } from './v2/leaveCleanup';
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
import { devCommandDeployRouter } from './v2/devCommandDeploy';
import { devXpViewRouter } from './v2/devXpView';
import { devSecureExportRouter } from './v2/devSecureExport';
import { auditRouter } from './v2/audit';
import { botAdminRouter } from './v2/botAdmin';
import { botAdminLegacyContractRouter } from './v2/botAdminLegacyContract';
import { botAdminKnowledgeRouter } from './v2/botAdminKnowledge';
import { botAdminCommandCenterRouter } from './v2/botAdminCommandCenter';
import { botAdminCommandCenterSafetyRouter } from './v2/botAdminCommandCenterSafety';
import { botAdminAuditExportRouter } from './v2/botAdminAuditExport';
import { botAdminTriggersRouter } from './v2/botAdminTriggers';
import { botAdminSafePackageDeleteRouter } from './v2/botAdminSafePackageDelete';
import { botAdminSafeValidationRouter } from './v2/botAdminSafeValidation';
import { botAdminDangerSafetyRouter } from './v2/botAdminDangerSafety';
import { botAdminXpRetirementRouter } from './v2/botAdminXpRetirement';
import { commandCatalogRouter } from './v2/commandCatalog';

export const v2Router = Router();

const requireEconomyDashboardAccess = requireGuildAnyPermission('economy.view', 'economy.manage');
const requireCasinoDashboardAccess = requireGuildAnyPermission('casino.view', 'casino.manage');
const requireFactionsDashboardAccess = requireGuildAnyPermission('factions.view', 'factions.manage');

v2Router.use(requireAuth);
v2Router.use(idempotency);

v2Router.use('/guilds', guildsRouter);
v2Router.use('/guilds/:guildId/dashboard', dashboardRouter);
v2Router.use('/guilds/:guildId/permissions', permissionsRouter);
v2Router.use('/guilds/:guildId/nitrado', nitradoRouter);
v2Router.use('/guilds/:guildId/adm-source', admSourceRouter);
v2Router.use('/guilds/:guildId/tickets', ticketsRouter);
v2Router.use('/guilds/:guildId/whitelist', whitelistRouter);
v2Router.use('/guilds/:guildId/factions', requireFactionsDashboardAccess, factionApiPreflight, factionMutationSerialization, factionsRouter);
v2Router.use('/guilds/:guildId/factions', factionApiErrorBoundary);

v2Router.use('/guilds/:guildId/economy-scope', economyScopeRouter);
v2Router.use('/guilds/:guildId/economy/virtual-accounts', requireEconomyDashboardAccess, requireSafeDashboardEconomyScope, economyVirtualAccountsRouter);
v2Router.use('/guilds/:guildId/economy/lottery', requireEconomyDashboardAccess, requireSafeDashboardEconomyScope, economyLotteryRouter);
v2Router.use('/guilds/:guildId/economy/black-market', requireEconomyDashboardAccess, requireSafeDashboardEconomyScope, economyBlackMarketRouter);
v2Router.use('/guilds/:guildId/economy', requireEconomyDashboardAccess, requireSafeDashboardEconomyScope, economyRouter);
v2Router.use('/guilds/:guildId/economy-links', economyLinkRouter);
v2Router.use('/guilds/:guildId/casino', requireCasinoDashboardAccess, requireSafeDashboardEconomyScope, casinoRouter);

v2Router.use('/guilds/:guildId/killfeed', killfeedRouter);
v2Router.use('/guilds/:guildId/welcome', welcomeRouter);
v2Router.use('/guilds/:guildId/goodbye', goodbyeRouter);
v2Router.use('/guilds/:guildId/leave-cleanup', leaveCleanupRouter);
v2Router.use('/guilds/:guildId/embeds', embedsRouter);
v2Router.use('/guilds/:guildId/reaction-embeds', reactionEmbedsRouter);
v2Router.use('/guilds/:guildId/feeds', feedsRouter);
v2Router.use('/guilds/:guildId/translated-posts', translatedPostsRouter);
v2Router.use('/guilds/:guildId/audit', auditRouter);

v2Router.use('/dev/snapshot', requireGlobalDeveloperIdentity);
v2Router.use('/dev/logs', requireGlobalDeveloperIdentity);
// Session-Lesezugriff braucht eine aktive DevSession; mutierende Session-
// Aktionen (insb. Force-Revoke) verlangen zusaetzlich denselben kryptografisch
// verifizierten Step-Up wie andere sensible DEV-Mutationen.
v2Router.use('/dev/sessions', requireGlobalDeveloperIdentity, requireDev, requireVerifiedDevMutationStepUp);
v2Router.use('/dev', devRouter);

v2Router.use('/dev/uploads', requireGlobalDeveloperIdentity, devUploadsRouter);
v2Router.use('/dev/analytics', requireGlobalDeveloperIdentity, devAnalyticsRouter);
v2Router.use('/dev/status', requireGlobalDeveloperIdentity, devStatusRouter);
v2Router.use('/dev/nitrado-mirror', requireGlobalDeveloperIdentity, devNitradoMirrorRouter);
v2Router.use('/dev/incident', requireGlobalDeveloperIdentity, requireDev, requireVerifiedDevMutationStepUp, devIncidentRouter);
v2Router.use('/dev/observability', requireGlobalDeveloperIdentity, devObservabilityRouter);
v2Router.use('/dev/stubs', requireGlobalDeveloperIdentity, requireDev, requireVerifiedDevMutationStepUp, devStubsRouter);
v2Router.use('/dev/command-center', requireGlobalDeveloperIdentity, requireDev, redirectLegacyDevExports, guardDevCommandCenterInput, guardDevSecurityInput, requireVerifiedDevMutationStepUp, guardDevAdminTarget, guardDevXpMutationInput, guardDevXpGuildObjects, devCommandDeployRouter, devXpViewRouter, devCommandCenterRouter);
v2Router.use('/dev/secure-export', requireGlobalDeveloperIdentity, requireDev, requireVerifiedDevMutationStepUp, devSecureExportRouter);

// AI-10: kanonischer Knowledge-Router laeuft vor dem Legacy-Sammelrouter.
// Dadurch bleiben bestehende URLs stabil, waehrend Guild-/Gameserver-Scope,
// Import/Export und Audit durch eine isolierte fail-closed Route laufen.
v2Router.use('/bot-admin/knowledge', requireGlobalBotAdminIdentity, requireBotAdmin, botAdminKnowledgeRouter);
// Discord-/Dashboard-Paritaet: derselbe deploybare Live-Katalog wie /help;
// auch reine Diagnose-Reads bleiben hinter aktiver BotAdminSession.
v2Router.use('/bot-admin/command-catalog', requireGlobalBotAdminIdentity, requireBotAdmin, commandCatalogRouter);
// Grosse Audit-Downloads, Trigger sowie Datei-/Delete-Operationen besitzen
// spezifische kanonische Router und muessen vor dem Sammelrouter laufen.
v2Router.use('/bot-admin/command-center/audit/export', requireGlobalBotAdminIdentity, botAdminAuditExportRouter);
v2Router.use('/bot-admin/command-center/triggers', requireGlobalBotAdminIdentity, botAdminTriggersRouter);
v2Router.use('/bot-admin/command-center', requireGlobalBotAdminIdentity, guardBotAdminCommandCenterInput, botAdminCommandCenterSafetyRouter, botAdminCommandCenterRouter);

// Bot-Admin: globale Identitaet + aktive BotAdminSession. Safety-Overrides und
// Guild-Referenzpruefung muessen vor dem Legacy-Router laufen. XP wird fail-
// closed in DEV umgeleitet; Danger-Purge und physische Paketloeschung laufen
// ausschliesslich ueber ihre kanonischen Filesystem-Safety-Services. Der
// Legacy-Contract-Adapter erzwingt zusaetzlich strikte Query-/Body-Semantik,
// bevor die historischen Handler ihre Business-Logik ausfuehren.
v2Router.use('/bot-admin', requireGlobalBotAdminIdentity, botAdminXpRetirementRouter, botAdminDangerSafetyRouter, botAdminSafeValidationRouter, botAdminSafePackageDeleteRouter, guardBotAdminGuildReferences, botAdminLegacyContractRouter, botAdminRouter);

// Letzte v2-Error-Grenze: normale Fehler gehen an den globalen Dashboard-
// Handler; bei bereits begonnenen Streams wird die partielle Verbindung beendet.
v2Router.use(v2AsyncErrorBoundary);
