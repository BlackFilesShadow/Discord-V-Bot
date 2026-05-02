import { AdmToolPage } from '@/components/AdmToolPage';

interface RaidData {
  indicators: Array<{ ts: string; name: string; action: string; item?: string; pos: { x: number; y: number; z: number } | null }>;
  clusters: number;
}

export default function RaidAnalysis() {
  return (
    <AdmToolPage<RaidData>
      title="Raid Analyse"
      desc="Build-/Dismantle-Cluster und Raid-Indikatoren (Zeit-/Ortsfenster)."
      tool="raid"
      render={(data) => (
        <div className="space-y-3">
          <div className="text-xs">Erkannte Cluster: <strong>{data.clusters}</strong></div>
          <table className="w-full text-xs">
            <thead className="text-muted">
              <tr><th className="text-left">Zeit</th><th className="text-left">Spieler</th><th className="text-left">Aktion</th><th className="text-left">Item</th><th className="text-right">Pos</th></tr>
            </thead>
            <tbody>
              {data.indicators.slice(0, 200).map((r, i) => (
                <tr key={i} className="border-t border-border/20">
                  <td className="py-1">{new Date(r.ts).toLocaleString()}</td>
                  <td className="font-mono">{r.name}</td>
                  <td>{r.action}</td>
                  <td className="text-muted">{r.item ?? '-'}</td>
                  <td className="text-right font-mono text-muted">
                    {r.pos ? `${r.pos.x.toFixed(0)}, ${r.pos.y.toFixed(0)}` : '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    />
  );
}
