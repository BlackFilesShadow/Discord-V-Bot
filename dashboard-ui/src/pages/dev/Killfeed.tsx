import { AdmToolPage } from '@/components/AdmToolPage';

interface KillfeedData {
  entries: Array<{ killerName: string; victimName: string; weapon?: string; distanceM?: number; bodyPart?: string; ts: string }>;
  byKiller: Array<{ guid: string; name: string; kills: number; deaths: number; kd: number; avgDistance: number }>;
}

export default function Killfeed() {
  return (
    <AdmToolPage<KillfeedData>
      title="Killfeed"
      desc="GUID-strict Killer/Opfer mit Distanz, Waffe, Body-Part."
      tool="killfeed"
      render={(data) => (
        <div className="space-y-4">
          <div>
            <h3 className="text-xs font-semibold mb-1">K/D-Ranking</h3>
            <table className="w-full text-xs">
              <thead className="text-muted">
                <tr><th className="text-left">Spieler</th><th className="text-right">K</th><th className="text-right">D</th><th className="text-right">K/D</th><th className="text-right">avg Dist</th></tr>
              </thead>
              <tbody>
                {data.byKiller.slice(0, 25).map(k => (
                  <tr key={k.guid} className="border-t border-border/20">
                    <td className="py-1 font-mono">{k.name}</td>
                    <td className="text-right">{k.kills}</td>
                    <td className="text-right">{k.deaths}</td>
                    <td className="text-right">{k.kd}</td>
                    <td className="text-right">{k.avgDistance > 0 ? `${k.avgDistance} m` : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div>
            <h3 className="text-xs font-semibold mb-1">Letzte Kills</h3>
            <ul className="text-xs font-mono space-y-0.5 max-h-96 overflow-y-auto">
              {data.entries.slice(0, 100).map((e, i) => (
                <li key={i} className="border-t border-border/10 py-0.5">
                  <span className="text-muted">{new Date(e.ts).toLocaleTimeString()}</span>{' '}
                  <span className="text-ok">{e.killerName}</span>
                  {' → '}
                  <span className="text-danger">{e.victimName}</span>
                  {e.weapon && <span className="text-muted"> · {e.weapon}</span>}
                  {e.distanceM != null && <span className="text-muted"> · {e.distanceM}m</span>}
                  {e.bodyPart && <span className="text-muted"> · {e.bodyPart}</span>}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    />
  );
}
