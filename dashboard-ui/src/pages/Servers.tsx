import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, Crown, Shield, Server as ServerIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { Shell } from '@/components/Shell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';

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

export default function Servers() {
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
      </div>
    </Shell>
  );
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
