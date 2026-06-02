/**
 * Nitrado Mirror — DEV-Seite.
 *
 * READ-ONLY. Erlaubt:
 *  - Connection auswählen
 *  - One-Shot Voll-Snapshot starten
 *  - Fortschritt beobachten
 *  - Snapshots auflisten, Settings anzeigen, Datei-Browser
 */

import { useEffect, useMemo, useState } from 'react';
import { Database, Play, RefreshCw, FolderOpen, FileText, AlertTriangle } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Card, CardHeader, CardTitle, CardDesc } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';

interface Conn {
  id: string;
  guildId: string;
  slot: number;
  alias: string;
  alias5: string;
  serviceId: string | null;
  status: string;
}

interface Snap {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'RUNNING' | 'OK' | 'PARTIAL' | 'FAILED';
  totalFiles: number;
  totalDirs: number;
  totalBytes: string;
  storedBytes: string;
  oversizeFiles: number;
  errorCount: number;
}

interface Entry {
  id: string;
  path: string;
  name: string;
  parentDir: string;
  isDir: boolean;
  sizeBytes: string;
  modifiedAt: string | null;
  sha256: string | null;
  mimeGuess: string | null;
  isText: boolean;
  oversize: boolean;
  errorMsg: string | null;
  hasContent: boolean;
}

