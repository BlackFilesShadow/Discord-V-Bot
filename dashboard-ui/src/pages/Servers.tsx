import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, Crown, Shield, Server as ServerIcon, Terminal, Activity } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Shell } from '@/components/Shell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useAuth } from '@/lib/auth';
import { DevLoginPanel } from '@/components/DevLoginPanel';

interface Guild {
  id: string;
  name: string;
  iconUrl: string | null;
  memberCount: number | null;
  botPresent: boolean;
  alias5: string | null;
  isOwner: boolean;
  inviteUrl?: string;
}

interface DevSnapshot {
  botReady: boolean;
  uptimeSec: number;
  guildCount: number;
  memory: { rss: number; heapUsed: number; heapTotal: number };
  nodeVersion: string;
}

export default function Servers() {
  const { user } = useAuth();
  const isDev = user?.role === 'DEVELOPER';

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['guilds'],
    queryFn: () => api.get<{ guilds: Guild[] }>('/api/v2/guilds'),
    staleTime: 30_000,
  });

  return (
    <Shell title="Server">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-white">Deine Server</h1>
            <p className="text-muted text-sm mt-1">Server, auf denen du Owner bist oder &quot;Server verwalten&quot;-Rechte hast.</p>
          </div>
          <Button onClick={() => refetch()} variant="outline" size="sm">Aktualisieren</Button>
        </div>

        {isLoading && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-32 rounded-xl skeleton" />
            ))}
          </div>
        )}

        {isError && (
          <Card glow>
            <p className="text-danger font-medium">Fehler beim Laden.</p>
            <p className="text-muted text-sm mt-1">{(error as Error).message}</p>
            <Button onClick={() => refetch()} className="mt-4" size="sm">Erneut versuchen</Button>
          </Card>
        )}

        {data && data.guilds.length === 0 && (
          <Card glow>
            <h2 className="text-lg font-semibold text-white">Keine Server gefunden</h2>
            <p className="text-muted text-sm mt-2">
              Du bist auf keinem Server Owner oder hast keine &quot;Server verwalten&quot;-Rechte.
              Lade den Bot zuerst auf deinen Server ein.
            </p>
          </Card>
        )}

        {data && data.guilds.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {data.guilds.map(g => <GuildCard key={g.id} g={g} />)}
          </div>
        )}

        {isDev && <DevFooter />}

        <CreditsCard />
      </div>
      <DevLoginPanel />
    </Shell>
  );
}

function CreditsCard() {
  return (
    <div className="mt-12 mx-auto max-w-2xl">
      <div className="relative rounded-2xl p-[1.5px] bg-gradient-to-br from-red-500/70 via-red-700/40 to-red-900/70 shadow-[0_0_40px_-8px_rgba(239,68,68,0.45)]">
        <div className="rounded-[14px] bg-gradient-to-b from-[#0c0c12]/95 to-[#06060a]/95 backdrop-blur-md p-6 sm:p-8">
          <div className="flex items-center justify-center gap-3 mb-5">
            <span className="h-px flex-1 bg-gradient-to-r from-transparent to-red-500/40" />
            <span className="text-[11px] tracking-[0.35em] text-red-400/90 uppercase font-semibold">Credits</span>
            <span className="h-px flex-1 bg-gradient-to-l from-transparent to-red-500/40" />
          </div>

          <div className="grid gap-5 sm:grid-cols-2 text-sm">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted mb-1">Entwicklung &amp; Design</div>
              <div className="text-white font-semibold text-base">Void_architect</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted mb-1">Gewidmet an</div>
              <div className="text-white font-semibold text-base">Ash of Phoenix</div>
            </div>
          </div>

          <div className="mt-6">
            <div className="text-[10px] uppercase tracking-wider text-muted mb-2 text-center">Mitglieder</div>
            <div className="flex flex-wrap justify-center gap-2">
              {['BeatsOneElite', 'Blubbi', 'Celinchen0502', 'EoX-Kyrios', 'Mabra'].map(n => (
                <span
                  key={n}
                  className="px-3 py-1 text-xs rounded-full bg-red-500/10 border border-red-500/30 text-red-200/95
                             shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_0_12px_-4px_rgba(239,68,68,0.55)]
                             hover:bg-red-500/15 hover:border-red-500/50 transition-colors"
                >
                  {n}
                </span>
              ))}
            </div>
          </div>

          <div className="mt-6 text-center text-[10px] tracking-widest text-muted/70 uppercase">
            V-Bot
          </div>
        </div>
      </div>
    </div>
  );
}

