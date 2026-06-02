import { Users, RefreshCw, AlertTriangle, UserCheck, UserMinus, Sparkles } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDesc } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { useDevStatus } from '@/lib/useDevStatus';

interface GuildView {
  guildId: string;
  name: string;
  memberCount: number;
  cachedMembers: number;
  roleCount: number;
}

interface RecentMember {
  guildId: string;
  discordId: string;
  username: string | null;
  nickname: string | null;
  isLeft: boolean;
  joinedAt: string | null;
  lastSeenAt: string | null;
  updatedAt: string | null;
}

interface MemberDetectionData {
  intents: { guildMembers: boolean };
  sync: { enabled: boolean; intervalHours: number };
  guildsTotal: number;
  guilds: GuildView[];
  indexed: { total: number; active: number; left: number; boosting: number };
  recentMembers: RecentMember[];
  queryMs: number;
  clientReady: boolean;
  scope: { guildIdRestrict?: string; global?: boolean };
}

export default function MemberDetection() {
  const { data, loading, error, reload, lastFetchedAt } =
    useDevStatus<MemberDetectionData>('/api/v2/dev/status/member-detection', 20000);

  return (
    <div className="space-y-4">
      <Card glow>
        <CardHeader>
          <CardTitle>
            <Users className="h-4 w-4 inline mr-1 text-accent" /> Member-Erfassung
          </CardTitle>
          <CardDesc>
            Member-Erkennung &amp; Indexierung pro Guild (Cache + lokaler Index).
            Keine Full-Guild-Fetches im Request-Pfad, keine privaten Daten.
          </CardDesc>
        </CardHeader>
        <Button variant="ghost" size="sm" onClick={reload} disabled={loading}>
          <RefreshCw className={`h-3.5 w-3.5 mr-1 ${loading ? 'animate-spin' : ''}`} /> Aktualisieren
        </Button>
        {lastFetchedAt && (
          <span className="ml-2 text-[11px] text-muted">Stand: {lastFetchedAt.toLocaleTimeString()}</span>
        )}
      </Card>

      {/* Error State */}
      {error && (
        <Card>
          <div role="alert" className="text-xs text-danger flex gap-2">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5" /> {error}
          </div>
        </Card>
      )}

      {/* Loading State (Erstabruf) */}
      {!data && !error && loading && (
        <Card><div className="text-xs text-muted">Lade Member-Erfassung…</div></Card>
      )}

      {data && (
        <>
          <Card>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
              <div className="rounded-md border border-border/30 px-3 py-2">
                <div className="text-[10px] uppercase text-muted">GuildMembers-Intent</div>
                <div className="mt-1">
                  {data.intents.guildMembers
                    ? <Badge variant="ok">Aktiv</Badge>
                    : <Badge variant="danger">Fehlt</Badge>}
                </div>
              </div>
              <div className="rounded-md border border-border/30 px-3 py-2">
                <div className="text-[10px] uppercase text-muted">Member-Sync-Job</div>
                <div className="mt-1">
                  {data.sync.enabled
                    ? <Badge variant="ok">An ({data.sync.intervalHours}h)</Badge>
                    : <Badge variant="neutral">Aus</Badge>}
                </div>
                <div className="mt-1 text-[11px] text-muted">MEMBER_SYNC_ENABLED</div>
              </div>
              <div className="rounded-md border border-border/30 px-3 py-2">
                <div className="text-[10px] uppercase text-muted">Guilds</div>
                <div className="mt-1 text-base font-semibold">{data.guildsTotal}</div>
                <div className="mt-1 text-[11px] text-muted">
                  {data.clientReady ? (data.scope?.global ? 'Global' : `Guild ${data.scope?.guildIdRestrict ?? '—'}`) : 'Client nicht bereit'}
                </div>
              </div>
              <div className="rounded-md border border-border/30 px-3 py-2">
                <div className="text-[10px] uppercase text-muted">Abfragezeit</div>
                <div className="mt-1 text-base font-semibold">{data.queryMs} ms</div>
              </div>
            </div>
          </Card>

          {/* Indexierte Member */}
          <Card>
            <CardHeader><CardTitle>Indexierte Mitglieder (GuildMemberProfile)</CardTitle></CardHeader>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
              <div className="rounded-md border border-border/30 px-3 py-2">
                <div className="text-[10px] uppercase text-muted">Gesamt</div>
                <div className="mt-1 text-base font-semibold">{data.indexed.total}</div>
              </div>
              <div className="rounded-md border border-border/30 px-3 py-2">
                <div className="text-[10px] uppercase text-muted flex items-center gap-1"><UserCheck className="h-3 w-3" /> Aktiv</div>
                <div className="mt-1 text-base font-semibold text-ok">{data.indexed.active}</div>
              </div>
              <div className="rounded-md border border-border/30 px-3 py-2">
                <div className="text-[10px] uppercase text-muted flex items-center gap-1"><UserMinus className="h-3 w-3" /> Verlassen</div>
                <div className="mt-1 text-base font-semibold text-warn">{data.indexed.left}</div>
              </div>
              <div className="rounded-md border border-border/30 px-3 py-2">
                <div className="text-[10px] uppercase text-muted flex items-center gap-1"><Sparkles className="h-3 w-3" /> Booster</div>
                <div className="mt-1 text-base font-semibold text-accent">{data.indexed.boosting}</div>
              </div>
            </div>
          </Card>

          {/* Pro-Guild Cache */}
          <Card>
            <CardHeader>
              <CardTitle>Pro Guild</CardTitle>
              <CardDesc>Member-Cache und Rollen je Guild (Cache-Sicht, kein Full-Fetch).</CardDesc>
            </CardHeader>
            {data.guilds.length === 0 ? (
              <div className="text-xs text-muted py-3">Keine Guilds im Cache.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-muted">
                    <tr>
                      <th className="text-left">Guild</th>
                      <th className="text-right">Mitglieder</th>
                      <th className="text-right">Im Cache</th>
                      <th className="text-right">Rollen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.guilds.map((g) => (
                      <tr key={g.guildId} className="border-t border-border/20">
                        <td className="py-1">{g.name} <span className="font-mono text-muted">({g.guildId.slice(0, 8)}…)</span></td>
                        <td className="text-right">{g.memberCount}</td>
                        <td className="text-right">{g.cachedMembers}</td>
                        <td className="text-right">{g.roleCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {/* Letzte Member-Events */}
          <Card>
            <CardHeader>
              <CardTitle>Letzte Member-Aktualisierungen</CardTitle>
              <CardDesc>Die 25 zuletzt aktualisierten Member-Profile.</CardDesc>
            </CardHeader>
            {data.recentMembers.length === 0 ? (
              <div className="text-xs text-muted py-3">Noch keine Member-Profile erfasst.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-muted">
                    <tr>
                      <th className="text-left">User</th>
                      <th className="text-left">Guild</th>
                      <th className="text-left">Status</th>
                      <th className="text-left">Beigetreten</th>
                      <th className="text-left">Aktualisiert</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recentMembers.map((m, i) => (
                      <tr key={`${m.guildId}-${m.discordId}-${i}`} className="border-t border-border/20">
                        <td className="py-1">{m.nickname ?? m.username ?? <span className="font-mono text-muted">{m.discordId.slice(0, 10)}…</span>}</td>
                        <td className="font-mono text-muted">{m.guildId.slice(0, 8)}…</td>
                        <td>{m.isLeft ? <Badge variant="warn">Verlassen</Badge> : <Badge variant="ok">Aktiv</Badge>}</td>
                        <td className="text-muted">{m.joinedAt ? new Date(m.joinedAt).toLocaleDateString() : '—'}</td>
                        <td className="text-muted">{m.updatedAt ? new Date(m.updatedAt).toLocaleString() : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
