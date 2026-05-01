import { useEffect, useRef, useState } from 'react';
import { Shell } from '@/components/Shell';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { getDevSocket } from '@/lib/socket';

interface LogLine {
  ts: number;
  level: string;
  message: string;
}

const LEVEL_COLOR: Record<string, string> = {
  error: 'text-red-400',
  warn: 'text-amber-400',
  info: 'text-emerald-400',
  debug: 'text-sky-400',
};

export default function Dev() {
  const [logs, setLogs] = useState<LogLine[]>([]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const s = getDevSocket();
    const onLog = (line: LogLine) => {
      setLogs(prev => [...prev.slice(-499), line]);
    };
    s.on('log', onLog);
    return () => { s.off('log', onLog); };
  }, []);

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [logs]);

  return (
    <Shell title="DEV-Konsole" back="/servers">
      <div className="max-w-6xl mx-auto space-y-4">
        <Card>
          <CardHeader><CardTitle>Live-Logs</CardTitle></CardHeader>
          <div
            ref={ref}
            className="bg-black border border-border rounded-md p-3 h-[60vh] overflow-y-auto font-mono text-xs"
          >
            {logs.length === 0 && <p className="text-muted">Warte auf Log-Events…</p>}
            {logs.map((l, i) => (
              <div key={i} className="whitespace-pre-wrap">
                <span className="text-muted">{new Date(l.ts).toISOString().slice(11, 19)} </span>
                <span className={LEVEL_COLOR[l.level] ?? 'text-white'}>{l.level.toUpperCase()}</span>{' '}
                <span className="text-white/90">{l.message}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </Shell>
  );
}
