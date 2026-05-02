import { AdmToolPage } from '@/components/AdmToolPage';

interface VEvent { ts: string; name: string; vehicle?: string; raw: string }

export default function VehicleTracking() {
  return (
    <AdmToolPage<VEvent[]>
      title="Fahrzeug Tracking"
      desc="Alle Fahrzeug-Events pro GUID-Spieler."
      tool="vehicles"
      render={(data) => (
        <table className="w-full text-xs">
          <thead className="text-muted">
            <tr><th className="text-left">Zeit</th><th className="text-left">Spieler</th><th className="text-left">Fahrzeug</th><th className="text-left">Raw</th></tr>
          </thead>
          <tbody>
            {data.map((v, i) => (
              <tr key={i} className="border-t border-border/20">
                <td className="py-1">{new Date(v.ts).toLocaleString()}</td>
                <td className="font-mono">{v.name}</td>
                <td>{v.vehicle ?? '-'}</td>
                <td className="text-muted text-[10px] font-mono break-all">{v.raw}</td>
              </tr>
            ))}
            {data.length === 0 && <tr><td colSpan={4} className="text-muted py-2">Keine Fahrzeug-Events.</td></tr>}
          </tbody>
        </table>
      )}
    />
  );
}
