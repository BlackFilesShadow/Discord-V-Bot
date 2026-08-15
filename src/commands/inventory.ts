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

export const DASHBOARD_EXTRA = new Set<string>([
  'giveaway', 'poll', 'ticket', 'factions', 'balance', 'bank', 'pay', 'transfer',
]);

const ADMIN_EXTRA_NAMES = new Set<string>([
  'ai-trigger', 'feed', 'selfrole', 'translate-post', 'xp-config',
]);

const REMOVE_NAMES = new Set<string>(['autorole']);

/**
 * Hersteller-Funktion: bleibt bewusst global als Discord Slash Command.
 * `manufacturerOnly` wird ebenfalls automatisch als Preserve behandelt.
 */
export const PRESERVED_MANUFACTURER_COMMANDS = new Set<string>([
  'dev-manufacturer',
]);

/** Audit-Spur aller vollstaendig in Dashboard migrierten Slash-Commands. */
export const MOVED_TO_DASHBOARD = new Set<string>([
  // Bereits vor diesem Migrationsblock verschoben.
  'admin-broadcast', 'admin-appeals', 'admin-list-users', 'admin-approve',
  'admin-deny', 'admin-toggle-upload', 'admin-reset-password', 'admin-tickets',
  'selfrole', 'feed', 'translate-post',

  // Bot-Admin Command Center.
  'admin-aimodels', 'admin-audit', 'admin-delete', 'admin-error-report',
  'admin-feedback', 'admin-knowledge', 'admin-list-pakete', 'admin-logs',
  'admin-monitor', 'admin-stats', 'admin-validate', 'ai-trigger',

  // DEV Command Center (einschliesslich devOnly Dateien aus admin/user Ordnern).
  'admin-config', 'admin-export', 'admin-security', 'xp-config',
  'dev-admin', 'dev-db', 'dev-eval', 'dev-login', 'dev-reload',
  'ping', 'status',
]);

export const SPEC_KEEP_COMMANDS = new Set<string>([
  'ai', 'appeal', 'ban', 'kick', 'mute', 'warn', 'download', 'upload',
  'register', 'giveaway', 'help', 'leaderboard', 'level', 'poll',
  'search', 'ticket', 'balance', 'bank', 'blackjack', 'coinflip', 'deposit',
  'dice', 'factions', 'join', 'leave', 'link', 'pay', 'slot', 'transfer',
  'unlink', 'withdraw', 'wl-add', 'perm-add', 'perm-remove', 'perms',
  'server-ban', 'server-unban', 'server-ban-list',
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

  // Hersteller-Kommandos bleiben in Discord. Kategorie `dev` behaelt den
  // bestehenden GLOBAL-Scope im Scoped-Deployment, Ziel ist aber Discord.
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

  const target: CommandClassification['target'] = category === 'keep' ? 'discord' : category === 'admin' ? 'bot-admin' : category === 'dev' ? 'dev-area' : 'removed';
  const dashboardReplacement = DASHBOARD_EXTRA.has(name) || MOVED_TO_DASHBOARD.has(name) || input.movedToDashboard === true;
  const migrationStatus: MigrationStatus = input.movedToDashboard || MOVED_TO_DASHBOARD.has(name)
    ? 'moved_to_dashboard' : category === 'keep' ? 'active' : 'pending_migration';
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
  total: number; keep: number; admin: number; dev: number; remove: number;
  movedToDashboard: number; dashboardExtra: number; currentDiscord: number; targetDiscord: number;
}

export function buildInventory(
  commands: Array<ClassifyInput & { description?: string; cooldownMs?: number | null }>,
): { entries: InventoryEntry[]; summary: InventorySummary } {
  const entries: InventoryEntry[] = commands.map(c => ({
    ...classifyCommand(c), name: c.name, source: c.source ?? null,
    description: c.description ?? '', cooldownMs: c.cooldownMs ?? null,
    inSpecKeep: SPEC_KEEP_COMMANDS.has(c.name),
  }));
  return {
    entries,
    summary: {
      total: entries.length,
      keep: entries.filter(e => e.category === 'keep').length,
      admin: entries.filter(e => e.category === 'admin').length,
      dev: entries.filter(e => e.category === 'dev').length,
      remove: entries.filter(e => e.category === 'remove').length,
      movedToDashboard: entries.filter(e => e.migrationStatus === 'moved_to_dashboard').length,
      dashboardExtra: entries.filter(e => e.dashboardReplacement).length,
      currentDiscord: entries.length,
      targetDiscord: entries.filter(e => e.staysInDiscord).length,
    },
  };
}