function fmtBytes(s: string | number): string {
  const n = typeof s === 'string' ? Number(s) : s;
  if (!isFinite(n)) return String(s);
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n; let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 2 : 1)} ${u[i]}`;
}

export default function NitradoMirror() {
  const [conns, setConns] = useState<Conn[]>([]);
  const [connsLoaded, setConnsLoaded] = useState(false);
  const [connId, setConnId] = useState<string>('');
  const [guildId, setGuildId] = useState<string>('');
  const [snaps, setSnaps] = useState<Snap[]>([]);
  const [activeSnap, setActiveSnap] = useState<string | null>(null);
  const [progress, setProgress] = useState<Snap | null>(null);
  const [dir, setDir] = useState<string>('/');
  const [browseSnapId, setBrowseSnapId] = useState<string | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [fileText, setFileText] = useState<string | null>(null);
  const [fileMeta, setFileMeta] = useState<Entry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Connections laden
  useEffect(() => {
    api.get<{ connections: Conn[] }>('/api/v2/dev/nitrado-mirror/connections')
      .then(r => { setConns(r.connections); setConnsLoaded(true); })
      .catch(e => { setConnsLoaded(true); setError(e instanceof ApiError ? e.message : 'Connections-Laden fehlgeschlagen.'); });
  }, []);

  const selectedConn = useMemo(() => conns.find(c => c.id === connId), [conns, connId]);
  useEffect(() => { if (selectedConn) setGuildId(selectedConn.guildId); }, [selectedConn]);

  // Snapshot-Liste laden
  const reloadSnaps = () => {
    if (!guildId || !connId) return;
    api.get<{ snapshots: Snap[] }>(`/api/v2/dev/nitrado-mirror/snapshots?guildId=${guildId}&connId=${connId}`)
      .then(r => setSnaps(r.snapshots))
      .catch(() => { /* still */ });
  };
  useEffect(reloadSnaps, [guildId, connId]);

  // Aktiven Snapshot pollen wenn RUNNING
  useEffect(() => {
    if (!activeSnap || !guildId) return;
    let stopped = false;
    const tick = () => {
      api.get<Snap>(`/api/v2/dev/nitrado-mirror/progress/${activeSnap}?guildId=${guildId}`)
        .then(p => {
          if (stopped) return;
          setProgress(p);
          if (p.status === 'RUNNING') setTimeout(tick, 3000);
          else reloadSnaps();
        })
        .catch(() => { if (!stopped) setTimeout(tick, 5000); });
    };
    tick();
    return () => { stopped = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSnap, guildId]);

  // Datei-Browser
  const browse = (snapId: string, path: string) => {
    setBrowseSnapId(snapId);
    setDir(path); setFileText(null); setFilePath(null); setFileMeta(null);
    api.get<{ entries: Entry[] }>(`/api/v2/dev/nitrado-mirror/${snapId}/files?guildId=${guildId}&dir=${encodeURIComponent(path)}`)
      .then(r => setEntries(r.entries))
      .catch(e => setError(e instanceof ApiError ? e.message : 'Listing fehlgeschlagen.'));
  };

  const openFile = (snapId: string, e: Entry) => {
    setFilePath(e.path); setFileMeta(e); setFileText(null);
    api.get<{ meta: Entry; text: string | null; oversize: boolean }>(`/api/v2/dev/nitrado-mirror/${snapId}/file?guildId=${guildId}&path=${encodeURIComponent(e.path)}`)
      .then(r => setFileText(r.text ?? '(Binär oder zu groß — kein Inline-Preview)'))
      .catch(err => setError(err instanceof ApiError ? err.message : 'Datei-Lesen fehlgeschlagen.'));
  };

  const trigger = async () => {
    if (!guildId || !connId) return;
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ snapshotId: string }>('/api/v2/dev/nitrado-mirror/trigger', { guildId, connId });
      setActiveSnap(r.snapshotId);
      setProgress(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Trigger fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card glow>
        <CardHeader>
          <CardTitle><Database className="h-4 w-4 inline mr-1 text-accent" /> Nitrado Mirror (Read-Only)</CardTitle>
          <CardDesc>Einmaliger Voll-Snapshot aller Server-Settings + Mission-/Profile-Dateien. Strikt nur GET — es wird nichts auf dem Nitrado-Server verändert oder gelöscht.</CardDesc>
        </CardHeader>

        <div className="grid gap-3 md:grid-cols-[1fr_auto]">
          <select
            value={connId}
            onChange={e => setConnId(e.target.value)}
            className="bg-base text-text border border-border/40 rounded px-2 py-1 text-xs"
          >
            <option value="">— Nitrado-Connection wählen —</option>
            {conns.map(c => (
              <option key={c.id} value={c.id}>
                Guild {c.guildId} · Slot {c.slot} · {c.alias} ({c.alias5}) · service {c.serviceId ?? '—'} · {c.status}
              </option>
            ))}
          </select>
          <Button size="sm" onClick={trigger} disabled={!connId || busy || !selectedConn?.serviceId}>
            <Play className="h-3.5 w-3.5 mr-1" /> Snapshot starten
          </Button>
        </div>
        {connsLoaded && conns.length === 0 && !error && (
          <p className="text-xs text-muted mt-2">Keine Nitrado-Connections vorhanden. Verbinde zuerst einen Server in den Nitrado-Einstellungen.</p>
        )}
        {error && (
          <div role="alert" className="text-xs text-danger flex gap-2 mt-2">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5" /> {error}
          </div>
        )}
      </Card>

      {progress && (
        <Card>
          <CardHeader>
            <CardTitle>Snapshot {progress.id.slice(0, 8)} · {progress.status}</CardTitle>
            <CardDesc>
              {progress.totalDirs} Verzeichnisse · {progress.totalFiles} Dateien · {fmtBytes(progress.totalBytes)} gesamt · {fmtBytes(progress.storedBytes)} gespeichert · {progress.oversizeFiles} übergroß · {progress.errorCount} Fehler
            </CardDesc>
          </CardHeader>
        </Card>
      )}

      {snaps.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Snapshots</CardTitle>
            <CardDesc>Alle Snapshots dieser Connection.</CardDesc>
          </CardHeader>
          <table className="w-full text-xs">
            <thead className="text-muted">
              <tr>
                <th className="text-left">Gestartet</th>
                <th className="text-left">Status</th>
                <th className="text-right">Files</th>
                <th className="text-right">Bytes</th>
                <th className="text-right">Errors</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {snaps.map(s => (
                <tr key={s.id} className="border-t border-border/20">
                  <td className="py-1 font-mono">{new Date(s.startedAt).toLocaleString()}</td>
                  <td>{s.status}</td>
                  <td className="text-right">{s.totalFiles}</td>
                  <td className="text-right">{fmtBytes(s.totalBytes)}</td>
                  <td className="text-right">{s.errorCount}</td>
                  <td className="text-right">
                    <Button size="sm" onClick={() => browse(s.id, '/')}>
                      <FolderOpen className="h-3.5 w-3.5 mr-1" /> Browse
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-2">
            <Button size="sm" onClick={reloadSnaps}><RefreshCw className="h-3.5 w-3.5 mr-1" /> Aktualisieren</Button>
          </div>
        </Card>
      )}

      {entries.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle><FolderOpen className="h-4 w-4 inline mr-1" /> {dir}</CardTitle>
            <CardDesc>{entries.length} Einträge</CardDesc>
          </CardHeader>
          {dir !== '/' && (
            <Button size="sm" onClick={() => {
              const parent = dir.replace(/\/$/, '').split('/').slice(0, -1).join('/') || '/';
              if (browseSnapId) browse(browseSnapId, parent);
            }}>
              ↑ zurück
            </Button>
          )}
          <ul className="text-xs mt-2 divide-y divide-border/20">
            {entries.map(e => (
              <li key={e.id} className="py-1 flex items-center gap-2">
                <span className="font-mono flex-1">
                  {e.isDir ? '📁 ' : '📄 '}{e.name}
                </span>
                <span className="text-muted">{e.isDir ? '' : fmtBytes(e.sizeBytes)}</span>
                {e.isDir ? (
                  <Button size="sm" onClick={() => {
                    if (browseSnapId) browse(browseSnapId, e.path);
                  }}>öffnen</Button>
                ) : (
                  <Button size="sm" onClick={() => {
                    if (browseSnapId) openFile(browseSnapId, e);
                  }}>ansehen</Button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {filePath && (
        <Card>
          <CardHeader>
            <CardTitle><FileText className="h-4 w-4 inline mr-1" /> {filePath}</CardTitle>
            <CardDesc>
              {fileMeta && `${fmtBytes(fileMeta.sizeBytes)} · ${fileMeta.mimeGuess ?? '?'} · sha256 ${fileMeta.sha256?.slice(0, 12) ?? '—'}`}
            </CardDesc>
          </CardHeader>
          <pre className="text-[11px] max-h-[60vh] overflow-auto whitespace-pre-wrap font-mono bg-base/40 p-2 rounded">
            {fileText ?? 'Lade…'}
          </pre>
        </Card>
      )}
    </div>
  );
}
