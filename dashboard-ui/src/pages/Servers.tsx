import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Shell } from '@/components/Shell';
import { useAuth } from '@/lib/auth';
import { Users, Hash } from 'lucide-react';

interface GuildItem {
  id: string;
  name: string;
  iconUrl: string | null;
  memberCount: number;
  botPresent: boolean;
  alias5: string | null;
}

export default function Servers() {
  const nav = useNavigate();
  const { user } = useAuth();
  const { data, isLoading, error } = useQuery({
    queryKey: ['guilds'],
    queryFn: () => api.get<{ guilds: GuildItem[] }>('/api/v2/guilds'),
  });

  return (
    <Shell title="Server-Auswahl">
      <div className="max-w-6xl mx-auto">
        <div className="mb-6">
          <h2 className="text-2xl font-bold text-white">Deine Server</h2>
          <p className="text-muted text-sm mt-1">
            Waehle einen Server zum Konfigurieren oder lade V-Bot zu einem neuen Server ein.
          </p>
        </div>

        {isLoading && <p className="text-muted">Lade Server…</p>}
        {error && <p className="text-red-400">Fehler beim Laden: {(error as Error).message}</p>}

        {data && (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {data.guilds.length === 0 && (
              <Card>
                <p className="text-muted text-sm">
                  Keine Owner-Guilds gefunden. Lade V-Bot zu einem deiner Server ein, in denen du Owner bist.
                </p>
              </Card>
            )}
            {data.guilds.map(g => (
              <Card key={g.id}>
                <CardHeader>
                  {g.iconUrl ? (
                    <img src={g.iconUrl} alt={g.name} className="h-12 w-12 rounded-lg" />
                  ) : (
                    <div className="h-12 w-12 rounded-lg bg-bg-elev grid place-items-center text-accent font-bold">
                      {g.name.charAt(0)}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <CardTitle className="truncate">{g.name}</CardTitle>
                    <div className="flex items-center gap-3 text-xs text-muted mt-1">
                      <span className="inline-flex items-center gap-1"><Users className="h-3 w-3" />{g.memberCount}</span>
                      {g.alias5 && (
                        <span className="inline-flex items-center gap-1"><Hash className="h-3 w-3" />{g.alias5}</span>
                      )}
                    </div>
                  </div>
                </CardHeader>
                <Button onClick={() => nav(`/servers/${g.id}`)} className="w-full">
                  Konfigurieren
                </Button>
              </Card>
            ))}
          </div>
        )}

        {user?.role === 'DEVELOPER' && (
          <div className="mt-12 pt-6 border-t border-border">
            <Button variant="ghost" onClick={() => nav('/dev')} size="sm">
              DEV-Konsole oeffnen
            </Button>
          </div>
        )}
      </div>
    </Shell>
  );
}