function DevFooter() {
  const snap = useQuery({
    queryKey: ['dev-snapshot'],
    queryFn: () => api.get<DevSnapshot>('/api/v2/dev/snapshot'),
    retry: false,
    refetchInterval: 15_000,
    staleTime: 10_000,
  });

  const sessionMissing = snap.isError && snap.error instanceof ApiError && (snap.error.status === 401 || snap.error.status === 403);

  return (
    <footer className="mt-10 border-t border-border pt-4 text-xs text-muted">
      <div className="flex flex-wrap items-center gap-3">
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-accent/15 text-accent font-medium">
          <Terminal className="h-3 w-3" /> DEV
        </span>
        {snap.data ? (
          <>
            <span className="inline-flex items-center gap-1">
              <Activity className="h-3 w-3" />
              {snap.data.botReady ? 'Bot online' : 'Bot offline'}
            </span>
            <span>Uptime: {fmtUptime(snap.data.uptimeSec)}</span>
            <span>Guilds: {snap.data.guildCount}</span>
            <span>RSS: {fmtMb(snap.data.memory.rss)}</span>
            <span>Heap: {fmtMb(snap.data.memory.heapUsed)} / {fmtMb(snap.data.memory.heapTotal)}</span>
            <span>Node {snap.data.nodeVersion}</span>
          </>
        ) : sessionMissing ? (
          <span>Live-Stats erfordern aktive DEV-Session.</span>
        ) : snap.isLoading ? (
          <span>Lade Bot-Stats…</span>
        ) : (
          <span>Bot-Stats nicht verfuegbar.</span>
        )}
        <Link to="/dev" className="ml-auto text-accent hover:underline">DEV-Konsole &rarr;</Link>
      </div>
    </footer>
  );
}

function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function fmtMb(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

function GuildCard({ g }: { g: Guild }) {
  const initial = g.name.charAt(0).toUpperCase();
  return (
    <Card interactive={g.botPresent} className="flex flex-col h-full">
      <div className="flex items-start gap-3 mb-3">
        {g.iconUrl ? (
          <img src={g.iconUrl} alt="" className="h-12 w-12 rounded-lg object-cover border border-border" />
        ) : (
          <div className="h-12 w-12 rounded-lg bg-bg-elev grid place-items-center text-white font-bold text-lg border border-border">
            {initial}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold text-white truncate" title={g.name}>{g.name}</h3>
          <div className="flex flex-wrap items-center gap-1 mt-1">
            {g.isOwner ? (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-accent/20 text-accent font-medium">
                <Crown className="h-3 w-3" /> Owner
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-bg-elev text-muted font-medium">
                <Shield className="h-3 w-3" /> Admin
              </span>
            )}
            {g.botPresent && g.alias5 && (
              <span className="text-[10px] font-mono text-muted bg-bg-elev px-1.5 py-0.5 rounded">{g.alias5}</span>
            )}
          </div>
        </div>
      </div>

      <div className="text-xs text-muted mb-4 flex items-center gap-1">
        <ServerIcon className="h-3 w-3" />
        {g.botPresent ? `${g.memberCount ?? '–'} Mitglieder` : 'Bot nicht eingeladen'}
      </div>

      <div className="mt-auto">
        {g.botPresent ? (
          <Link to={`/servers/${g.id}`} className="block">
            <Button className="w-full" size="sm">Verwalten</Button>
          </Link>
        ) : (
          <a href={g.inviteUrl} target="_blank" rel="noopener noreferrer" className="block">
            <Button variant="outline" size="sm" className="w-full">
              <ExternalLink className="h-3.5 w-3.5 mr-1.5" /> Bot einladen
            </Button>
          </a>
        )}
      </div>
    </Card>
  );
}
