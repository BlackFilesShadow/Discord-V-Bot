import { ShieldCheck, RefreshCw, AlertTriangle, Lock, Unlock } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDesc } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { useDevStatus } from '@/lib/useDevStatus';

interface NitradoProtectionData {
  writeProtection: boolean;
  scopes: { view: string; manage: string; write: string; danger: string };
  readOnlyCaptureActive: boolean;
  queryMs: number;
  nitrado: {
    connectionsTotal: number;
    connectionsActive: number;
    connectionsWithService: number;
    services: Array<{
      guildId: string;
      slot: number;
      status: string;
      serviceId: string | null;
      serviceLinked: boolean;
      lastValidatedAt: string | null;
    }>;
  } | null;
  scope: { guildIdRestrict?: string; global?: boolean };
}

const STATUS_COLOR: Record<string, string> = {
  ACTIVE: 'text-ok', PAUSED: 'text-warn', REVOKED: 'text-danger', ERROR: 'text-danger',
};

export default function NitradoProtection() {
  const { data, loading, error, reload, lastFetchedAt } =
    useDevStatus<NitradoProtectionData>('/api/v2/dev/status/nitrado-protection', 20000);

  return (
    <div className="space-y-4">
      <Card glow>
        <CardHeader>
          <CardTitle>
            <ShieldCheck className="h-4 w-4 inline mr-1 text-accent" /> Nitrado Schreibschutz
          </CardTitle>
          <CardDesc>
            Read-Only-Datenerfassung &amp; Extra-Schreibschutz für gefährliche Nitrado-Aktionen.
            Zeigt KEINE Token, Passwörter oder Secrets.
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

      {/* Loading State (Erstabruf, noch keine Daten) */}
      {!data && !error && loading && (
        <Card><div className="text-xs text-muted">Lade Schreibschutz-Status…</div></Card>
      )}

      {data && (
        <>
          <Card>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
              <div className="rounded-md border border-border/30 px-3 py-2">
                <div className="text-[10px] uppercase text-muted">Schreibschutz</div>
                <div className="mt-1 flex items-center gap-2">
                  {data.writeProtection
                    ? <><Lock className="h-3.5 w-3.5 text-ok" /> <Badge variant="ok">Aktiv</Badge></>
                    : <><Unlock className="h-3.5 w-3.5 text-warn" /> <Badge variant="warn">Inaktiv</Badge></>}
                </div>
                <div className="mt-1 text-[11px] text-muted">
                  {data.writeProtection
                    ? 'Schreibende Aktionen brauchen Confirm + Reason + Audit.'
                    : 'NITRADO_WRITE_PROTECTION=false — Writes ohne Extra-Bestätigung.'}
                </div>
              </div>

              <div className="rounded-md border border-border/30 px-3 py-2">
                <div className="text-[10px] uppercase text-muted">Read-Only Erfassung</div>
                <div className="mt-1">
                  {data.readOnlyCaptureActive
                    ? <Badge variant="ok">Aktiv</Badge>
                    : <Badge variant="neutral">Inaktiv</Badge>}
                </div>
                <div className="mt-1 text-[11px] text-muted">Spiegelt Daten, schreibt nichts auf Nitrado.</div>
              </div>

              <div className="rounded-md border border-border/30 px-3 py-2">
                <div className="text-[10px] uppercase text-muted">Abfragezeit</div>
                <div className="mt-1 text-base font-semibold">{data.queryMs} ms</div>
                <div className="mt-1 text-[11px] text-muted">
                  {data.scope?.global ? 'Global' : `Guild ${data.scope?.guildIdRestrict ?? '—'}`}
                </div>
              </div>
            </div>
          </Card>

          {/* Permission-Scopes (Spec §12) */}
          <Card>
            <CardHeader><CardTitle>Permission-Scopes</CardTitle></CardHeader>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
              <div><code className="text-accent">{data.scopes.view}</code> — Read-Only Daten ansehen <Badge variant="ok">delegierbar</Badge></div>
              <div><code className="text-accent">{data.scopes.manage}</code> — Token/Service-Verbindung <Badge variant="danger">Owner-only</Badge></div>
              <div><code className="text-accent">{data.scopes.write}</code> — Normale Schreibaktionen <Badge variant="warn">geschützt</Badge></div>
              <div><code className="text-accent">{data.scopes.danger}</code> — Restart/Stop/Delete/Config <Badge variant="danger">Owner-only</Badge></div>
            </div>
          </Card>

          {/* Long-Life-Token Service-Verknüpfungen (OHNE Token-Werte) */}
          <Card>
            <CardHeader>
              <CardTitle>Verknüpfte Services</CardTitle>
              <CardDesc>
                Long-Life-Token-Verbindungen — nur Service-ID-Status, niemals Token.
                {data.nitrado && (
                  <> {' '}({data.nitrado.connectionsActive} aktiv / {data.nitrado.connectionsWithService} mit Service / {data.nitrado.connectionsTotal} gesamt)</>
                )}
              </CardDesc>
            </CardHeader>

            {/* Empty State */}
            {(!data.nitrado || data.nitrado.services.length === 0) ? (
              <div className="text-xs text-muted py-3">Keine Nitrado-Verbindungen vorhanden.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-muted">
                    <tr>
                      <th className="text-left">Guild</th>
                      <th className="text-left">Slot</th>
                      <th className="text-left">Status</th>
                      <th className="text-left">Service-ID</th>
                      <th className="text-left">Service verknüpft</th>
                      <th className="text-left">Zuletzt validiert</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.nitrado.services.map((s, i) => (
                      <tr key={`${s.guildId}-${s.slot}-${i}`} className="border-t border-border/20">
                        <td className="py-1 font-mono text-muted">{s.guildId.slice(0, 10)}…</td>
                        <td>{s.slot}</td>
                        <td className={STATUS_COLOR[s.status] ?? ''}>{s.status}</td>
                        <td className="font-mono">{s.serviceId ?? '—'}</td>
                        <td>{s.serviceLinked ? <Badge variant="ok">Ja</Badge> : <Badge variant="neutral">Nein</Badge>}</td>
                        <td className="text-muted">{s.lastValidatedAt ? new Date(s.lastValidatedAt).toLocaleString() : '—'}</td>
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
