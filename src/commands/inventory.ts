/**
 * Command-Inventory & Migrations-Klassifizierung (Spec §15).
 *
 * Zweck: Jeden Slash-Command einer Ziel-Kategorie zuordnen, damit die
 * Command-Migration nachvollziehbar und auditierbar wird. Es wird hier NICHTS
 * entfernt — die Migrationsregel lautet: erst Dashboard-Ersatz bauen,
 * Funktionsgleichheit pruefen, Inventory aktualisieren, Command als
 * `moved_to_dashboard` markieren und ERST DANN den Discord-Command entfernen.
 *
 * Die Klassifizierung erfolgt primaer ueber das Quellverzeichnis (robust gegen
 * Namens-Sonderfaelle wie `/admin-pay`, das in dashboard/economy.ts liegt und
 * ein Wirtschafts-Command ist, kein Admin-Command), mit Flag-/Namens-Overrides.
 */

export type CommandCategory =
  | 'keep' // bleibt dauerhaft in Discord
  | 'admin' // langfristig in den Bot-Admin-Bereich (Dashboard)
  | 'dev' // langfristig in den DEV-Bereich (Dashboard)
  | 'remove'; // soll entfernt werden (kein Ersatz noetig)

export type MigrationStatus =
  | 'active' // aktiv in Discord, kein Migrationsbedarf
  | 'pending_migration' // soll migriert werden, Discord-Command bleibt vorerst
  | 'moved_to_dashboard'; // Ersatz existiert, Discord-Command kann/ist entfernt

export interface CommandClassification {
  category: CommandCategory;
  /** Ziel-Ort nach abgeschlossener Migration. */
  target: 'discord' | 'bot-admin' | 'dev-area' | 'removed';
  migrationStatus: MigrationStatus;
  /** True, wenn bereits ein vollwertiger Dashboard-Ersatz existiert. */
  dashboardReplacement: boolean;
  /** True, wenn dieser Command nach der Migration in Discord verbleibt. */
  staysInDiscord: boolean;
}

/**
 * Commands, die zusaetzlich im Dashboard verfuegbar sind, aber bewusst in
 * Discord BEHALTEN werden (Spec §15 "Dashboard zusätzlich, aber Discord
 * erstmal behalten").
 */
export const DASHBOARD_EXTRA = new Set<string>([
  'giveaway',
  'poll',
  'ticket',
  'factions',
  'balance',
  'bank',
  'pay',
  'transfer',
]);

/**
 * Admin-Commands ohne `admin-`-Praefix, die dennoch in den Bot-Admin-Bereich
 * gehoeren (liegen in src/commands/admin/).
 */
const ADMIN_EXTRA_NAMES = new Set<string>([
  'ai-trigger',
  'feed',
  'selfrole',
  'translate-post',
  'xp-config',
]);

/**
 * Commands, deren Discord-Variante entfernt werden soll (Spec §15: /autorole).
 * Kein Dashboard-Ersatz noetig — Funktion entfaellt bzw. ist anderweitig
 * abgedeckt.
 */
const REMOVE_NAMES = new Set<string>(['autorole']);

/**
 * Bereits ins Dashboard migrierte Commands (Spec §15, Migrationsregel Schritt
 * 5: "Command als moved_to_dashboard markieren"). Diese Commands wurden aus
 * Discord ENTFERNT, weil ein funktionsgleicher Dashboard-Ersatz existiert und
 * geprueft wurde. Eintraege bleiben hier als Audit-/Inventory-Spur erhalten.
 *
 * Ersatz jeweils im Bot-Admin-Bereich (src/dashboard/routes/v2/botAdmin.ts +
 * dashboard-ui BotAdminTab):
 *  - admin-broadcast      -> Broadcast (POST /broadcast, Dry-Run zusaetzlich)
 *  - admin-appeals        -> Appeals (GET /appeals, POST /appeals/:id/decision)
 *  - admin-list-users     -> Nutzer (GET /users, Filter+Suche)
 *  - admin-approve        -> Nutzer "Hersteller +" (POST /users/:id/manufacturer APPROVE)
 *  - admin-deny           -> Nutzer "Ablehnen" (POST /users/:id/manufacturer DENY)
 *  - admin-toggle-upload  -> Nutzer Sperren/Entsperren (POST /users/:id/toggle-upload)
 *  - admin-reset-password -> Nutzer Passwort-Reset (POST /users/:id/reset-password)
 *  - admin-tickets        -> Tickets (GET /tickets, POST /tickets/:id/close)
 *  - selfrole             -> Selfroles (GET/POST /selfroles ...; Button-Handler bleibt im Bot)
 */
export const MOVED_TO_DASHBOARD = new Set<string>([
  'admin-broadcast',
  'admin-appeals',
  'admin-list-users',
  'admin-approve',
  'admin-deny',
  'admin-toggle-upload',
  'admin-reset-password',
  'admin-tickets',
  'selfrole',
]);

/**
 * Spec-Referenzliste: Commands, die dauerhaft in Discord bleiben.
 * Dient als Soll-Abgleich fuer das Inventory (Akzeptanz: "Command Inventory
 * korrekt").
 */
