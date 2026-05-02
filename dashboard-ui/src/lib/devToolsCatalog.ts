/**
 * Zentraler DEV-Tools-Katalog.
 *
 * Wird von:
 *   - pages/Dev.tsx (Sidebar-Routing)
 *   - components/CommandPalette.tsx (Cmd+K Eintraege)
 *   - components/dev/PinnedToolsRow.tsx
 *
 * Hier zentralisiert, damit Slugs/Labels/Icons nicht doppelt gepflegt
 * werden muessen. category + keywords erleichtern Suche/Gruppierung.
 */
import {
  Activity, LayoutDashboard, Database, Server as ServerIcon, Plug, HeartPulse,
  AlertTriangle, RefreshCw, HardDrive, ShieldCheck, FileSearch, FileWarning,
  FileCode, FileJson, Bug, ScrollText, TerminalSquare,
  Skull, MapPin, Bomb, Home, Map as MapIcon, Eye, Users, Car, Brain, FolderTree,
  AlertOctagon,
} from 'lucide-react';

export type DevToolStatus = 'ready' | 'stub';
export type DevToolCategory = 'observability' | 'security' | 'analysis' | 'integrations' | 'utilities';

export interface DevTool {
  slug: string;
  label: string;
  icon: typeof Activity;
  status: DevToolStatus;
  desc: string;
  category: DevToolCategory;
  /** Such-Aliase fuer Command-Palette */
  keywords?: ReadonlyArray<string>;
}

