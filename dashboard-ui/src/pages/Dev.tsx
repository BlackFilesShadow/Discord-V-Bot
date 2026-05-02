/**
 * DEV-Konsole — Layout mit Sidebar und 16 Tool-Slots (Spec 4 + 5).
 *
 * Drei Gates (defense in depth):
 *   1. user.role === 'DEVELOPER' — Frontend-Pruefung
 *   2. useDevSession().active   — Frontend-Pruefung gegen /api/v2/dev/status
 *   3. requireDev (Backend)     — alle /api/v2/dev/* Routen blocken sonst
 *
 * Kein Frontend-Bypass moeglich; der Server lehnt API-Calls ohne aktive
 * DevSession mit 403 ab.
 */
import { Outlet, NavLink, useLocation } from 'react-router-dom';
import {
  Activity, LayoutDashboard, Database, Server as ServerIcon, Plug, HeartPulse,
  AlertTriangle, RefreshCw, HardDrive, ShieldCheck, FileSearch, FileWarning,
  FileCode, FileJson, Bug, ScrollText, TerminalSquare, Lock, Unlock, LogOut,
  Skull, MapPin, Bomb, Home, Map as MapIcon, Eye, Users, Car, Brain, FolderTree,
} from 'lucide-react';
import { Shell } from '@/components/Shell';
import { Card, CardHeader, CardTitle, CardDesc } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useAuth } from '@/lib/auth';
import { useDevSession } from '@/lib/devSession';

export interface DevTool {
  /** URL-Slug unter /dev/ */
  slug: string;
  /** Anzeige-Label im Sidebar */
  label: string;
  /** lucide-react Icon */
  icon: typeof Activity;
  /** Status: 'ready' = implementiert, 'stub' = Phase 2 */
  status: 'ready' | 'stub';
  /** Kurzbeschreibung fuer Tool-Header */
  desc: string;
}

export const DEV_TOOLS: ReadonlyArray<DevTool> = [
  { slug: 'bot-status',        label: 'Live Bot Status',     icon: Activity,        status: 'ready', desc: 'Echtzeit Bot-Snapshot und Live-Logs.' },
  { slug: 'dashboard-status',  label: 'Dashboard Status',    icon: LayoutDashboard, status: 'stub',  desc: 'Express-Server, Sessions, aktive Sockets.' },
  { slug: 'database-status',   label: 'Datenbank Status',    icon: Database,        status: 'ready', desc: 'Postgres-Health, Pool, Migrations, Top-Tabellen.' },
  { slug: 'nitrado-status',    label: 'Nitrado API Status',  icon: ServerIcon,      status: 'ready', desc: 'Nitrado Job-Outbox: Pending/Failed, letzte Fehler.' },
  { slug: 'discord-status',    label: 'Discord API Status',  icon: Plug,            status: 'ready', desc: 'Gateway-Latenz, Shard-Health, Cache-Sizes.' },
  { slug: 'system-health',     label: 'System Health Check', icon: HeartPulse,      status: 'ready', desc: 'CPU, RAM, Disk, Process-Memory, Load.' },
  { slug: 'error-monitoring',  label: 'Fehler Monitoring',   icon: AlertTriangle,   status: 'stub',  desc: 'Live-Errors aus errorSink (Discord-Webhook).' },
  { slug: 'live-sync',         label: 'Live Sync Status',    icon: RefreshCw,       status: 'stub',  desc: 'Cross-Service Sync-Jobs (Whitelist, Economy).' },
  { slug: 'backup-status',     label: 'Backup Status',       icon: HardDrive,       status: 'stub',  desc: 'Letzte Backups, Verifikation, Restore-Test.' },
  { slug: 'security-status',   label: 'Sicherheitsstatus',   icon: ShieldCheck,     status: 'stub',  desc: 'Rate-Limit-Hits, Brute-Force, Audit-Anomalien.' },
  { slug: 'adm-analysis',      label: 'ADM Log Analyse',     icon: FileSearch,      status: 'ready', desc: 'DayZ-ADM-Parser: Spieler, GUID, Routen, Hits.' },
  { slug: 'rpt-analysis',      label: 'RPT Log Analyse',     icon: FileWarning,     status: 'ready', desc: 'DayZ-RPT-Parser: Crashes, Mod- und Script-Errors.' },
  { slug: 'xml-validator',     label: 'XML Validator',       icon: FileCode,        status: 'ready', desc: 'High-End XML-Validierung mit Auto-Fix.' },
  { slug: 'json-validator',    label: 'JSON Validator',      icon: FileJson,        status: 'ready', desc: 'High-End JSON-Validierung mit Auto-Fix.' },
  { slug: 'debug-tools',       label: 'Debug Tools',         icon: Bug,             status: 'stub',  desc: 'Inspector, Heap-Snapshot, EventLoop-Lag.' },
  { slug: 'audit-logs',        label: 'Audit Logs',          icon: ScrollText,      status: 'stub',  desc: 'Globale Audit-Trail-Suche und Export.' },
  { slug: 'command-diag',      label: 'Command Diagnose',    icon: TerminalSquare,  status: 'stub',  desc: 'Slash-Command-Registry, Cooldowns, Fehler.' },
  // Phase 2 — AI / GUID-basierte ADM-Auswertungen (Spec Sektion 13)
  { slug: 'killfeed',          label: 'Killfeed',            icon: Skull,           status: 'ready', desc: 'GUID-strict Killer/Opfer mit Distanz, Waffe, K/D.' },
  { slug: 'player-tracking',   label: 'Player Tracking',     icon: MapPin,          status: 'ready', desc: 'Sessions pro GUID: connect/disconnect/Events.' },
  { slug: 'raid-analysis',     label: 'Raid Analyse',        icon: Bomb,            status: 'ready', desc: 'Build/Dismantle-Cluster + Raid-Indikatoren.' },
  { slug: 'base-proximity',    label: 'Base Proximity',      icon: Home,            status: 'ready', desc: 'Base-Cluster nach Build-Density.' },
  { slug: 'movement-heatmap',  label: 'Movement Heatmap',    icon: MapIcon,         status: 'ready', desc: 'Aggregierte Positions-Hits als Heatmap.' },
  { slug: 'suspicious',        label: 'Verdaechtige Aktivitaet', icon: Eye,         status: 'ready', desc: 'Long-Distance-Kills, hohe Headshot-Quote.' },
  { slug: 'faction-activity',  label: 'Fraktions Aktivitaet',icon: Users,           status: 'ready', desc: 'Konflikt-Graph aus Killer/Opfer-Pairs.' },
  { slug: 'vehicle-tracking',  label: 'Fahrzeug Tracking',   icon: Car,             status: 'ready', desc: 'Fahrzeug-Events pro Spieler/GUID.' },
  // Phase 3 — AI-Provider Health + Anomalie-Detection (Spec 9)
  { slug: 'ai-providers',      label: 'AI Provider Stats',   icon: Brain,           status: 'ready', desc: 'Provider-Erfolgsraten + Anomalie-Detection (Spec 9).' },
  // Phase 4 — Nitrado Mirror (Read-Only): einmaliger Voll-Snapshot
  { slug: 'nitrado-mirror',    label: 'Nitrado Mirror',      icon: FolderTree,      status: 'ready', desc: 'Read-Only Snapshot aller Server-Settings + Mission-/Profile-Dateien.' },
];

