import { useQuery } from '@tanstack/react-query';
import { LogOut, Sparkles } from 'lucide-react';
import { api } from '@/lib/api';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';

interface WelcomeConfig {
  configured: boolean;
  enabled: boolean;
  channelId: string;
  message: string;
  mode: 'text' | 'ai';
  mediaUrl: string | null;
  mediaLayout: 'image_first' | 'text_first';
}

interface GoodbyeConfig {
  configured: boolean;
  enabled: boolean;
  channelId: string;
}

function status(configured: boolean, enabled: boolean): { label: string; variant: 'ok' | 'neutral' } {
  if (!configured) return { label: 'Nicht konfiguriert', variant: 'neutral' };
  return enabled ? { label: 'Aktiv', variant: 'ok' } : { label: 'Inaktiv', variant: 'neutral' };
}

function channelLabel(channelId: string): string {
  return channelId ? `Discord-Channel ${channelId}` : 'Kein Channel gesetzt';
}

export function WelcomeReadOnlyPanel({ guildId }: { guildId: string }) {
  const welcome = useQuery({
    queryKey: ['welcome', guildId],
    queryFn: () => api.get<WelcomeConfig>(`/api/v2/guilds/${guildId}/welcome/config`),
    enabled: !!guildId,
    retry: false,
  });
  const goodbye = useQuery({
    queryKey: ['goodbye', guildId],
    queryFn: () => api.get<GoodbyeConfig>(`/api/v2/guilds/${guildId}/goodbye/config`),
    enabled: !!guildId,
    retry: false,
  });

  if (welcome.isLoading || goodbye.isLoading) {
    return <div className="h-40 rounded-xl skeleton" />;
  }

  if (welcome.isError || goodbye.isError) {
    const error = (welcome.error ?? goodbye.error) as Error;
    return (
      <Card glow>
        <CardHeader><CardTitle>Nicht erlaubt</CardTitle></CardHeader>
        <p className="text-muted text-sm">Die Member-Lifecycle-Konfiguration konnte nicht gelesen werden.</p>
        <p className="text-danger text-xs mt-2 break-words">{error.message}</p>
      </Card>
    );
  }

  const welcomeStatus = status(welcome.data?.configured ?? false, welcome.data?.enabled ?? false);
  const goodbyeStatus = status(goodbye.data?.configured ?? false, goodbye.data?.enabled ?? false);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-white">Member-Lifecycle</h2>
        <p className="text-xs text-muted mt-1">
          Nur-Lesezugriff: Konfigurationen sind sichtbar, Änderungen benötigen <code>welcome.manage</code>.
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle><span className="inline-flex items-center gap-2"><Sparkles className="h-4 w-4 text-accent" />Willkommen</span></CardTitle>
            <Badge variant={welcomeStatus.variant}>{welcomeStatus.label}</Badge>
          </div>
        </CardHeader>
        <div className="grid gap-3 sm:grid-cols-2 text-sm">
          <div className="rounded-lg border border-border/60 bg-bg-elev/40 p-3 min-w-0">
            <p className="text-xs text-muted mb-1">Channel</p>
            <p className="text-white break-all">{channelLabel(welcome.data?.channelId ?? '')}</p>
          </div>
          <div className="rounded-lg border border-border/60 bg-bg-elev/40 p-3 min-w-0">
            <p className="text-xs text-muted mb-1">Format</p>
            <p className="text-white">{welcome.data?.mode === 'ai' ? 'AI' : 'Normaler Text'}</p>
          </div>
        </div>
        <div className="rounded-lg border border-border/60 bg-bg/60 p-3 mt-3 min-w-0">
          <p className="text-xs text-muted mb-1">Gespeicherte Nachricht</p>
          <p className="text-sm text-white/90 whitespace-pre-wrap break-words">{welcome.data?.message || '—'}</p>
        </div>
        {welcome.data?.mediaUrl && (
          <p className="text-xs text-muted mt-3 break-all">Medienreferenz: {welcome.data.mediaUrl}</p>
        )}
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle><span className="inline-flex items-center gap-2"><LogOut className="h-4 w-4 text-accent" />Abschied / Goodbye</span></CardTitle>
            <Badge variant={goodbyeStatus.variant}>{goodbyeStatus.label}</Badge>
          </div>
        </CardHeader>
        <div className="rounded-lg border border-border/60 bg-bg-elev/40 p-3 min-w-0">
          <p className="text-xs text-muted mb-1">Channel</p>
          <p className="text-white break-all">{channelLabel(goodbye.data?.channelId ?? '')}</p>
        </div>
        <div className="rounded-lg border border-border/60 bg-bg/60 p-3 mt-3 min-w-0">
          <p className="text-xs text-muted mb-1">Ausgabe</p>
          <p className="text-sm text-white/90">Vordefiniertes strukturiertes Abschieds-Embed</p>
        </div>
      </Card>
    </div>
  );
}