export const DEV_TOOLS: ReadonlyArray<DevTool> = [
  // ── Observability ──────────────────────────────────────────────────────
  { slug: 'bot-status',        label: 'Live Bot Status',         icon: Activity,        status: 'ready', category: 'observability', desc: 'Echtzeit Bot-Snapshot und Live-Logs.',                  keywords: ['live', 'logs', 'snapshot', 'uptime'] },
  { slug: 'dashboard-status',  label: 'Dashboard Status',        icon: LayoutDashboard, status: 'ready',  category: 'observability', desc: 'Express-Server, Sessions, aktive Sockets.',             keywords: ['http', 'sessions', 'socket'] },
  { slug: 'database-status',   label: 'Datenbank Status',        icon: Database,        status: 'ready', category: 'observability', desc: 'Postgres-Health, Pool, Migrations, Top-Tabellen.',      keywords: ['postgres', 'sql', 'migrations', 'pool'] },
  { slug: 'system-health',     label: 'System Health Check',     icon: HeartPulse,      status: 'ready', category: 'observability', desc: 'CPU, RAM, Disk, Process-Memory, Load.',                 keywords: ['cpu', 'ram', 'disk', 'load'] },
  { slug: 'error-monitoring',  label: 'Fehler Monitoring',       icon: AlertTriangle,   status: 'ready',  category: 'observability', desc: 'Live-Errors aus errorSink (Discord-Webhook).',          keywords: ['errors', 'sentry', 'sink'] },
  { slug: 'live-sync',         label: 'Live Sync Status',        icon: RefreshCw,       status: 'ready',  category: 'observability', desc: 'Cross-Service Sync-Jobs (Whitelist, Economy).',         keywords: ['sync', 'whitelist', 'queue'] },
  { slug: 'ai-providers',      label: 'AI Provider Stats',       icon: Brain,           status: 'ready', category: 'observability', desc: 'Provider-Erfolgsraten + Anomalie-Detection.',           keywords: ['ai', 'openai', 'gemini', 'anomaly'] },
  { slug: 'observability',     label: 'Observability Console',   icon: Activity,        status: 'ready', category: 'observability', desc: 'Prisma p50/p95/p99, AI-Tracing, Live-Logs, Backup (P3).', keywords: ['metrics', 'latency', 'p95', 'p99', 'tracing', 'logs', 'backup'] },

  // ── Security ───────────────────────────────────────────────────────────
  { slug: 'security-status',   label: 'Sicherheitsstatus',       icon: ShieldCheck,     status: 'ready',  category: 'security',      desc: 'Rate-Limit-Hits, Brute-Force, Audit-Anomalien.',        keywords: ['rate-limit', 'brute', '2fa', 'sessions'] },  { slug: 'active-sessions',   label: 'Aktive DEV-Sessions',     icon: ShieldCheck,     status: 'ready', category: 'security',      desc: 'Live-Liste aktiver DevSessions + Force-Revoke (P1).',   keywords: ['session', 'revoke', 'lifecycle', 'devsession'] },  { slug: 'incident-response', label: 'Incident Response',       icon: AlertOctagon,    status: 'ready', category: 'security',      desc: 'Kill-Switches, Wartungsmodus, Cache- und Backup-Trigger (P2).', keywords: ['kill', 'switch', 'maintenance', 'backup', 'cache', 'incident'] },  { slug: 'audit-logs',        label: 'Audit Logs',              icon: ScrollText,      status: 'ready',  category: 'security',      desc: 'Globale Audit-Trail-Suche und Export.',                 keywords: ['audit', 'trail', 'export', 'csv', 'json'] },

  // ── Integrations ───────────────────────────────────────────────────────
  { slug: 'nitrado-status',    label: 'Nitrado API Status',      icon: ServerIcon,      status: 'ready', category: 'integrations',  desc: 'Nitrado Job-Outbox: Pending/Failed, letzte Fehler.',    keywords: ['nitrado', 'outbox', 'jobs'] },
  { slug: 'nitrado-mirror',    label: 'Nitrado Mirror',          icon: FolderTree,      status: 'ready', category: 'integrations',  desc: 'Read-Only Snapshot aller Server-Settings.',             keywords: ['nitrado', 'mirror', 'snapshot', 'mission'] },
  { slug: 'discord-status',    label: 'Discord API Status',      icon: Plug,            status: 'ready', category: 'integrations',  desc: 'Gateway-Latenz, Shard-Health, Cache-Sizes.',            keywords: ['discord', 'shard', 'gateway'] },
  { slug: 'backup-status',     label: 'Backup Status',           icon: HardDrive,       status: 'ready',  category: 'integrations',  desc: 'Letzte Backups, Verifikation, Restore-Test.',           keywords: ['backup', 'restore', 'verify'] },

  // ── Utilities ──────────────────────────────────────────────────────────
  { slug: 'xml-validator',     label: 'XML Validator',           icon: FileCode,        status: 'ready', category: 'utilities',     desc: 'High-End XML-Validierung mit Auto-Fix.',                keywords: ['xml', 'validate', 'lint'] },
  { slug: 'json-validator',    label: 'JSON Validator',          icon: FileJson,        status: 'ready', category: 'utilities',     desc: 'High-End JSON-Validierung mit Auto-Fix.',               keywords: ['json', 'validate', 'lint'] },
  { slug: 'debug-tools',       label: 'Debug Tools',             icon: Bug,             status: 'ready',  category: 'utilities',     desc: 'Inspector, Heap-Snapshot, EventLoop-Lag.',              keywords: ['debug', 'heap', 'gc', 'profiling'] },
  { slug: 'command-diag',      label: 'Command Diagnose',        icon: TerminalSquare,  status: 'ready',  category: 'utilities',     desc: 'Slash-Command-Registry, Cooldowns, Fehler.',            keywords: ['commands', 'slash', 'cooldown'] },

  // ── Analysis (DayZ-spezifisch) ────────────────────────────────────────
  { slug: 'adm-analysis',      label: 'ADM Log Analyse',         icon: FileSearch,      status: 'ready', category: 'analysis',      desc: 'DayZ-ADM-Parser: Spieler, GUID, Routen, Hits.',         keywords: ['adm', 'logs', 'parser'] },
  { slug: 'rpt-analysis',      label: 'RPT Log Analyse',         icon: FileWarning,     status: 'ready', category: 'analysis',      desc: 'DayZ-RPT-Parser: Crashes, Mod- und Script-Errors.',     keywords: ['rpt', 'logs', 'crashes'] },
  { slug: 'killfeed',          label: 'Killfeed',                icon: Skull,           status: 'ready', category: 'analysis',      desc: 'GUID-strict Killer/Opfer mit Distanz, Waffe, K/D.',     keywords: ['kill', 'pvp', 'kd'] },
  { slug: 'player-tracking',   label: 'Player Tracking',         icon: MapPin,          status: 'ready', category: 'analysis',      desc: 'Sessions pro GUID: connect/disconnect/Events.',         keywords: ['player', 'tracking', 'sessions'] },
  { slug: 'raid-analysis',     label: 'Raid Analyse',            icon: Bomb,            status: 'ready', category: 'analysis',      desc: 'Build/Dismantle-Cluster + Raid-Indikatoren.',           keywords: ['raid', 'base', 'dismantle'] },
  { slug: 'base-proximity',    label: 'Base Proximity',          icon: Home,            status: 'ready', category: 'analysis',      desc: 'Base-Cluster nach Build-Density.',                      keywords: ['base', 'proximity', 'cluster'] },
  { slug: 'movement-heatmap',  label: 'Movement Heatmap',        icon: MapIcon,         status: 'ready', category: 'analysis',      desc: 'Aggregierte Positions-Hits als Heatmap.',               keywords: ['movement', 'heatmap', 'map'] },
  { slug: 'suspicious',        label: 'Verdaechtige Aktivitaet', icon: Eye,             status: 'ready', category: 'analysis',      desc: 'Long-Distance-Kills, hohe Headshot-Quote.',             keywords: ['suspicious', 'cheat', 'aimbot'] },
  { slug: 'faction-activity',  label: 'Fraktions Aktivitaet',    icon: Users,           status: 'ready', category: 'analysis',      desc: 'Konflikt-Graph aus Killer/Opfer-Pairs.',                keywords: ['faction', 'conflict', 'graph'] },
  { slug: 'vehicle-tracking',  label: 'Fahrzeug Tracking',       icon: Car,             status: 'ready', category: 'analysis',      desc: 'Fahrzeug-Events pro Spieler/GUID.',                     keywords: ['vehicle', 'car'] },
];

export const CATEGORY_LABEL: Record<DevToolCategory, string> = {
  observability: 'Observability',
  security:      'Security',
  integrations:  'Integrations',
  utilities:     'Utilities',
  analysis:      'Analysis',
};

export const CATEGORY_ORDER: ReadonlyArray<DevToolCategory> = [
  'observability', 'security', 'integrations', 'utilities', 'analysis',
];

export function findTool(slug: string): DevTool | undefined {
  return DEV_TOOLS.find(t => t.slug === slug);
}
