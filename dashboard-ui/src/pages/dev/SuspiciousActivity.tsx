import { AdmToolPage } from '@/components/AdmToolPage';

interface Finding { ts: string; name: string; reason: string; details: Record<string, unknown> }

export default function SuspiciousActivity() {
  return (
    <AdmToolPage<Finding[]>
      title="Verdaechtige Aktivitaet"
      desc="Long-Distance-Kills (>= 400m) und Headshot-Quote >= 70%."
      tool="suspicious"
      render={(data) => (
        <ul className="space-y-2 text-xs">
          {data.map((f, i) => (
            <li key={i} className="rounded-md border border-warn/30 bg-warn/5 px-2 py-1.5">
              <div><strong className="text-warn">{f.reason}</strong> · <span className="font-mono">{f.name}</span></div>
              <div className="text-muted text-[11px]">{new Date(f.ts).toLocaleString()}</div>
              <pre className="mt-1 text-[10px] font-mono">{JSON.stringify(f.details, null, 2)}</pre>
            </li>
          ))}
          {data.length === 0 && <li className="text-muted">Keine verdaechtigen Funde.</li>}
        </ul>
      )}
    />
  );
}
