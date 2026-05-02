/**
 * Wiederverwendbares Layout fuer ADM-basierte DEV-Tools (Spec 13).
 *
 * Zeigt links den ADM-Upload-Picker, rechts den Render der jeweiligen
 * Auswertung. Laedt Daten von /api/v2/dev/analytics/adm/:id/<tool>.
 *
 * GUID-Strict-Hinweis ist Teil des Layouts: zeigt, wieviele Eintraege
 * mangels GUID ignoriert wurden.
 */
import { useEffect, useState } from 'react';
import { Activity, AlertTriangle } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Card, CardHeader, CardTitle, CardDesc } from '@/components/ui/Card';
import { DevFileUpload } from '@/components/DevFileUpload';

export interface AdmToolPageProps<T> {
  title: string;
  desc: string;
  /** Pfad-Suffix unter /api/v2/dev/analytics/adm/:id/, z.B. "killfeed". */
  tool: string;
  /** Renderer fuer die Tool-Daten. */
  render: (data: T, meta: { guidEvents: number; ignoredNoGuid: number }) => React.ReactNode;
}

interface ToolResponse<T> {
  tool: string;
  data: T;
  meta: { guidEvents: number; ignoredNoGuid: number };
}

export function AdmToolPage<T>({ title, desc, tool, render }: AdmToolPageProps<T>) {
  const [uploadId, setUploadId] = useState<string | null>(null);
  const [data, setData] = useState<T | null>(null);
  const [meta, setMeta] = useState<{ guidEvents: number; ignoredNoGuid: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!uploadId) { setData(null); setMeta(null); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.get<ToolResponse<T>>(`/api/v2/dev/analytics/adm/${uploadId}/${tool}`)
      .then(r => { if (!cancelled) { setData(r.data); setMeta(r.meta); } })
      .catch(e => { if (!cancelled) setError(e instanceof ApiError ? e.message : 'Laden fehlgeschlagen.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [uploadId, tool]);

  return (
    <div className="space-y-4">
      <Card glow>
        <CardHeader>
          <CardTitle><Activity className="h-4 w-4 inline mr-1 text-accent" /> {title}</CardTitle>
          <CardDesc>{desc}</CardDesc>
        </CardHeader>
        <p className="text-[11px] text-muted">
          GUID-Strict-Modus (Spec 13): Eintraege ohne BattlEye-GUID werden ignoriert und
          erscheinen nicht in der Auswertung.
        </p>
      </Card>

      <div className="grid gap-4 md:grid-cols-[320px_1fr]">
        <DevFileUpload kind="ADM" selectedId={uploadId} onSelect={(id) => setUploadId(id)} accept=".adm,.log,.txt" />
        <Card>
          {!uploadId && <p className="text-xs text-muted">Bitte ADM-Datei auswaehlen oder hochladen.</p>}
          {loading && <p className="text-xs text-muted">Lade Auswertung…</p>}
          {error && (
            <div role="alert" className="text-xs text-danger flex gap-2">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5" /> {error}
            </div>
          )}
          {data && meta && (
            <>
              <div className="text-[11px] text-muted mb-3">
                GUID-Events: <strong>{meta.guidEvents}</strong> · ignoriert (kein GUID): <strong>{meta.ignoredNoGuid}</strong>
              </div>
              {render(data, meta)}
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
