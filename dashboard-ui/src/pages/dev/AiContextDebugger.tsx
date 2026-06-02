import { useState } from 'react';
import { Brain, Play, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDesc } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { api, ApiError } from '@/lib/api';

interface DebugSnippet {
  id: string;
  label: string;
  contentPreview: string;
  semantic: number;
  keyword: number;
  labelBoost: number;
  recency: number;
  hybrid: number;
  hadEmbedding: boolean;
  selected: boolean;
  reason: string;
}

interface DebugResult {
  question: string;
  totalSnippets: number;
  usedSemantic: boolean;
  queryModel: string | null;
  weights: { semantic: number; keyword: number; label: number; recency: number };
  minScore: number;
  limit: number;
  results: DebugSnippet[];
  promptBudgets: Record<string, number>;
}

export default function AiContextDebugger() {
  const [guildId, setGuildId] = useState('');
  const [question, setQuestion] = useState('');
  const [limit, setLimit] = useState(3);
  const [data, setData] = useState<DebugResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setError(null);
    try {
      const res = await api.post<DebugResult>('/api/v2/dev/status/ai-retrieval-debug', {
        guildId: guildId.trim(),
        question: question.trim(),
        limit,
      });
      setData(res);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Anfrage fehlgeschlagen.');
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card glow>
        <CardHeader>
          <CardTitle><Brain className="h-4 w-4 inline mr-1 text-accent" /> AI Kontext-Debugger</CardTitle>
          <CardDesc>Testet das Hybrid-Retrieval (Cosine + Keyword + Label + Recency) fuer eine Guild und zeigt die Score-Aufschluesselung pro Wissens-Snippet.</CardDesc>
        </CardHeader>
        <div className="grid sm:grid-cols-[1fr_auto] gap-3 mt-2">
          <div className="space-y-2">
            <label className="block">
              <span className="text-xs text-muted block mb-1">Guild-ID</span>
              <input
                value={guildId}
                onChange={e => setGuildId(e.target.value)}
                placeholder="z.B. 1366021241630363720"
                className="input-premium w-full rounded-lg text-white px-3.5 py-2.5 text-sm placeholder:text-muted/80 focus:outline-none font-mono"
              />
            </label>
            <label className="block">
              <span className="text-xs text-muted block mb-1">Testfrage</span>
              <input
                value={question}
                onChange={e => setQuestion(e.target.value)}
                placeholder="z.B. Wie funktioniert die Whitelist?"
                onKeyDown={e => { if (e.key === 'Enter' && guildId.trim() && question.trim()) run(); }}
                className="input-premium w-full rounded-lg text-white px-3.5 py-2.5 text-sm placeholder:text-muted/80 focus:outline-none"
              />
            </label>
          </div>
          <div className="flex flex-col gap-2 justify-end">
            <label className="block">
              <span className="text-xs text-muted block mb-1">Limit</span>
              <input
                type="number"
                min={1}
                max={10}
                value={limit}
                onChange={e => setLimit(Math.max(1, Math.min(10, Number(e.target.value) || 1)))}
                className="input-premium w-20 rounded-lg text-white px-3.5 py-2.5 text-sm focus:outline-none"
              />
            </label>
            <Button onClick={run} disabled={loading || !guildId.trim() || !question.trim()}>
              <Play className={`h-3.5 w-3.5 mr-1 ${loading ? 'animate-pulse' : ''}`} /> Ausfuehren
            </Button>
          </div>
        </div>
      </Card>

      {error && <Card><div role="alert" className="text-xs text-danger flex gap-2"><AlertTriangle className="h-3.5 w-3.5 mt-0.5" /> {error}</div></Card>}

      {data && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>
                {data.usedSemantic
                  ? <><CheckCircle2 className="h-4 w-4 inline mr-1 text-ok" /> Semantik aktiv</>
                  : <><AlertTriangle className="h-4 w-4 inline mr-1 text-warn" /> Nur Keyword (kein Embedding-Provider)</>}
              </CardTitle>
              <CardDesc>
                {data.totalSnippets} Snippet(s) · Modell: <span className="font-mono">{data.queryModel ?? '—'}</span> ·
                Gewichte: Semantik {data.weights.semantic}, Keyword {data.weights.keyword}, Label {data.weights.label}, Recency {data.weights.recency} ·
                Min-Score {data.minScore} · Limit {data.limit}
              </CardDesc>
            </CardHeader>
            {data.results.length === 0
              ? <div className="text-xs text-muted">Keine Snippets fuer diese Guild hinterlegt.</div>
              : (
                <table className="w-full text-xs">
                  <thead className="text-muted">
                    <tr>
                      <th className="text-left">Auswahl</th>
                      <th className="text-left">Label</th>
                      <th className="text-right">Cosine</th>
                      <th className="text-right">Keyword</th>
                      <th className="text-right">Label</th>
                      <th className="text-right">Recency</th>
                      <th className="text-right">Hybrid</th>
                      <th className="text-left">Grund</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.results.map(s => (
                      <tr key={s.id} className={`border-t border-border/20 ${s.selected ? 'bg-ok/5' : ''}`}>
                        <td className="py-1">{s.selected ? <span className="text-ok">✓</span> : <span className="text-muted">—</span>}</td>
                        <td className="font-mono">{s.label}</td>
                        <td className={`text-right ${s.semantic > 0 ? 'text-accent' : 'text-muted'}`}>{s.semantic.toFixed(3)}</td>
                        <td className="text-right">{s.keyword.toFixed(3)}</td>
                        <td className="text-right">{s.labelBoost}</td>
                        <td className="text-right">{s.recency.toFixed(3)}</td>
                        <td className="text-right font-semibold">{s.hybrid.toFixed(3)}</td>
                        <td className="text-muted text-[10px]">{s.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
          </Card>

          <Card>
            <CardHeader><CardTitle>Prompt-Budgets (Zeichen)</CardTitle><CardDesc>Pro Kontext-Art (per ENV uebersteuerbar).</CardDesc></CardHeader>
            <ul className="grid sm:grid-cols-2 gap-1 text-xs">
              {Object.entries(data.promptBudgets).map(([k, v]) => (
                <li key={k} className="flex justify-between border-b border-border/10 py-0.5">
                  <span className="font-mono text-muted">{k}</span><span>{v}</span>
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}
    </div>
  );
}
