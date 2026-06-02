/**
 * Command Diagnostics — Command-Inventory & Migrationsstatus (Spec §15).
 * Liest die Slash-Command-Registry des laufenden Discord-Clients samt
 * Kategorie-Klassifizierung (keep / admin / dev / remove), Migrationsstatus,
 * Dashboard-Ersatz, Kollisions- und Integritaets-Checks.
 * Backend: GET /api/v2/dev/stubs/commands.
 */
import { useState, useMemo } from 'react';
import { TerminalSquare, RefreshCw, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useDevStatus } from '@/lib/useDevStatus';
import { Card, CardHeader, CardTitle, CardDesc } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { StatCard } from '@/components/ui/StatCard';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { DataTable, type Column } from '@/components/ui/Table';

type Category = 'keep' | 'admin' | 'dev' | 'remove';
type MigrationStatus = 'active' | 'pending_migration' | 'moved_to_dashboard';

interface Cmd {
  name: string;
  source: string | null;
  description: string;
  cooldownMs: number | null;
  category: Category;
  target: 'discord' | 'bot-admin' | 'dev-area' | 'removed';
  migrationStatus: MigrationStatus;
  dashboardReplacement: boolean;
  staysInDiscord: boolean;
  inSpecKeep: boolean;
  hasExecute: boolean;
  hasData: boolean;
  nameTooLong: boolean;
}

