/**
 * ADM Log Analyse — kombinierte Sicht aller GUID-Auswertungen.
 *
 * Holt /api/v2/dev/analytics/adm/:id/all und zeigt eine kompakte
 * Uebersicht. Detail-Tools sind als eigene Sidebar-Eintraege verfuegbar
 * (Killfeed, Player Tracking, ...).
 */
import { useEffect, useState } from 'react';
import { Activity, AlertTriangle, FileSearch } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Card, CardHeader, CardTitle, CardDesc } from '@/components/ui/Card';
import { DevFileUpload } from '@/components/DevFileUpload';

interface AllAnalytics {
  killfeed: { byKiller: Array<{ guid: string; name: string; kills: number; deaths: number; kd: number }> };
  playerTracking: Array<{ guid: string; name: string; durationMin?: number }>;
  raid: { clusters: number; indicators: unknown[] };
  baseProximity: unknown[];
  heatmap: unknown[];
  suspicious: unknown[];
  factions: unknown[];
  vehicles: unknown[];
  meta: { totalEvents: number; guidEvents: number; ignoredNoGuid: number; startedAt: string | null };
}

export default function AdmAnalysis() {
  const [uploadId, setUploadId] = useState<string | null>(null);
  const [data, setData] = useState<AllAnalytics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!uploadId) { setData(null); return; }
    let c = false;
    setLoading(true); setError(null);
    api.get<AllAnalytics>(`/api/v2/dev/analytics/adm/${uploadId}/all`)
      .then(r => { if (!c) setData(r); })
      .catch(e => { if (!c) setError(e instanceof ApiError ? e.message : 'Laden fehlgeschlagen.'); })
      .finally(() => { if (!c) setLoading(false); });
    return () => { c = true; };
  }, [uploadId]);

  return (
    <div className="space-y-4">
      <Card glow>
        <CardHeader>
          <CardTitle><FileSearch className="h-4 w-4 inline mr-1 text-accent" /> ADM Log Analyse</CardTitle>
          <CardDesc>Uebersicht aller GUID-basierten Auswertungen einer ADM-Datei.</CardDesc>
        </CardHeader>
        <p className="text-[11px] text-muted">
          GUID-Strict-Modus (Spec 13): Spieler ohne BattlEye-GUID werden ignoriert.
        </p>
      </Card>

      <div className="grid gap-4 md:grid-cols-[320px_1fr]">
        <DevFileUpload kind="ADM" selectedId={uploadId} onSelect={setUploadId} accept=".adm,.log,.txt" />
        <Card>
          {!uploadId && <p className="text-xs text-muted">Bitte ADM-Datei auswaehlen.</p>}
          {loading && <p className="text-xs text-muted">Parse Datei…</p>}
          {error && (
            <div role="alert" className="text-xs text-danger flex gap-2">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5" /> {error}
            </div>
          )}
          {data && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                <Stat label="Total Events" value={data.meta.totalEvents} />
                <Stat label="GUID-Events" value={data.meta.guidEvents} />
                <Stat label="Ignoriert (kein GUID)" value={data.meta.ignoredNoGuid} />
                <Stat label="Raid-Cluster" value={data.raid.clusters} />
                <Stat label="Top-Killer" value={data.killfeed.byKiller.length} />
                <Stat label="Spieler-Sessions" value={data.playerTracking.length} />
                <Stat label="Verdaecht. Funde" value={data.suspicious.length} />
                <Stat label="Konflikt-Edges" value={data.factions.length} />
              </div>

              <div>
                <h3 className="text-xs font-semibold text-text mb-1 flex items-center gap-1">
                  <Activity className="h-3.5 w-3.5 text-accent" /> Top 10 Killer
                </h3>
                <table className="w-full text-xs">
                  <thead className="text-muted">
                    <tr><th className="text-left">Name</th><th className="text-right">Kills</th><th className="text-right">Deaths</th><th className="text-right">K/D</th></tr>
                  </thead>
                  <tbody>
                    {data.killfeed.byKiller.slice(0, 10).map(k => (
                      <tr key={k.guid} className="border-t border-border/20">
                        <td className="py-1 font-mono">{k.name}</td>
                        <td className="text-right">{k.kills}</td>
                        <td className="text-right">{k.deaths}</td>
                        <td className="text-right">{k.kd}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[11px] text-muted">
                Detail-Tools fuer Killfeed, Tracking, Raid, Heatmap, Suspicious, Factions, Vehicles
                sind in der Sidebar verfuegbar.
              </p>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-md border border-border/30 px-2 py-1.5">
      <div className="text-[10px] text-muted uppercase tracking-wide">{label}</div>
      <div className="text-base font-semibold">{value}</div>
    </div>
  );
}
