import { AdmToolPage } from '@/components/AdmToolPage';

interface Cluster { centerX: number; centerY: number; buildEvents: number; participants: string[] }

export default function BaseProximity() {
  return (
    <AdmToolPage<Cluster[]>
      title="Base Proximity"
      desc="100m-Cluster mit hoher Build-Density. Zeigt Standorte vermuteter Bases."
      tool="baseproximity"
      render={(data) => (
        <table className="w-full text-xs">
          <thead className="text-muted">
            <tr><th className="text-left">#</th><th className="text-right">X</th><th className="text-right">Y</th><th className="text-right">Build-Events</th><th className="text-right">Mitwirkende GUIDs</th></tr>
          </thead>
          <tbody>
            {data.map((c, i) => (
              <tr key={i} className="border-t border-border/20">
                <td className="py-1">{i + 1}</td>
                <td className="text-right font-mono">{c.centerX.toFixed(0)}</td>
                <td className="text-right font-mono">{c.centerY.toFixed(0)}</td>
                <td className="text-right">{c.buildEvents}</td>
                <td className="text-right">{c.participants.length}</td>
              </tr>
            ))}
            {data.length === 0 && <tr><td colSpan={5} className="text-muted py-2">Keine Cluster gefunden.</td></tr>}
          </tbody>
        </table>
      )}
    />
  );
}
