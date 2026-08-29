import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LogOut, Power, Save, Send } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Card, CardDesc, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { useToast } from '@/components/ui/Toast';

interface GoodbyeConfig {
  configured: boolean;
  enabled: boolean;
  channelId: string;
}

interface DiscordChannel {
  id: string;
  name: string;
  type: number;
  parentId: string | null;
}

export function GoodbyePanel({ guildId, canManage }: { guildId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const cfgQ = useQuery({
    queryKey: ['goodbye', guildId],
    queryFn: () => api.get<GoodbyeConfig>(`/api/v2/guilds/${guildId}/goodbye/config`),
    enabled: !!guildId && canManage,
  });
  const channelsQ = useQuery({
    queryKey: ['guild-channels', guildId],
    queryFn: () => api.get<{ channels: DiscordChannel[] }>(`/api/v2/guilds/${guildId}/channels`),
    enabled: !!guildId && canManage,
  });

  const [channelId, setChannelId] = useState('');
  const [busy, setBusy] = useState<null | 'save' | 'test' | 'disable'>(null);

  useEffect(() => {
    if (cfgQ.data) setChannelId(cfgQ.data.channelId);
  }, [cfgQ.data]);

  if (!canManage) return null;
  if (cfgQ.isLoading) return <div className="h-40 rounded-xl skeleton" />;

  const channels = channelsQ.data?.channels.filter(channel => channel.type === 0 || channel.type === 5) ?? [];
  const configured = cfgQ.data?.configured ?? false;
  const active = configured && cfgQ.data?.enabled === true;
  const selectedChannelName = channels.find(channel => channel.id === channelId)?.name;
  const buildBody = () => ({ enabled: true, channelId });

  async function save() {
    if (!channelId) { toast.error('Bitte einen Goodbye-Channel auswählen.'); return; }
    setBusy('save');
    try {
      await api.post(`/api/v2/guilds/${guildId}/goodbye/config`, buildBody());
      await qc.invalidateQueries({ queryKey: ['goodbye', guildId] });
      toast.success(active ? 'Goodbye-Channel gespeichert.' : 'Bye Bye aktiviert.');
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Speichern fehlgeschlagen.');
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    if (!channelId) { toast.error('Bitte einen Goodbye-Channel auswählen.'); return; }
    setBusy('test');
    try {
      await api.post(`/api/v2/guilds/${guildId}/goodbye/test`, buildBody());
      toast.success('Goodbye-Testembed gesendet.');
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Test fehlgeschlagen.');
    } finally {
      setBusy(null);
    }
  }

  async function disable() {
    if (!configured) { toast.error('Es ist noch keine Goodbye-Konfiguration gespeichert.'); return; }
    if (!confirm('Bye Bye wirklich deaktivieren? Der gewählte Channel bleibt gespeichert.')) return;
    setBusy('disable');
    try {
      await api.post(`/api/v2/guilds/${guildId}/goodbye/disable`);
      await qc.invalidateQueries({ queryKey: ['goodbye', guildId] });
      toast.success('Bye Bye deaktiviert.');
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Deaktivieren fehlgeschlagen.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-white inline-flex items-center gap-2">
          <LogOut className="h-5 w-5 text-accent" /> Abschied / Goodbye
        </h2>
        <p className="text-xs text-muted mt-0.5">
          Eine separate Abschiedsmeldung im gewählten Kanal. Sie verwendet immer das vordefinierte, sichere V-Bot-Embed.
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle>Bye Bye</CardTitle>
              <CardDesc>Ein Kanal, ein fester Ablauf: Beim Austritt wird das strukturierte Abschieds-Embed gesendet.</CardDesc>
            </div>
            <Badge variant={active ? 'ok' : 'neutral'}>{active ? 'Aktiv' : configured ? 'Inaktiv' : 'Nicht konfiguriert'}</Badge>
          </div>
        </CardHeader>

        <div className="space-y-4 mt-2">
          <label className="block">
            <span className="text-xs text-muted block mb-1">Bye-Bye-Kanal</span>
            <Select value={channelId} onChange={event => setChannelId(event.target.value)} disabled={channelsQ.isLoading}>
              <option value="">— Channel wählen —</option>
              {channels.map(channel => <option key={channel.id} value={channel.id}># {channel.name}</option>)}
            </Select>
            <span className="text-[11px] text-muted mt-1 block">
              Der Bot prüft beim Aktivieren, ob der Channel zu dieser Guild gehört und ob ViewChannel, SendMessages und EmbedLinks vorhanden sind.
            </span>
          </label>

          <div className="rounded-lg border border-border/60 bg-bg-elev/40 p-3">
            <p className="text-xs font-medium text-white/90 mb-1">Vordefiniertes Abschieds-Embed</p>
            <p className="text-xs text-muted leading-relaxed">
              Zeigt Abschied, Mitglied, Eintritt und Austritt klar strukturiert. Bei aktivem Spieler-Cleanup wird dessen Whitelist-Status in derselben Nachricht aktualisiert. Es gibt keine frei editierbare Textvorlage und keine Ping-Auslösung.
            </p>
          </div>

          <div className="rounded-lg border border-border/50 p-2.5 text-xs text-muted">
            <span className="text-white/90 block">Ziel-Channel</span>
            {selectedChannelName ? `# ${selectedChannelName}` : 'Noch nicht ausgewählt'}
          </div>
        </div>
      </Card>

      <div className="flex flex-wrap gap-2">
        <Button onClick={save} disabled={busy !== null}>
          <Save className="h-4 w-4 mr-1" /> {busy === 'save' ? 'Speichert…' : active ? 'Kanal speichern' : 'Bye Bye aktivieren'}
        </Button>
        <Button variant="secondary" onClick={test} disabled={busy !== null}>
          <Send className="h-4 w-4 mr-1" /> {busy === 'test' ? 'Sendet…' : 'Test senden'}
        </Button>
        <Button variant="ghost" onClick={disable} disabled={busy !== null || !active}>
          <Power className="h-4 w-4 mr-1" /> {busy === 'disable' ? 'Deaktiviert…' : 'Deaktivieren'}
        </Button>
      </div>
    </div>
  );
}