interface Summary {
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

interface Resp {
  ready: boolean;
  count: number;
  commands: Cmd[];
  summary: Summary | null;
  collisions: { count: number; statusResolved: boolean };
  integrity: {
    missingExecute: string[];
    missingData: string[];
    nameTooLong: string[];
    missingSpecKeep: string[];
  };
}

const CAT_LABEL: Record<Category, string> = {
  keep: 'Bleibt',
  admin: 'Bot-Admin',
  dev: 'DEV-Bereich',
  remove: 'Entfernen',
};

const CAT_VARIANT: Record<Category, 'ok' | 'info' | 'warn' | 'danger'> = {
  keep: 'ok',
  admin: 'info',
  dev: 'info',
  remove: 'danger',
};

const MIG_LABEL: Record<MigrationStatus, string> = {
  active: 'aktiv',
  pending_migration: 'Migration offen',
  moved_to_dashboard: 'im Dashboard',
};

const MIG_VARIANT: Record<MigrationStatus, 'ok' | 'warn' | 'info'> = {
  active: 'ok',
  pending_migration: 'warn',
  moved_to_dashboard: 'info',
};

export default function Page(): JSX.Element {
  const [filter, setFilter] = useState('');
  const [cat, setCat] = useState<Category | 'all'>('all');
  // Polling deaktiviert (intervalMs=0): Commands aendern sich erst bei Bot-Restart.
  const { data, loading, error, reload } = useDevStatus<Resp>('/api/v2/dev/stubs/commands', 0);

  const filtered = useMemo(() => {
    if (!data) return [];
    const n = filter.trim().toLowerCase();
    return data.commands.filter((c) => {
      if (cat !== 'all' && c.category !== cat) return false;
      if (!n) return true;
      return (
        c.name.toLowerCase().includes(n) ||
        c.description.toLowerCase().includes(n) ||
        (c.source ?? '').toLowerCase().includes(n)
      );
    });
  }, [data, filter, cat]);

  const cols: Column<Cmd>[] = [
    { id: 'name', header: 'Name', cell: (r) => <span className="font-mono text-sm">/{r.name}</span> },
    {
      id: 'cat',
      header: 'Kategorie',
      cell: (r) => <Badge variant={CAT_VARIANT[r.category]}>{CAT_LABEL[r.category]}</Badge>,
    },
    {
      id: 'mig',
      header: 'Migration',
      cell: (r) => <Badge variant={MIG_VARIANT[r.migrationStatus]}>{MIG_LABEL[r.migrationStatus]}</Badge>,
    },
    {
      id: 'dash',
      header: 'Dashboard',
      cell: (r) =>
        r.dashboardReplacement ? <Badge variant="info">Ersatz</Badge> : <span className="text-muted">–</span>,
    },
    {
      id: 'source',
      header: 'Datei',
      cell: (r) => <span className="font-mono text-xs text-muted">{r.source ?? '?'}</span>,
    },
    {
      id: 'flags',
      header: 'Hinweise',
      cell: (r) => {
        const flags: string[] = [];
        if (!r.hasExecute) flags.push('kein execute');
        if (!r.hasData) flags.push('keine data');
        if (r.nameTooLong) flags.push('Name >32');
        return flags.length ? (
          <span className="text-xs text-amber-400">{flags.join(', ')}</span>
        ) : (
          <span className="text-muted">–</span>
        );
      },
    },
  ];

  const s = data?.summary;
  const integrityIssues = data?.integrity
    ? data.integrity.missingExecute.length + data.integrity.missingData.length + data.integrity.nameTooLong.length
    : 0;

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Command Diagnose & Migration"
        desc="Command-Inventory, Kategorien und Migrationsstatus (Spec §15)."
        icon={<TerminalSquare className="h-5 w-5" />}
        actions={
          <Button variant="ghost" onClick={() => void reload()} disabled={loading}>
            <RefreshCw className="h-4 w-4 mr-1" />Refresh
          </Button>
        }
      />
      {error && !data && <EmptyState title="Fehler beim Laden" desc={error} />}
      {!data && !error ? (
        <Skeleton className="h-32" />
      ) : !data ? null : !data.ready ? (
        <EmptyState title="Bot nicht verbunden" desc="Discord-Client noch nicht initialisiert." />
      ) : (
        <>
          {s && (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              <StatCard label="Commands gesamt" value={s.total} accent="ok" />
              <StatCard label="Bleibt (keep)" value={s.keep} accent="ok" />
              <StatCard label="Bot-Admin" value={s.admin} />
              <StatCard label="DEV-Bereich" value={s.dev} />
              <StatCard label="Entfernen" value={s.remove} accent={s.remove > 0 ? 'warn' : 'neutral'} />
              <StatCard label="Ziel Discord" value={s.targetDiscord} accent="ok" />
            </div>
          )}

          {/* Kollision + Integritaet */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Card>
              <CardHeader>
                <CardTitle>/status Kollision</CardTitle>
                <CardDesc>
                  {data.collisions.statusResolved ? (
                    <span className="inline-flex items-center gap-1 text-emerald-400">
                      <CheckCircle2 className="h-4 w-4" /> beseitigt — keine Namens-Kollisionen
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-amber-400">
                      <AlertTriangle className="h-4 w-4" /> {data.collisions.count} Kollision(en) erkannt
                    </span>
                  )}
                </CardDesc>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Integrität</CardTitle>
                <CardDesc>
                  {integrityIssues === 0 ? (
                    <span className="inline-flex items-center gap-1 text-emerald-400">
                      <CheckCircle2 className="h-4 w-4" /> keine defekten Commands
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-amber-400">
                      <AlertTriangle className="h-4 w-4" /> {integrityIssues} Hinweis(e)
                    </span>
                  )}
                </CardDesc>
              </CardHeader>
              {data.integrity.missingSpecKeep.length > 0 && (
                <p className="px-1 text-xs text-amber-400">
                  Spec-Keep nicht registriert: {data.integrity.missingSpecKeep.map((n) => `/${n}`).join(', ')}
                </p>
              )}
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Command-Inventory</CardTitle>
              <CardDesc>
                Status: <Badge variant="ok">live</Badge>
                {s && (
                  <span className="ml-2 text-muted">
                    {s.dashboardExtra} mit Dashboard-Ersatz · {s.movedToDashboard} verschoben
                  </span>
                )}
              </CardDesc>
            </CardHeader>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter (Name, Beschreibung, Datei)"
                className="min-w-[12rem] flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm"
              />
              <div className="flex flex-wrap gap-1">
                {(['all', 'keep', 'admin', 'dev', 'remove'] as const).map((c) => (
                  <button
                    key={c}
                    onClick={() => setCat(c)}
                    className={`rounded border px-2 py-1 text-xs ${
                      cat === c
                        ? 'border-emerald-500 bg-emerald-500/10 text-emerald-300'
                        : 'border-zinc-700 text-muted'
                    }`}
                  >
                    {c === 'all' ? 'Alle' : CAT_LABEL[c]}
                  </button>
                ))}
              </div>
            </div>
            {filtered.length === 0 ? (
              <EmptyState title="Keine Treffer" />
            ) : (
              <DataTable rows={filtered} columns={cols} rowKey={(r) => r.name} />
            )}
          </Card>
        </>
      )}
    </div>
  );
}
