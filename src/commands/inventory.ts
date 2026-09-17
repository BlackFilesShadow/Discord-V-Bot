/**
 * Command-Inventory & Migrations-Klassifizierung.
 *
 * Regel: erst funktionsgleichen Dashboard-Ersatz bauen und pruefen, danach
 * `moved_to_dashboard` markieren und erst dann den Discord-Command entfernen.
 * Hersteller-Funktionen sind die ausdrueckliche Ausnahme und bleiben in Discord.
 */
export type CommandCategory = 'keep' | 'admin' | 'dev' | 'remove';
export type MigrationStatus = 'active' | 'pending_migration' | 'moved_to_dashboard';
export interface CommandClassification {
  category: CommandCategory;
  target: 'discord' | 'bot-admin' | 'dev-area' | 'removed';
  migrationStatus: MigrationStatus;
  dashboardReplacement: boolean;
  staysInDiscord: boolean;
}

/**
 * Nur Commands, fuer die tatsaechlich ein funktionsgleicher (oder zumindest
 * echter Lese-)Dashboard-Ersatz existiert, gehoeren hier rein. Ein Cross-Check
 * 2026-09 hat den fruesten deutlich groesseren Stand dieses Sets widerlegt:
 * `giveaway`, `poll`, `ticket`, `pay`, `transfer`, `virtual-account`, `lottery`
 * sowie alle acht Casino-Spiele (`slot`..`wheel`) und `casino-verify` haben im
 * Dashboard KEINE Mutation/Aktion, die dasselbe leistet wie der Discord-Befehl
 * (teils nur eine Admin-Konfigurationsseite, teils gar nichts) - dort bestand
 * nur eine oberflaechliche Namensaehnlichkeit zur jeweiligen Dashboard-Sektion.
 * `ticket` verwechselte zusaetzlich zwei unterschiedliche Datenmodelle
 * (Owner-Kontakt-`Ticket` des Slash-Commands vs. `TicketTemplate`/`TicketInstance`
 * im Dashboard). Verifiziert und hier belassen: `factions`/`balance`
 * (identische Lesefunktion auf beiden Seiten) und `black-market` (beide Seiten
 * rufen dieselbe `buyInventorylessMarketListing()` auf). `casino-stats` bleibt,
 * weil eine eigene (wenn auch separat geschriebene) Aggregat-Statistik-Ansicht
 * im Dashboard existiert.
 */
export const DASHBOARD_EXTRA = new Set<string>([
  'factions', 'balance', 'black-market', 'casino-stats',
]);

const ADMIN_EXTRA_NAMES = new Set<string>([
  'ai-trigger', 'feed', 'selfrole', 'translate-post', 'xp-config',
]);

const REMOVE_NAMES = new Set<string>(['autorole']);

export const PRESERVED_MANUFACTURER_COMMANDS = new Set<string>([
  'dev-manufacturer',
]);

export const MOVED_TO_DASHBOARD = new Set<string>([
  'admin-broadcast', 'admin-appeals', 'admin-list-users', 'admin-approve',
  'admin-deny', 'admin-toggle-upload', 'admin-reset-password', 'admin-tickets',
  'selfrole', 'feed', 'translate-post',
  'admin-aimodels', 'admin-audit', 'admin-delete', 'admin-error-report',
  'admin-feedback', 'admin-knowledge', 'admin-list-pakete', 'admin-logs',
  'admin-monitor', 'admin-stats', 'admin-validate', 'ai-trigger',
  'admin-config', 'admin-export', 'admin-security', 'xp-config',
  'dev-admin', 'dev-db', 'dev-eval', 'dev-login', 'dev-reload',
  'ping', 'status', 'link-panel',
]);

/**
 * Kanonisches Zielinventar der normalen guild-scoped Discord-Commands.
 * Hersteller-Kommandos mit `manufacturerOnly` werden bewusst separat als
 * globale Discord-Commands behandelt und gehoeren deshalb NICHT in diese Liste.
 * Die koordinierten Whitelist-Namen sind bereits kanonisch; Legacy-Namen duerfen
 * nach dem Loader-Normalisieren nicht mehr im Live-Inventar auftauchen.
 */
