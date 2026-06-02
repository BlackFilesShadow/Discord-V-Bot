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
import { AlertTriangle, CheckCircle2, FileCode, Wand2, Download, Info, Lightbulb } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Card, CardHeader, CardTitle, CardDesc } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { DevFileUpload, type DevUploadKind } from '@/components/DevFileUpload';

type ValidationSeverity = 'error' | 'warning' | 'info' | 'suggestion';

interface ValidationIssue {
  severity: ValidationSeverity;
  code: string;
  message: string;
  explanation?: string;
  line?: number;
  column?: number;
  path?: string;
  suggestion?: string;
  fixable?: boolean;
  confidence?: number;
}

interface ValidationSummary { errors: number; warnings: number; info: number; suggestions: number }

interface ValidationResult {
  ok: boolean;
  type: 'json' | 'xml' | 'adm' | 'rpt' | 'dayz-config';
  fileName?: string;
  sizeBytes?: number;
  sha256?: string;
  lineCount?: number;
  durationMs: number;
  issues: ValidationIssue[];
  summary: ValidationSummary;
  normalizedPreview?: string;
  fixedPreview?: string;
}

interface ValidatorPageProps {
  kind: DevUploadKind & ('XML' | 'JSON');
  title: string;
  desc: string;
  endpoint: 'xml' | 'json';
  accept: string;
  placeholder: string;
}

const SEV_COLOR: Record<ValidationSeverity, string> = {
  error: 'text-danger',
  warning: 'text-warn',
  info: 'text-accent',
  suggestion: 'text-ok',
};

