/**
 * Nitrado Mirror — DEV-Seite.
 *
 * Der Nitrado-Server wird ausschliesslich gelesen. Ein One-Shot Snapshot
 * persistiert jedoch eine interne Kopie und ist deshalb eine auditierte
 * privilegierte DEV-Aktion mit Step-Up.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Database, Play, RefreshCw, FolderOpen, FileText, AlertTriangle } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Card, CardHeader, CardTitle, CardDesc } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { StepUpModal, type StepUpRequest } from '@/components/ui/StepUpModal';

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

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

export default function NitradoMirror() {
  const [conns, setConns] = useState<Conn[]>([]);
  const [connsLoaded, setConnsLoaded] = useState(false);
  const [connId, setConnId] = useState('');
  const [guildId, setGuildId] = useState('');
  const [snaps, setSnaps] = useState<Snap[]>([]);
  const [activeSnap, setActiveSnap] = useState<string | null>(null);
  const [progress, setProgress] = useState<Snap | null>(null);
  const [dir, setDir] = useState('/');
  const [browseSnapId, setBrowseSnapId] = useState<string | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [fileText, setFileText] = useState<string | null>(null);
  const [fileMeta, setFileMeta] = useState<Entry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [snapshotsLoading, setSnapshotsLoading] = useState(false);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [fileLoading, setFileLoading] = useState(false);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const snapshotRequestSeq = useRef(0);
  const browseRequestSeq = useRef(0);
  const fileRequestSeq = useRef(0);

  const invalidateDerivedReads = () => {
    snapshotRequestSeq.current += 1;
    browseRequestSeq.current += 1;
    fileRequestSeq.current += 1;
    setSnapshotsLoading(false);
    setBrowseLoading(false);
    setFileLoading(false);
  };

  useEffect(() => {
    api.get<{ connections: Conn[] }>('/api/v2/dev/nitrado-mirror/connections')
      .then(r => {
        setConns(r.connections);
        setConnsLoaded(true);
        setError(null);
      })
      .catch(e => {
        invalidateDerivedReads();
        setConns([]);
        setConnId('');
        setGuildId('');
        setConnsLoaded(true);
        setError(errorMessage(e, 'Connections-Laden fehlgeschlagen.'));
      });
    // Connection discovery runs once; invalidation uses stable state setters and refs only.
  }, []);

  const selectedConn = useMemo(() => conns.find(c => c.id === connId), [conns, connId]);
  useEffect(() => {
    setGuildId(selectedConn?.guildId ?? '');
    setSnaps([]);
    setActiveSnap(null);
    setProgress(null);
    setBrowseSnapId(null);
    setEntries([]);
    setFilePath(null);
    setFileText(null);
    setFileMeta(null);
  }, [selectedConn]);

  const triggerRequest = useMemo<StepUpRequest | null>(() => {
    if (!selectedConn) return null;
    return {
      action: 'nitrado.mirror.snapshot',
      title: 'Nitrado-Snapshot starten',
      description: `Liest Slot ${selectedConn.slot} der Guild ${selectedConn.guildId} vollstaendig und speichert eine interne Snapshot-Kopie. Auf dem Nitrado-Server wird nichts veraendert.`,
      severity: 'warn',
      diff: {
        guildId: selectedConn.guildId,
        connId: selectedConn.id,
        slot: selectedConn.slot,
        serverWrite: false,
        internalSnapshotWrite: true,
      },
    };
  }, [selectedConn]);

  const reloadSnaps = () => {
    if (!guildId || !connId) return;
    const requestSeq = ++snapshotRequestSeq.current;
    setSnapshotsLoading(true);
    api.get<{ snapshots: Snap[] }>(`/api/v2/dev/nitrado-mirror/snapshots?guildId=${guildId}&connId=${connId}`)
      .then(r => {
        if (requestSeq !== snapshotRequestSeq.current) return;
        setSnaps(r.snapshots);
        setError(null);
      })
      .catch(e => {
        if (requestSeq !== snapshotRequestSeq.current) return;
        setSnaps([]);
        setError(errorMessage(e, 'Snapshot-Liste konnte nicht geladen werden.'));
      })
      .finally(() => {
        if (requestSeq === snapshotRequestSeq.current) setSnapshotsLoading(false);
      });
  };
  useEffect(reloadSnaps, [guildId, connId]);

  useEffect(() => {
    if (!activeSnap || !guildId) return;
    let stopped = false;
    const tick = () => {
      api.get<Snap>(`/api/v2/dev/nitrado-mirror/progress/${activeSnap}?guildId=${guildId}`)
        .then(p => {
          if (stopped) return;
          setProgress(p);
          setError(null);
          if (p.status === 'RUNNING') setTimeout(tick, 3000);
          else reloadSnaps();
        })
        .catch(e => {
          if (stopped) return;
          setProgress(null);
          setActiveSnap(null);
          setError(errorMessage(e, 'Snapshot-Fortschritt konnte nicht geladen werden.'));
        });
    };
    tick();
    return () => { stopped = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSnap, guildId]);

  const browse = (snapId: string, path: string) => {
    const requestSeq = ++browseRequestSeq.current;
    setBrowseLoading(true);
    fileRequestSeq.current += 1;
    setFileLoading(false);
    setBrowseSnapId(snapId);
    setDir(path);
    setEntries([]);
    setFileText(null);
    setFilePath(null);
    setFileMeta(null);
    setError(null);
    api.get<{ entries: Entry[] }>(`/api/v2/dev/nitrado-mirror/${snapId}/files?guildId=${guildId}&dir=${encodeURIComponent(path)}`)
      .then(r => {
        if (requestSeq !== browseRequestSeq.current) return;
        setEntries(r.entries);
      })
      .catch(e => {
        if (requestSeq !== browseRequestSeq.current) return;
        setEntries([]);
        setError(errorMessage(e, 'Listing fehlgeschlagen.'));
      })
      .finally(() => {
        if (requestSeq === browseRequestSeq.current) setBrowseLoading(false);
      });
  };

  const openFile = (snapId: string, entry: Entry) => {
    const requestSeq = ++fileRequestSeq.current;
    setFileLoading(true);
    setFilePath(entry.path);
    setFileMeta(entry);
    setFileText(null);
    setError(null);
    api.get<{ meta: Entry; text: string | null; oversize: boolean }>(`/api/v2/dev/nitrado-mirror/${snapId}/file?guildId=${guildId}&path=${encodeURIComponent(entry.path)}`)
      .then(r => {
        if (requestSeq !== fileRequestSeq.current) return;
        setFileText(r.text ?? '(Binaer oder zu gross — kein Inline-Preview)');
      })
      .catch(e => {
        if (requestSeq !== fileRequestSeq.current) return;
        setFilePath(null);
        setFileMeta(null);
        setFileText(null);
        setError(errorMessage(e, 'Datei-Lesen fehlgeschlagen.'));
      })
      .finally(() => {
        if (requestSeq === fileRequestSeq.current) setFileLoading(false);
      });
  };

  const trigger = async (stepUp: { reason: string; reAuth: string }) => {
    if (!guildId || !connId) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ snapshotId: string }>('/api/v2/dev/nitrado-mirror/trigger', {
        guildId,
        connId,
        reason: stepUp.reason,
        reAuth: stepUp.reAuth,
      });
      setActiveSnap(r.snapshotId);
      setProgress(null);
      setStepUpOpen(false);
    } catch (e) {
      setStepUpOpen(false);
      setError(errorMessage(e, 'Trigger fehlgeschlagen.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 min-w-0">
      <Card glow>
        <CardHeader>
          <CardTitle><Database className="h-4 w-4 inline mr-1 text-accent" /> Nitrado Mirror (Server Read-Only)</CardTitle>
          <CardDesc>
            Liest Server-Settings sowie Mission-/Profile-Dateien ohne Nitrado-Schreibzugriff. Das Starten eines Snapshots speichert intern eine Kopie und verlangt deshalb DEV-Step-Up.
          </CardDesc>
        </CardHeader>

        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] min-w-0">
          <select
            aria-label="Nitrado-Connection"
            value={connId}
            onChange={e => {
              invalidateDerivedReads();
              setConnId(e.target.value);
            }}
            className="min-h-11 w-full min-w-0 bg-base text-text border border-border/40 rounded px-3 py-2 text-xs"
          >
            <option value="">— Nitrado-Connection waehlen —</option>
            {conns.map(c => (
              <option key={c.id} value={c.id}>
                Guild {c.guildId} · Slot {c.slot} · {c.alias} ({c.alias5}) · service {c.serviceId ?? '—'} · {c.status}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            onClick={() => setStepUpOpen(true)}
            disabled={!connId || busy || !selectedConn?.serviceId}
          >
            <Play className="h-3.5 w-3.5 mr-1" /> Snapshot starten
          </Button>
        </div>
        {connsLoaded && conns.length === 0 && !error && (
          <p className="text-xs text-muted mt-2">Keine Nitrado-Connections im erlaubten DEV-Scope vorhanden.</p>
        )}
        {error && (
          <div role="alert" className="text-xs text-danger flex gap-2 mt-2 min-w-0 break-words">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" /> <span>{error}</span>
          </div>
        )}
      </Card>

      {progress && (
        <Card>
          <CardHeader>
            <CardTitle>Snapshot {progress.id.slice(0, 8)} · {progress.status}</CardTitle>
            <CardDesc>
              {progress.totalDirs} Verzeichnisse · {progress.totalFiles} Dateien · {fmtBytes(progress.totalBytes)} gesamt · {fmtBytes(progress.storedBytes)} gespeichert · {progress.oversizeFiles} uebergross · {progress.errorCount} Fehler
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
          <div className="max-w-full overflow-x-auto">
            <table className="w-full min-w-[620px] text-xs">
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
                    <td className="py-1 font-mono whitespace-nowrap">{new Date(s.startedAt).toLocaleString()}</td>
                    <td>{s.status}</td>
                    <td className="text-right">{s.totalFiles}</td>
                    <td className="text-right">{fmtBytes(s.totalBytes)}</td>
                    <td className="text-right">{s.errorCount}</td>
                    <td className="text-right">
                      <Button size="sm" onClick={() => browse(s.id, '/')} loading={browseLoading && browseSnapId === s.id} disabled={browseLoading}>
                        <FolderOpen className="h-3.5 w-3.5 mr-1" /> Browse
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-2">
            <Button size="sm" onClick={reloadSnaps} loading={snapshotsLoading}><RefreshCw className="h-3.5 w-3.5 mr-1" /> Aktualisieren</Button>
          </div>
        </Card>
      )}

      {entries.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="break-all"><FolderOpen className="h-4 w-4 inline mr-1" /> {dir}</CardTitle>
            <CardDesc>{entries.length} Eintraege</CardDesc>
          </CardHeader>
          {dir !== '/' && (
            <Button size="sm" loading={browseLoading} onClick={() => {
              const parent = dir.replace(/\/$/, '').split('/').slice(0, -1).join('/') || '/';
              if (browseSnapId) browse(browseSnapId, parent);
            }}>
              ↑ zurueck
            </Button>
          )}
          <ul className="text-xs mt-2 divide-y divide-border/20 min-w-0">
            {entries.map(entry => (
              <li key={entry.id} className="py-2 flex flex-wrap sm:flex-nowrap items-center gap-2 min-w-0">
                <span className="font-mono flex-1 min-w-0 break-all">
                  {entry.isDir ? '📁 ' : '📄 '}{entry.name}
                </span>
                <span className="text-muted shrink-0">{entry.isDir ? '' : fmtBytes(entry.sizeBytes)}</span>
                {entry.isDir ? (
                  <Button size="sm" loading={browseLoading} disabled={browseLoading} onClick={() => {
                    if (browseSnapId) browse(browseSnapId, entry.path);
                  }}>oeffnen</Button>
                ) : (
                  <Button size="sm" loading={fileLoading} disabled={fileLoading} onClick={() => {
                    if (browseSnapId) openFile(browseSnapId, entry);
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
            <CardTitle className="break-all"><FileText className="h-4 w-4 inline mr-1" /> {filePath}</CardTitle>
            <CardDesc className="break-all">
              {fileMeta && `${fmtBytes(fileMeta.sizeBytes)} · ${fileMeta.mimeGuess ?? '?'} · sha256 ${fileMeta.sha256?.slice(0, 12) ?? '—'}`}
            </CardDesc>
          </CardHeader>
          <pre className="text-[11px] max-h-[60vh] max-w-full overflow-auto whitespace-pre-wrap break-all font-mono bg-base/40 p-2 rounded">
            {fileText ?? 'Lade…'}
          </pre>
        </Card>
      )}

      <StepUpModal
        open={stepUpOpen}
        onClose={() => { if (!busy) setStepUpOpen(false); }}
        request={triggerRequest}
        onConfirm={trigger}
        loading={busy}
      />
    </div>
  );
}