export const SPEC_KEEP_COMMANDS = new Set<string>([
  'ai', 'appeal', 'ban', 'kick', 'mute', 'warn', 'case', 'download',
  'register', 'giveaway', 'help', 'leaderboard', 'level', 'poll', 'feedback', 'erinnerung',
  'search', 'ticket', 'balance', 'stell-dich-vor',
  'blackjack', 'coinflip', 'dice', 'slot', 'roulette', 'highlow', 'baccarat', 'wheel',
  'deposit', 'faction', 'factions', 'fraktionen', 'join', 'leave',
  'link', 'unlink', 'links', 'link-info',
  'force-link', 'force-unlink', 'confirm-action',
  'pay', 'admin-pay', 'add-money', 'remove-money',
  'casino-stats', 'casino-verify', 'transfer', 'withdraw', 'virtual-account', 'lottery', 'black-market',
  'whitelist-antrag', 'whitelist-add', 'whitelist-remove',
  'perm-add', 'perm-remove', 'perms',
  'server-ban', 'server-unban',
]);

export interface ClassifyInput {
  name: string;
  source?: string;
  adminOnly?: boolean;
  devOnly?: boolean;
  manufacturerOnly?: boolean;
  movedToDashboard?: boolean;
}

function sourceDir(source?: string): string {
  if (!source) return '';
  const norm = source.replace(/\\/g, '/');
  const idx = norm.indexOf('/');
  return idx >= 0 ? norm.slice(0, idx) : '';
}

export function classifyCommand(input: ClassifyInput): CommandClassification {
  const { name } = input;

  if (input.manufacturerOnly || PRESERVED_MANUFACTURER_COMMANDS.has(name)) {
    return {
      category: 'dev', target: 'discord', migrationStatus: 'active',
      dashboardReplacement: false, staysInDiscord: true,
    };
  }

  const dir = sourceDir(input.source);
  let category: CommandCategory;
  if (REMOVE_NAMES.has(name)) category = 'remove';
  else if (dir === 'developer' || input.devOnly) category = 'dev';
  else if (dir === 'admin' || input.adminOnly) category = 'admin';
  else if (dir === 'user' || dir === 'dashboard') category = 'keep';
  else if (name.startsWith('dev-')) category = 'dev';
  else if (name.startsWith('admin-') || ADMIN_EXTRA_NAMES.has(name)) category = 'admin';
  else category = 'keep';

  const target: CommandClassification['target'] = category === 'keep'
    ? 'discord'
    : category === 'admin'
      ? 'bot-admin'
      : category === 'dev'
        ? 'dev-area'
        : 'removed';
  const dashboardReplacement = DASHBOARD_EXTRA.has(name) || MOVED_TO_DASHBOARD.has(name) || input.movedToDashboard === true;
  const migrationStatus: MigrationStatus = input.movedToDashboard || MOVED_TO_DASHBOARD.has(name)
    ? 'moved_to_dashboard'
    : category === 'keep'
      ? 'active'
      : 'pending_migration';
  const staysInDiscord = category === 'keep' && migrationStatus !== 'moved_to_dashboard';
  return { category, target, migrationStatus, dashboardReplacement, staysInDiscord };
}

export interface InventoryEntry extends CommandClassification {
  name: string;
  source: string | null;
  description: string;
  cooldownMs: number | null;
  inSpecKeep: boolean;
}
export interface InventorySummary {
  total: number;
  keep: number;
  admin: number;
  dev: number;
  remove: number;
  movedToDashboard: number;
  dashboardExtra: number;
  currentDiscord: number;
  targetDiscord: number;
}

export function buildInventory(
  commands: Array<ClassifyInput & { description?: string; cooldownMs?: number | null }>,
): { entries: InventoryEntry[]; summary: InventorySummary } {
  const entries: InventoryEntry[] = commands.map(command => ({
    ...classifyCommand(command),
    name: command.name,
    source: command.source ?? null,
    description: command.description ?? '',
    cooldownMs: command.cooldownMs ?? null,
    inSpecKeep: SPEC_KEEP_COMMANDS.has(command.name),
  }));
  return {
    entries,
    summary: {
      total: entries.length,
      keep: entries.filter(entry => entry.category === 'keep').length,
      admin: entries.filter(entry => entry.category === 'admin').length,
      dev: entries.filter(entry => entry.category === 'dev').length,
      remove: entries.filter(entry => entry.category === 'remove').length,
      movedToDashboard: entries.filter(entry => entry.migrationStatus === 'moved_to_dashboard').length,
      dashboardExtra: entries.filter(entry => entry.dashboardReplacement).length,
      currentDiscord: entries.length,
      targetDiscord: entries.filter(entry => entry.staysInDiscord).length,
    },
  };
}