function fmtBytes(n?: number): string {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function download(name: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function renderReport(r: ValidationResult, format: 'text' | 'markdown'): string {
  const sev = (s: ValidationSeverity) => s.toUpperCase();
  const L: string[] = [];
  const h = format === 'markdown';
  L.push(`${h ? '# ' : ''}Validierungsbericht — ${r.type.toUpperCase()}`);
  if (r.fileName) L.push(`${h ? '- **Datei:** ' : 'Datei: '}${r.fileName}`);
  L.push(`${h ? '- **Größe:** ' : 'Groesse: '}${fmtBytes(r.sizeBytes)}`);
  L.push(`${h ? '- **Zeilen:** ' : 'Zeilen: '}${r.lineCount ?? '—'}`);
  if (r.sha256) L.push(`${h ? '- **SHA256:** `' : 'SHA256: '}${r.sha256}${h ? '`' : ''}`);
  L.push(`${h ? '- **Dauer:** ' : 'Dauer: '}${r.durationMs} ms`);
  L.push(`${h ? '- **Ergebnis:** ' : 'Ergebnis: '}${r.ok ? (h ? '✅ gültig' : 'gueltig') : (h ? '❌ ungültig' : 'ungueltig')}`);
  L.push(`${h ? '- **Summary:** ' : 'Summary: '}${r.summary.errors} Fehler, ${r.summary.warnings} Warnungen, ${r.summary.info} Info, ${r.summary.suggestions} Vorschläge`);
  L.push('');
  L.push(h ? '## Befunde' : 'Befunde:');
  if (r.issues.length === 0) L.push(h ? 'Keine Befunde.' : '  (keine)');
  for (const i of r.issues) {
    const loc = i.line != null ? ` (Zeile ${i.line}${i.column != null ? `, Spalte ${i.column}` : ''})` : '';
    L.push(h ? `- **[${sev(i.severity)}] ${i.code}**${loc}: ${i.message}` : `  [${sev(i.severity)}] ${i.code}${loc}: ${i.message}`);
    if (i.suggestion) L.push(h ? `  - Vorschlag: ${i.suggestion}` : `      -> ${i.suggestion}`);
  }
  return L.join('\n');
}

export function ValidatorPage({ kind, title, desc, endpoint, accept, placeholder }: ValidatorPageProps) {
  const [mode, setMode] = useState<'inline' | 'upload'>('inline');
  const [content, setContent] = useState('');
  const [fileName, setFileName] = useState('');
  const [uploadId, setUploadId] = useState<string | null>(null);
  const [result, setResult] = useState<ValidationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setLoading(true); setError(null); setResult(null);
    try {
      const body = mode === 'inline'
        ? { content, fileName: fileName.trim() || undefined }
        : { uploadId };
      const r = await api.post<ValidationResult>(`/api/v2/dev/analytics/validate/${endpoint}`, body);
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
          <>
            {endpoint === 'xml' && (
              <input
                value={fileName}
                onChange={e => setFileName(e.target.value)}
                placeholder="Dateiname (optional, z.B. types.xml für DayZ-Strukturprüfung)"
                spellCheck={false}
                className="w-full mb-2 font-mono text-xs rounded-md border border-border/30 bg-bg/50 p-2 focus:outline-none focus:border-accent"
              />
            )}
            <textarea
              value={content}
              onChange={e => setContent(e.target.value)}
              placeholder={placeholder}
              spellCheck={false}
              className="w-full h-64 font-mono text-xs rounded-md border border-border/30 bg-bg/50 p-2 focus:outline-none focus:border-accent"
            />
          </>
        )}
        <div className="mt-3 flex gap-2 flex-wrap">
          <Button onClick={run} disabled={loading || (mode === 'inline' ? content.length === 0 : !uploadId)}>
            {loading ? 'Pruefe…' : 'Validieren'}
          </Button>
          {result?.fixedPreview && (
            <Button variant="secondary" onClick={() => { setContent(result.fixedPreview!); setMode('inline'); setResult(null); }}>
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
                : <><AlertTriangle className="h-4 w-4 inline mr-1 text-danger" /> {result.summary.errors} Fehler</>}
            </CardTitle>
          </CardHeader>

          {/* Metadaten */}
          <div className="flex flex-wrap gap-2 mb-3 text-[11px] text-muted">
            <span className="rounded bg-bg/50 px-2 py-0.5">Typ: <b className="text-fg">{result.type}</b></span>
            <span className="rounded bg-bg/50 px-2 py-0.5">Größe: <b className="text-fg">{fmtBytes(result.sizeBytes)}</b></span>
            <span className="rounded bg-bg/50 px-2 py-0.5">Zeilen: <b className="text-fg">{result.lineCount ?? '—'}</b></span>
            <span className="rounded bg-bg/50 px-2 py-0.5">Dauer: <b className="text-fg">{result.durationMs} ms</b></span>
            {result.sha256 && <span className="rounded bg-bg/50 px-2 py-0.5 font-mono">sha256: {result.sha256.slice(0, 12)}…</span>}
          </div>

          {/* Summary */}
          <div className="flex flex-wrap gap-2 mb-3">
            <Badge variant="danger">{result.summary.errors} Fehler</Badge>
            <Badge variant="warn">{result.summary.warnings} Warnungen</Badge>
            <Badge variant="info">{result.summary.info} Info</Badge>
            <Badge variant="ok">{result.summary.suggestions} Vorschläge</Badge>
          </div>

          {result.issues.length > 0 ? (
            <ul className="space-y-1 text-xs">
              {result.issues.map((iss, i) => (
                <li key={i} className="rounded-md border border-border/30 px-2 py-1.5">
                  <div className={SEV_COLOR[iss.severity]}>
                    {iss.severity === 'suggestion' && <Lightbulb className="h-3 w-3 inline mr-1" />}
                    {iss.severity === 'info' && <Info className="h-3 w-3 inline mr-1" />}
                    <span className="font-mono text-[10px] opacity-70 mr-1">[{iss.code}]</span>
                    {iss.line != null && <>Zeile {iss.line}{iss.column != null ? `, Spalte ${iss.column}` : ''}: </>}
                    {iss.message}
                  </div>
                  {iss.suggestion && <div className="text-muted text-[11px]">Hinweis: {iss.suggestion}</div>}
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-xs text-muted py-2">Keine Befunde — die Datei ist strukturell in Ordnung.</div>
          )}

          {result.fixedPreview && (
            <div className="mt-3">
              <h4 className="text-xs font-semibold mb-1">Auto-Fix-Vorschau</h4>
              <pre className="text-[11px] font-mono bg-bg/50 border border-border/30 rounded-md p-2 max-h-64 overflow-auto">{result.fixedPreview}</pre>
            </div>
          )}

          {/* Export */}
          <div className="mt-3 flex gap-2 flex-wrap">
            <Button variant="secondary" onClick={() => download(`validation-${result.type}.json`, JSON.stringify(result, null, 2), 'application/json')}>
              <Download className="h-3.5 w-3.5 mr-1" /> JSON
            </Button>
            <Button variant="secondary" onClick={() => download(`validation-${result.type}.txt`, renderReport(result, 'text'), 'text/plain')}>
              <Download className="h-3.5 w-3.5 mr-1" /> Text
            </Button>
            <Button variant="secondary" onClick={() => download(`validation-${result.type}.md`, renderReport(result, 'markdown'), 'text/markdown')}>
              <Download className="h-3.5 w-3.5 mr-1" /> Markdown
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