export default function DevLayout() {
  const { user } = useAuth();
  const dev = useDevSession();

  // Gate 1: Rolle
  if (!user || user.role !== 'DEVELOPER') {
    return (
      <Shell title="Dev-Konsole" back="/servers">
        <Card glow className="max-w-md mx-auto">
          <CardHeader>
            <CardTitle><AlertTriangle className="h-4 w-4 inline mr-1 text-danger" /> Kein Zugriff</CardTitle>
            <CardDesc>Diese Konsole ist auf DEVELOPER-Konten beschraenkt.</CardDesc>
          </CardHeader>
        </Card>
      </Shell>
    );
  }

  // Gate 2: aktive DevSession
  if (!dev.active) {
    return (
      <Shell title="Dev-Konsole" back="/servers">
        <Card glow className="max-w-md mx-auto">
          <CardHeader>
            <CardTitle><Lock className="h-4 w-4 inline mr-1" /> DEV-Session erforderlich</CardTitle>
            <CardDesc>
              Bitte melde dich ueber das DEV Login Panel auf der Server-Uebersicht an.
              Direkter URL-Zugriff ohne aktive Session ist serverseitig blockiert.
            </CardDesc>
          </CardHeader>
          <a href="/servers" className="inline-block">
            <Button size="sm">Zur Server-Uebersicht</Button>
          </a>
        </Card>
      </Shell>
    );
  }

  return (
    <Shell title="Dev-Konsole" back="/servers" sidebar={<DevSidebar />}>
      <div className="max-w-6xl mx-auto">
        <Outlet />
      </div>
    </Shell>
  );
}

function DevSidebar() {
  const dev = useDevSession();
  const loc = useLocation();
  return (
    <nav aria-label="DEV Tools" className="space-y-4">
      <div className="flex items-center justify-between px-2">
        <span className="text-[10px] uppercase tracking-widest text-muted">DEV Tools</span>
        <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-ok/15 text-ok border border-ok/30">
          <Unlock className="h-3 w-3" /> ON
        </span>
      </div>
      <ul className="space-y-1">
        {DEV_TOOLS.map(t => {
          const Icon = t.icon;
          const to = `/dev/${t.slug}`;
          const isActive = loc.pathname === to;
          return (
            <li key={t.slug}>
              <NavLink
                to={to}
                className={[
                  'group flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-xs transition-colors focus-ring',
                  isActive
                    ? 'bg-accent/15 text-white border border-accent/30'
                    : 'text-muted hover:text-white hover:bg-bg-elev/60 border border-transparent',
                ].join(' ')}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate flex-1">{t.label}</span>
                {t.status === 'stub' && (
                  <span className="text-[9px] uppercase tracking-wider text-muted/70 group-hover:text-muted">soon</span>
                )}
              </NavLink>
            </li>
          );
        })}
      </ul>
      <div className="pt-3 border-t border-border">
        <Button
          size="sm"
          variant="ghost"
          className="w-full justify-start text-muted hover:text-danger"
          onClick={() => { void dev.logout(); }}
        >
          <LogOut className="h-3.5 w-3.5" /> DEV-Logout
        </Button>
      </div>
    </nav>
  );
}
