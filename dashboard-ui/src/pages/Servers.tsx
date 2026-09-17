import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Activity, ArrowUpRight, CircleCheck, Crown, ExternalLink, RefreshCw,
  Shield, Terminal, TriangleAlert, Users,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Shell } from '@/components/Shell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { LegalFooter } from '@/components/LegalFooter';
import { useDevSession } from '@/lib/devSession';

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
  const dev = useDevSession();

  const { data, isLoading, isFetching, isError, error, refetch } = useQuery({
    queryKey: ['guilds'],
    queryFn: () => api.get<{ guilds: Guild[] }>('/api/v2/guilds'),
    staleTime: 30_000,
  });

  const guildCount = data?.guilds.length ?? 0;
  const connectedCount = data?.guilds.filter(guild => guild.botPresent).length ?? 0;
  const memberCountComplete = data?.guilds.every(guild => guild.memberCount !== null) ?? false;
  const memberCount = data?.guilds.reduce((total, guild) => total + (guild.memberCount ?? 0), 0) ?? 0;

  return (
    <Shell title="Server">
      <div className="nexus-servers max-w-5xl mx-auto min-w-0">
        <section className="nexus-servers-hero" aria-labelledby="servers-title">
          <div className="nexus-servers-horizon" aria-hidden="true" />
          <div className="relative z-10 flex flex-wrap items-end justify-between gap-4">
            <div className="min-w-0">
              <div className="nexus-eyebrow">Serverzentrale</div>
              <h1 id="servers-title" className="nexus-page-title">Deine <span>Server</span></h1>
              <p className="text-muted text-sm mt-2 max-w-xl">Server, auf denen du Owner bist oder &quot;Server verwalten&quot;-Rechte hast.</p>
            </div>
            <Button
              onClick={() => refetch()}
              variant="outline"
              size="sm"
              loading={isFetching}
              className="nexus-refresh-control"
            >
              {!isFetching && <RefreshCw className="h-4 w-4" aria-hidden="true" />}
              Aktualisieren
            </Button>
          </div>

          {data && (
            <div className="nexus-overview" aria-label="Serverübersicht">
              <div className="nexus-overview-item">
                <span>Communities</span>
                <strong>{guildCount} Server</strong>
              </div>
              <div className="nexus-overview-item">
                <span>Mitglieder</span>
                <strong>{memberCountComplete ? memberCount.toLocaleString('de-DE') : '–'}</strong>
              </div>
              <div className="nexus-overview-item" data-tone="ok">
                <span>Bot verbunden</span>
                <strong>{connectedCount} von {guildCount}</strong>
              </div>
            </div>
          )}
        </section>

        {isLoading && (
          <div className="nexus-server-grid">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-72 rounded-[22px] skeleton" />
            ))}
          </div>
        )}

        {isError && (
          <Card glow className="nexus-message-card">
            <p className="text-danger font-medium">Fehler beim Laden.</p>
            <p className="text-muted text-sm mt-1 break-words">{(error as Error).message}</p>
            <Button onClick={() => refetch()} className="mt-4" size="sm" loading={isFetching}>Erneut versuchen</Button>
          </Card>
        )}

        {data && data.guilds.length === 0 && (
          <Card glow className="nexus-message-card">
            <h2 className="text-lg font-semibold text-white">Keine Server gefunden</h2>
            <p className="text-muted text-sm mt-2">
              Du bist auf keinem Server Owner oder hast keine &quot;Server verwalten&quot;-Rechte.
              Lade den Bot zuerst auf deinen Server ein.
            </p>
          </Card>
        )}

        {data && data.guilds.length > 0 && (
          <div className="nexus-server-grid">
            {data.guilds.map(g => <GuildCard key={g.id} g={g} />)}
          </div>
        )}

        {dev.eligible && dev.active && <DevFooter />}

        <CreditsCard />
        <LegalFooter className="mt-5 pb-3 sm:justify-end" />
      </div>
    </Shell>
  );
}

function CreditsCard() {
  return (
    <div className="nexus-credits mt-10" id="credits">
      <div className="nexus-credits-primary">
        <span>Credits</span>
        <div>
          <strong>Void_architect</strong>
          <small>Entwicklung &amp; Design</small>
        </div>
        <div>
          <strong>Ash of Phoenix</strong>
          <small>Gewidmet an</small>
        </div>
      </div>
      <div className="nexus-credit-people" aria-label="Mitglieder">
        {['BeatsOneElite', 'Blubbi', 'Celinchen0502', 'EoX-Kyrios', 'Mabra'].map(n => (
          <span key={n}>{n}</span>
        ))}
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
        <Link to="/dev" className="sm:ml-auto min-h-11 inline-flex items-center text-accent hover:underline">DEV-Konsole &rarr;</Link>
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
    <Card interactive={g.botPresent} className="nexus-server-card flex flex-col h-full min-w-0 !p-0 overflow-hidden">
      <div className="nexus-server-card-hero">
        <div className="nexus-server-identity">
          {g.iconUrl ? (
            <img src={g.iconUrl} alt="" className="nexus-server-avatar object-cover" />
          ) : (
            <div className="nexus-server-avatar" aria-hidden="true">
              {initial}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold text-white truncate" title={g.name}>{g.name}</h3>
            <span className="nexus-server-role">{g.isOwner ? 'Owner' : 'Administrator'}</span>
          </div>
        </div>
        <Badge variant={g.botPresent ? 'ok' : 'warn'} pulse={g.botPresent} className="nexus-server-status shrink-0">
          {g.botPresent ? <CircleCheck className="h-3.5 w-3.5" aria-hidden="true" /> : <TriangleAlert className="h-3.5 w-3.5" aria-hidden="true" />}
          {g.botPresent ? 'Aktiv' : 'Einrichtung'}
        </Badge>
      </div>

      <div className="nexus-server-card-body">
        <div className="nexus-server-metrics">
          <div className="nexus-server-metric">
            <span><Users className="h-4 w-4" aria-hidden="true" /> Mitglieder</span>
            <strong>{g.memberCount ?? '–'} Mitglieder</strong>
          </div>
          <div className="nexus-server-metric">
            <span><Activity className="h-4 w-4" aria-hidden="true" /> Verbindung</span>
            <strong>{g.botPresent ? 'Bot aktiv' : 'Bot nicht eingeladen'}</strong>
          </div>
        </div>

        <div className="nexus-server-tags">
          <span>{g.isOwner ? <Crown className="h-3.5 w-3.5" aria-hidden="true" /> : <Shield className="h-3.5 w-3.5" aria-hidden="true" />}{g.isOwner ? 'Owner' : 'Admin'}</span>
          {g.botPresent && g.alias5 && <span className="font-mono">{g.alias5}</span>}
        </div>

        <div className="mt-auto pt-4">
          {g.botPresent ? (
            <Link to={`/servers/${g.id}`} className="block">
              <Button className="nexus-server-action w-full" size="md">
                <span>Verwalten</span><ArrowUpRight className="h-4 w-4" aria-hidden="true" />
              </Button>
            </Link>
          ) : (
            <a href={g.inviteUrl} target="_blank" rel="noopener noreferrer" className="block">
              <Button variant="outline" size="md" className="nexus-server-action w-full">
                <span>Bot einladen</span><ExternalLink className="h-4 w-4" aria-hidden="true" />
              </Button>
            </a>
          )}
        </div>
      </div>
    </Card>
  );
}
