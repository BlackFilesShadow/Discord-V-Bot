/**
 * Tool: Live Bot Status (Spec 4: 1. Eintrag).
 *
 * Echtzeit-Snapshot aus /api/v2/dev/snapshot (5s-Polling)
 * + Live-Logs ueber Socket.IO Namespace /dev.
 *
 * Re-Implementiert die Funktionalitaet, die bisher direkt in Dev.tsx lebte.
 */
import { useEffect, useRef, useState } from 'react';
import { Activity, Pause, Play, Search, Trash2 } from 'lucide-react';
import { useDevStatus } from '@/lib/useDevStatus';
import { Card, CardHeader, CardTitle, CardDesc } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { getDevSocket } from '@/lib/socket';

interface Snapshot {
  botReady: boolean;
  uptimeSec: number;
  guildCount: number;
  memory: { rss: number; heapUsed: number; heapTotal: number };
  nodeVersion: string;
}

interface LogLine {
  level: 'error' | 'warn' | 'info' | 'http' | 'debug' | 'verbose' | 'silly';
  message: string;
  timestamp?: string;
}

const LEVELS: ReadonlyArray<LogLine['level']> = ['error', 'warn', 'info', 'debug'];

function levelColor(l: LogLine['level']): string {
  if (l === 'error') return 'text-danger';
  if (l === 'warn') return 'text-warn';
  if (l === 'info') return 'text-ok';
  return 'text-muted';
}
function fmtMB(b: number): string { return `${(b / 1024 / 1024).toFixed(1)} MB`; }
function fmtUptime(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export default function LiveBotStatus() {
  const { data: snap } = useDevStatus<Snapshot>('/api/v2/dev/snapshot', 5000);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState<Set<LogLine['level']>>(new Set(LEVELS));
  const [search, setSearch] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    const s = getDevSocket();
    const onLog = (line: LogLine): void => {
      if (pausedRef.current) return;
      setLogs(prev => {
        const next = [...prev, line];
        return next.length > 500 ? next.slice(-500) : next;
      });
    };
    s.on('log', onLog);
    return () => { s.off('log', onLog); };
  }, []);

  useEffect(() => {
    if (paused) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs, paused]);

  const toggleLevel = (l: LogLine['level']): void => {
    setFilter(prev => {
      const next = new Set(prev);
      if (next.has(l)) next.delete(l); else next.add(l);
      return next;
    });
  };

  const filtered = logs.filter(l =>
    filter.has(l.level) && (!search || l.message.toLowerCase().includes(search.toLowerCase())),
  );

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Bot" value={snap?.botReady ? 'online' : 'offline'} accent={snap?.botReady ? 'ok' : 'danger'} />
        <StatCard label="Guilds" value={snap ? String(snap.guildCount) : '–'} />
        <StatCard label="Uptime" value={snap ? fmtUptime(snap.uptimeSec) : '–'} />
        <StatCard label="Heap" value={snap ? fmtMB(snap.memory.heapUsed) : '–'} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle><Activity className="h-4 w-4 inline mr-1" /> Live-Logs</CardTitle>
          <CardDesc>Letzte 500 Zeilen, Echtzeit via Socket.IO.</CardDesc>
        </CardHeader>

        <div className="flex flex-wrap items-center gap-2 mb-3">
          {LEVELS.map(l => (
            <button
              key={l}
              onClick={() => toggleLevel(l)}
              type="button"
              className={`text-xs px-2.5 py-1 rounded-full font-mono transition-colors focus-ring ${
                filter.has(l)
                  ? `bg-bg-elev ${levelColor(l)} border border-current/40`
                  : 'bg-transparent text-muted/40 border border-border'
              }`}
            >
              {l}
            </button>
          ))}
          <div className="relative flex-1 min-w-[180px]">
            <Search className="h-3.5 w-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted" />
            <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Suche…" className="pl-7 h-8 text-xs" />
          </div>
          <Button size="sm" variant="ghost" onClick={() => setPaused(p => !p)}>
            {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
            <span className="ml-1">{paused ? 'Fortsetzen' : 'Pause'}</span>
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setLogs([])}>
            <Trash2 className="h-3.5 w-3.5" /> <span className="ml-1">Leeren</span>
          </Button>
        </div>

        <div
          ref={scrollRef}
          className="h-[480px] overflow-y-auto bg-black/60 border border-border rounded-md font-mono text-xs"
        >
          {filtered.length === 0 ? (
            <p className="text-muted p-4">Keine Logs.</p>
          ) : (
            <ul className="divide-y divide-border/40">
              {filtered.map((l, i) => (
                <li key={i} className="px-3 py-1 hover:bg-bg-hover/30 flex gap-3">
                  <span className={`shrink-0 w-12 ${levelColor(l.level)}`}>{l.level}</span>
                  {l.timestamp && <span className="shrink-0 text-muted/60">{l.timestamp.slice(11, 19)}</span>}
                  <span className="text-white break-all whitespace-pre-wrap">{l.message}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
    </div>
  );
}

function StatCard({ label, value, accent }: { label: string; value: string; accent?: 'ok' | 'danger' }) {
  return (
    <Card className="!p-4">
      <p className="text-xs text-muted uppercase tracking-wide">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${accent === 'ok' ? 'text-ok' : accent === 'danger' ? 'text-danger' : 'text-white'}`}>
        {value}
      </p>
    </Card>
  );
}