export const SPEC_KEEP_COMMANDS = new Set<string>([
  'ai', 'appeal', 'ban', 'kick', 'mute', 'warn', 'download', 'upload',
  'register', 'giveaway', 'help', 'leaderboard', 'level', 'ping', 'poll',
  'search', 'ticket', 'balance', 'bank', 'blackjack', 'coinflip', 'deposit',
  'dice', 'factions', 'join', 'leave', 'link', 'pay', 'slot', 'transfer',
  'unlink', 'withdraw', 'wl-add', 'perm-add', 'perm-remove', 'perms',
]);

export interface ClassifyInput {
  name: string;
  /** Relativer Quellpfad, z.B. "admin/adminStats.ts". */
  source?: string;
  adminOnly?: boolean;
  devOnly?: boolean;
  manufacturerOnly?: boolean;
  /** Bereits als nach-Dashboard-migriert markiert (Override). */
  movedToDashboard?: boolean;
}

function sourceDir(source?: string): string {
  if (!source) return '';
  // "admin/adminStats.ts" -> "admin"; normalisiert Backslashes.
  const norm = source.replace(/\\/g, '/');
  const idx = norm.indexOf('/');
  return idx >= 0 ? norm.slice(0, idx) : '';
}

/**
 * Klassifiziert einen Command anhand von Quellverzeichnis, Flags und Namen.
 */
export function classifyCommand(input: ClassifyInput): CommandClassification {
  const { name } = input;
  const dir = sourceDir(input.source);

  let category: CommandCategory;
  if (REMOVE_NAMES.has(name)) {
    category = 'remove';
  } else if (dir === 'developer' || input.devOnly || input.manufacturerOnly) {
    category = 'dev';
  } else if (dir === 'admin' || input.adminOnly) {
    category = 'admin';
  } else if (dir === 'user' || dir === 'dashboard') {
    // Bekanntes "User-/Dashboard"-Verzeichnis: bleibt, auch bei Namen wie
    // /admin-pay (Wirtschafts-Command, liegt in dashboard/economy.ts).
    category = 'keep';
  } else if (name.startsWith('dev-')) {
    category = 'dev';
  } else if (name.startsWith('admin-') || ADMIN_EXTRA_NAMES.has(name)) {
    category = 'admin';
  } else {
    category = 'keep';
  }

  const target: CommandClassification['target'] =
    category === 'keep' ? 'discord'
      : category === 'admin' ? 'bot-admin'
        : category === 'dev' ? 'dev-area'
          : 'removed';

  const dashboardReplacement =
    DASHBOARD_EXTRA.has(name) || MOVED_TO_DASHBOARD.has(name) || input.movedToDashboard === true;

  let migrationStatus: MigrationStatus;
  if (input.movedToDashboard || MOVED_TO_DASHBOARD.has(name)) {
    migrationStatus = 'moved_to_dashboard';
  } else if (category === 'keep') {
    migrationStatus = 'active';
  } else {
    migrationStatus = 'pending_migration';
  }

  // Ein Command bleibt in Discord, wenn er 'keep' ist und nicht als
  // moved_to_dashboard markiert wurde.
  const staysInDiscord = category === 'keep' && migrationStatus !== 'moved_to_dashboard';

  return { category, target, migrationStatus, dashboardReplacement, staysInDiscord };
}

export interface InventoryEntry extends CommandClassification {
  name: string;
  source: string | null;
  description: string;
  cooldownMs: number | null;
  /** True, wenn der Name in der Spec-Keep-Liste steht. */
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
  /** Aktuell in Discord registrierte Commands (alle geladenen). */
  currentDiscord: number;
  /** Ziel-Anzahl nach abgeschlossener Migration (nur 'keep', nicht moved). */
  targetDiscord: number;
}

/**
 * Baut das vollstaendige Inventory aus einer Liste klassifizierbarer Commands.
 */
export function buildInventory(
  commands: Array<ClassifyInput & { description?: string; cooldownMs?: number | null }>,
): { entries: InventoryEntry[]; summary: InventorySummary } {
  const entries: InventoryEntry[] = commands.map((c) => {
    const cls = classifyCommand(c);
    return {
      ...cls,
      name: c.name,
      source: c.source ?? null,
      description: c.description ?? '',
      cooldownMs: c.cooldownMs ?? null,
      inSpecKeep: SPEC_KEEP_COMMANDS.has(c.name),
    };
  });

  const summary: InventorySummary = {
    total: entries.length,
    keep: entries.filter((e) => e.category === 'keep').length,
    admin: entries.filter((e) => e.category === 'admin').length,
    dev: entries.filter((e) => e.category === 'dev').length,
    remove: entries.filter((e) => e.category === 'remove').length,
    movedToDashboard: entries.filter((e) => e.migrationStatus === 'moved_to_dashboard').length,
    dashboardExtra: entries.filter((e) => e.dashboardReplacement).length,
    currentDiscord: entries.length,
    targetDiscord: entries.filter((e) => e.staysInDiscord).length,
  };

  return { entries, summary };
}
