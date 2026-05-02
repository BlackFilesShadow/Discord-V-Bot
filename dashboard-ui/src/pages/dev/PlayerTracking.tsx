import { AdmToolPage } from '@/components/AdmToolPage';

interface PlayerSession {
  guid: string;
  name: string;
  connectAt: string;
  disconnectAt?: string;
  durationMin?: number;
  eventCount: number;
}

export default function PlayerTracking() {
  return (
    <AdmToolPage<PlayerSession[]>
      title="Player Tracking"
      desc="Session-Liste pro GUID: Connect-/Disconnect-Zeiten, Event-Anzahl."
      tool="playertracking"
      render={(data) => (
        <table className="w-full text-xs">
          <thead className="text-muted">
            <tr>
              <th className="text-left">Spieler</th>
              <th className="text-left">GUID</th>
              <th className="text-left">Connect</th>
              <th className="text-left">Disconnect</th>
              <th className="text-right">Dauer</th>
              <th className="text-right">Events</th>
            </tr>
          </thead>
          <tbody>
            {data.map((s, i) => (
              <tr key={`${s.guid}-${i}`} className="border-t border-border/20">
                <td className="py-1 font-mono">{s.name}</td>
                <td className="font-mono text-muted">{s.guid.slice(0, 10)}…</td>
                <td>{new Date(s.connectAt).toLocaleString()}</td>
                <td>{s.disconnectAt ? new Date(s.disconnectAt).toLocaleString() : <span className="text-ok">online</span>}</td>
                <td className="text-right">{s.durationMin != null ? `${s.durationMin} min` : '-'}</td>
                <td className="text-right">{s.eventCount}</td>
              </tr>
            ))}
            {data.length === 0 && <tr><td colSpan={6} className="text-muted py-2">Keine Sessions.</td></tr>}
          </tbody>
        </table>
      )}
    />
  );
}
