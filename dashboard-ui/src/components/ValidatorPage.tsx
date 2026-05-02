/**
 * Generischer Validator-Page (XML/JSON).
 *
 * Drei Eingabemoeglichkeiten:
 *   1. Inline (Textarea)  -> POST /api/v2/dev/analytics/validate/{xml|json} { content }
 *   2. Upload waehlen     -> POST .../validate/{kind} { uploadId }
 *
 * Zeigt Issues mit Zeile/Spalte und ggf. Auto-Fix-Vorschlag.
 */
import { useState } from 'react';
import { AlertTriangle, CheckCircle2, FileCode, Wand2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Card, CardHeader, CardTitle, CardDesc } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { DevFileUpload, type DevUploadKind } from '@/components/DevFileUpload';

interface DiagPos { line: number; column: number; offset: number }
interface DiagIssue { severity: 'error' | 'warning'; message: string; pos: DiagPos; hint?: string }
interface ValidatorResult { ok: boolean; issues: DiagIssue[]; suggestedFix?: string }

interface ValidatorPageProps {
  kind: DevUploadKind & ('XML' | 'JSON');
  title: string;
  desc: string;
  endpoint: 'xml' | 'json';
  accept: string;
  placeholder: string;
}

export function ValidatorPage({ kind, title, desc, endpoint, accept, placeholder }: ValidatorPageProps) {
  const [mode, setMode] = useState<'inline' | 'upload'>('inline');
  const [content, setContent] = useState('');
  const [uploadId, setUploadId] = useState<string | null>(null);
  const [result, setResult] = useState<ValidatorResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setLoading(true); setError(null); setResult(null);
    try {
      const body = mode === 'inline' ? { content } : { uploadId };
      const r = await api.post<ValidatorResult>(`/api/v2/dev/analytics/validate/${endpoint}`, body);
      setResult(r);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Fehler.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card glow>
        <CardHeader>
          <CardTitle><FileCode className="h-4 w-4 inline mr-1 text-accent" /> {title}</CardTitle>
          <CardDesc>{desc}</CardDesc>
        </CardHeader>
        <div className="flex gap-2 mb-3 text-xs">
          <button onClick={() => setMode('inline')} className={`rounded px-2 py-1 ${mode === 'inline' ? 'bg-accent text-bg' : 'bg-card text-muted'}`}>Inline-Editor</button>
          <button onClick={() => setMode('upload')} className={`rounded px-2 py-1 ${mode === 'upload' ? 'bg-accent text-bg' : 'bg-card text-muted'}`}>Upload waehlen</button>
        </div>

        {mode === 'inline' && (
          <textarea
            value={content}
            onChange={e => setContent(e.target.value)}
            placeholder={placeholder}
            spellCheck={false}
            className="w-full h-64 font-mono text-xs rounded-md border border-border/30 bg-bg/50 p-2 focus:outline-none focus:border-accent"
          />
        )}
        <div className="mt-3 flex gap-2">
          <Button onClick={run} disabled={loading || (mode === 'inline' ? content.length === 0 : !uploadId)}>
            {loading ? 'Pruefe…' : 'Validieren'}
          </Button>
          {result?.suggestedFix && (
            <Button variant="secondary" onClick={() => { setContent(result.suggestedFix!); setMode('inline'); setResult(null); }}>
              <Wand2 className="h-3.5 w-3.5 mr-1" /> Auto-Fix uebernehmen
            </Button>
          )}
        </div>
      </Card>

      {mode === 'upload' && (
        <DevFileUpload kind={kind} selectedId={uploadId} onSelect={setUploadId} accept={accept} />
      )}

      {error && (
        <Card><div role="alert" className="text-xs text-danger flex gap-2"><AlertTriangle className="h-3.5 w-3.5 mt-0.5" /> {error}</div></Card>
      )}

      {result && (
        <Card>
          <CardHeader>
            <CardTitle>
              {result.ok
                ? <><CheckCircle2 className="h-4 w-4 inline mr-1 text-ok" /> Gueltig</>
                : <><AlertTriangle className="h-4 w-4 inline mr-1 text-danger" /> {result.issues.length} Problem(e)</>}
            </CardTitle>
          </CardHeader>
          {result.issues.length > 0 && (
            <ul className="space-y-1 text-xs">
              {result.issues.map((iss, i) => (
                <li key={i} className="rounded-md border border-border/30 px-2 py-1.5">
                  <div className={iss.severity === 'error' ? 'text-danger' : 'text-warn'}>
                    Zeile {iss.pos.line}, Spalte {iss.pos.column}: {iss.message}
                  </div>
                  {iss.hint && <div className="text-muted text-[11px]">Hinweis: {iss.hint}</div>}
                </li>
              ))}
            </ul>
          )}
          {result.suggestedFix && (
            <div className="mt-3">
              <h4 className="text-xs font-semibold mb-1">Auto-Fix-Vorschlag</h4>
              <pre className="text-[11px] font-mono bg-bg/50 border border-border/30 rounded-md p-2 max-h-64 overflow-auto">{result.suggestedFix}</pre>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
