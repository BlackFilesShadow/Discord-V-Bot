/**
 * Wiederverwendbare DEV-Upload-Komponente.
 *
 * Erlaubt Mehrfach-Upload (max 10 / 50 MB pro Datei) fuer einen festen Kind.
 * Listet bestehende Uploads des Users (eigene), erlaubt Auswahl + Loeschen.
 *
 * Eigentliche Auswertung erfolgt in der Parent-Page; diese Komponente
 * fokussiert sich auf File-Management.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Upload, Trash2, RefreshCw, FileText, AlertTriangle } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle, CardDesc } from '@/components/ui/Card';

export type DevUploadKind = 'ADM' | 'RPT' | 'XML' | 'JSON';

export interface DevUploadRecord {
  id: string;
  userDiscordId: string;
  kind: DevUploadKind;
  originalName: string;
  storedPath: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  expiresAt: string;
}

interface UploadResult {
  results: Array<{ ok: boolean; name: string; id?: string; error?: string }>;
}

export interface DevFileUploadProps {
  kind: DevUploadKind;
  selectedId?: string | null;
  onSelect?: (id: string | null, record: DevUploadRecord | null) => void;
  /** akzeptierte Dateiendungen fuer den File-Picker (rein UI-Hint). */
  accept?: string;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function DevFileUpload({ kind, selectedId, onSelect, accept }: DevFileUploadProps) {
  const [uploads, setUploads] = useState<DevUploadRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadResults, setUploadResults] = useState<UploadResult['results']>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.get<{ uploads: DevUploadRecord[] }>(`/api/v2/dev/uploads?kind=${kind}`);
      setUploads(r.uploads);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Laden fehlgeschlagen.');
    } finally {
      setLoading(false);
    }
  }, [kind]);

  useEffect(() => { reload(); }, [reload]);

  const handleFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setError(null);
    setUploadResults([]);
    const fd = new FormData();
    fd.append('kind', kind);
    for (let i = 0; i < files.length && i < 10; i++) fd.append('files', files[i]);
    try {
      const r = await api.uploadForm<UploadResult>('/api/v2/dev/uploads', fd);
      setUploadResults(r.results);
      await reload();
      // Erstes erfolgreiches Upload auto-selektieren
      const firstOk = r.results.find(x => x.ok && x.id);
      if (firstOk?.id) {
        const rec = uploads.find(u => u.id === firstOk.id) ?? null;
        onSelect?.(firstOk.id, rec);
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Upload fehlgeschlagen.');
    } finally {
      if (inputRef.current) inputRef.current.value = '';
    }
  }, [kind, onSelect, reload, uploads]);

  const handleDelete = useCallback(async (id: string) => {
    if (!confirm('Upload wirklich loeschen?')) return;
    try {
      await api.del(`/api/v2/dev/uploads/${id}`);
      if (selectedId === id) onSelect?.(null, null);
      await reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Loeschen fehlgeschlagen.');
    }
  }, [onSelect, reload, selectedId]);

  return (
    <Card>
      <CardHeader>
        <CardTitle><Upload className="h-4 w-4 inline mr-1" /> {kind}-Upload</CardTitle>
        <CardDesc>Eigene Dateien (24h gespeichert, max 50 MB / Datei, 10 / Upload).</CardDesc>
      </CardHeader>

      <div className="flex flex-wrap gap-2 mb-3">
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          multiple
          onChange={e => handleFiles(e.target.files)}
          className="block text-xs file:mr-3 file:rounded-md file:border-0 file:bg-accent/20 file:px-3 file:py-1.5 file:text-accent file:hover:bg-accent/30"
        />
        <Button variant="ghost" size="sm" onClick={reload} disabled={loading}>
          <RefreshCw className={`h-3.5 w-3.5 mr-1 ${loading ? 'animate-spin' : ''}`} /> Aktualisieren
        </Button>
      </div>

      {error && (
        <div role="alert" className="text-xs text-danger mb-3 flex items-start gap-2">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5" /> {error}
        </div>
      )}

      {uploadResults.length > 0 && (
        <ul className="text-xs mb-3 space-y-0.5">
          {uploadResults.map((r, i) => (
            <li key={i} className={r.ok ? 'text-ok' : 'text-danger'}>
              {r.ok ? '✓' : '✗'} {r.name}{r.error ? ` — ${r.error}` : ''}
            </li>
          ))}
        </ul>
      )}

      {uploads.length === 0 && !loading && (
        <p className="text-xs text-muted">Noch keine Uploads.</p>
      )}

      <ul className="space-y-1">
        {uploads.map(u => {
          const sel = selectedId === u.id;
          return (
            <li key={u.id} className={`flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs ${sel ? 'border-accent bg-accent/10' : 'border-border/30'}`}>
              <button
                onClick={() => onSelect?.(u.id, u)}
                className="flex-1 flex items-center gap-2 text-left"
                aria-pressed={sel}
              >
                <FileText className="h-3.5 w-3.5 text-muted" />
                <span className="font-mono">{u.originalName}</span>
                <span className="text-muted">({fmtBytes(u.sizeBytes)})</span>
                <span className="text-muted ml-auto">{new Date(u.createdAt).toLocaleString()}</span>
              </button>
              <button
                onClick={() => handleDelete(u.id)}
                aria-label="Loeschen"
                className="text-muted hover:text-danger"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
