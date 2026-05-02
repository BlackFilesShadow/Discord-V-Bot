/**
 * RPT Log Analyse — Crashes, Errors, Warnings, Mod-Liste.
 */
import { useEffect, useState } from 'react';
import { AlertTriangle, FileWarning } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Card, CardHeader, CardTitle, CardDesc } from '@/components/ui/Card';
import { DevFileUpload } from '@/components/DevFileUpload';

interface RptResult {
  lines: Array<{ line: number; level: 'ERROR' | 'WARN' | 'INFO' | 'OTHER'; text: string }>;
  counts: { ERROR: number; WARN: number; INFO: number; OTHER: number };
  mods: string[];
  totalLines: number;
}

export default function RptAnalysis() {
  const [uploadId, setUploadId] = useState<string | null>(null);
  const [data, setData] = useState<RptResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'ALL' | 'ERROR' | 'WARN' | 'INFO'>('ERROR');

  useEffect(() => {
    if (!uploadId) { setData(null); return; }
    let c = false;
    setLoading(true); setError(null);
    api.get<RptResult>(`/api/v2/dev/analytics/rpt/${uploadId}`)
      .then(r => { if (!c) setData(r); })
      .catch(e => { if (!c) setError(e instanceof ApiError ? e.message : 'Laden fehlgeschlagen.'); })
      .finally(() => { if (!c) setLoading(false); });
    return () => { c = true; };
  }, [uploadId]);

  const filtered = data?.lines.filter(l => filter === 'ALL' || l.level === filter) ?? [];

  return (
    <div className="space-y-4">
      <Card glow>
        <CardHeader>
          <CardTitle><FileWarning className="h-4 w-4 inline mr-1 text-warn" /> RPT Log Analyse</CardTitle>
          <CardDesc>Server-Crashes, Mod-/Script-Errors, Warnings.</CardDesc>
        </CardHeader>
      </Card>
      <div className="grid gap-4 md:grid-cols-[320px_1fr]">
        <DevFileUpload kind="RPT" selectedId={uploadId} onSelect={setUploadId} accept=".rpt,.log,.txt" />
        <Card>
          {!uploadId && <p className="text-xs text-muted">Bitte RPT-Datei auswaehlen.</p>}
          {loading && <p className="text-xs text-muted">Parse Datei…</p>}
          {error && <div role="alert" className="text-xs text-danger flex gap-2"><AlertTriangle className="h-3.5 w-3.5 mt-0.5" /> {error}</div>}
          {data && (
            <div className="space-y-3">
              <div className="grid grid-cols-4 gap-2 text-xs">
                <Stat color="text-danger" label="Errors" value={data.counts.ERROR} />
                <Stat color="text-warn" label="Warns" value={data.counts.WARN} />
                <Stat color="text-ok" label="Info" value={data.counts.INFO} />
                <Stat color="text-muted" label="Zeilen" value={data.totalLines} />
              </div>
              {data.mods.length > 0 && (
                <div>
                  <h4 className="text-xs font-semibold mb-1">Geladene Mods ({data.mods.length})</h4>
                  <div className="flex flex-wrap gap-1">
                    {data.mods.map(m => <span key={m} className="text-[10px] rounded bg-accent/10 text-accent px-1.5 py-0.5 font-mono">{m}</span>)}
                  </div>
                </div>
              )}
              <div className="flex gap-1 text-[10px]">
                {(['ALL', 'ERROR', 'WARN', 'INFO'] as const).map(l => (
                  <button key={l} onClick={() => setFilter(l)}
                    className={`rounded px-1.5 py-0.5 ${filter === l ? 'bg-accent text-bg' : 'bg-card text-muted hover:text-text'}`}>{l}</button>
                ))}
              </div>
              <div className="max-h-[60vh] overflow-y-auto font-mono text-[11px] space-y-0.5">
                {filtered.map((l, i) => (
                  <div key={i} className="flex gap-2 border-t border-border/10 py-0.5">
                    <span className="text-muted w-12 text-right shrink-0">{l.line}</span>
                    <span className={l.level === 'ERROR' ? 'text-danger' : l.level === 'WARN' ? 'text-warn' : 'text-ok'}>{l.level}</span>
                    <span className="break-all">{l.text}</span>
                  </div>
                ))}
                {filtered.length === 0 && <p className="text-muted">Keine Treffer.</p>}
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="rounded-md border border-border/30 px-2 py-1.5">
      <div className="text-[10px] text-muted uppercase tracking-wide">{label}</div>
      <div className={`text-base font-semibold ${color}`}>{value}</div>
    </div>
  );
}
