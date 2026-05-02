import { AdmToolPage } from '@/components/AdmToolPage';

interface Edge { aGuid: string; aName: string; bGuid: string; bName: string; encounters: number }

export default function FactionActivity() {
  return (
    <AdmToolPage<Edge[]>
      title="Fraktions Aktivitaet"
      desc="Konflikt-Graph: Spieler-Paare mit wiederkehrenden Kill-/Hit-Encounters."
      tool="factions"
      render={(data) => (
        <table className="w-full text-xs">
          <thead className="text-muted">
            <tr><th className="text-left">Spieler A</th><th className="text-left">Spieler B</th><th className="text-right">Encounters</th></tr>
          </thead>
          <tbody>
            {data.map((e, i) => (
              <tr key={i} className="border-t border-border/20">
                <td className="py-1 font-mono">{e.aName}</td>
                <td className="font-mono">{e.bName}</td>
                <td className="text-right">{e.encounters}</td>
              </tr>
            ))}
            {data.length === 0 && <tr><td colSpan={3} className="text-muted py-2">Keine wiederkehrenden Konflikte.</td></tr>}
          </tbody>
        </table>
      )}
    />
  );
}
