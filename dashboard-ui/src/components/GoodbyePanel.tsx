import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LogOut, Power, RotateCcw, Save, Send } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Card, CardDesc, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Switch } from '@/components/ui/Switch';
import { Badge } from '@/components/ui/Badge';
import { useToast } from '@/components/ui/Toast';

interface GoodbyeConfig {
  configured: boolean;
  enabled: boolean;
  channelId: string;
  message: string;
}

interface DiscordChannel {
  id: string;
  name: string;
  type: number;
  parentId: string | null;
}

const MAX_MESSAGE_GRAPHEMES = 4000;
const DEFAULT_MESSAGE = 'Auf Wiedersehen {user}! 👋 Danke für deine Zeit auf {guild}.';

const VARIABLES: Array<{ key: string; desc: string }> = [
  { key: '{user}', desc: 'Letzter bekannter Anzeigename; Guild-Nickname hat Vorrang' },
  { key: '{username}', desc: 'Letzter bekannter globaler Discord-Username' },
  { key: '{nickname}', desc: 'Letzter Guild-Nickname; fällt auf Username zurück' },
  { key: '{guild}', desc: 'Name des Servers' },
  { key: '{count}', desc: 'Aktuelle Mitgliederzahl nach dem Austritt' },
  { key: '{date}', desc: 'Aktuelles Datum' },
  { key: '{time}', desc: 'Aktuelle Uhrzeit' },
  { key: '{year}', desc: 'Aktuelles Jahr' },
];

function splitGraphemes(value: string): string[] {
  const Segmenter = (Intl as unknown as {
    Segmenter?: new (locale?: string | string[], options?: { granularity: 'grapheme' }) => {
      segment(input: string): Iterable<{ segment: string }>;
    };
  }).Segmenter;

  if (Segmenter) {
    return Array.from(new Segmenter('de', { granularity: 'grapheme' }).segment(value), part => part.segment);
  }
  return Array.from(value);
}

function countGraphemes(value: string): number {
  return splitGraphemes(value).length;
}

function clampGraphemes(value: string): string {
  const parts = splitGraphemes(value);
  return parts.length <= MAX_MESSAGE_GRAPHEMES ? value : parts.slice(0, MAX_MESSAGE_GRAPHEMES).join('');
}

function renderPreview(template: string): string {
  const now = new Date();
  const date = new Intl.DateTimeFormat('de-DE', { dateStyle: 'long', timeZone: 'Europe/Berlin' }).format(now);
  const time = new Intl.DateTimeFormat('de-DE', { timeStyle: 'short', timeZone: 'Europe/Berlin' }).format(now);
  return template
    .replace(/\{user\}/g, 'LetzterNick')
    .replace(/\{username\}/g, 'MaxMustermann')
    .replace(/\{nickname\}/g, 'LetzterNick')
    // Alte Vorlagen bleiben lesbar; die sichere Mention wird im echten Embed
    // separat im strukturierten Bereich "Mitglied" gerendert.
    .replace(/\{mention\}/g, '')
    .replace(/\{guild\}/g, 'Mein Server')
    .replace(/\{count\}/g, '127')
    .replace(/\{member_count\}/g, '127')
    .replace(/\{date\}/g, date)
    .replace(/\{time\}/g, time)
    .replace(/\{year\}/g, String(now.getFullYear()))
    .replace(/ {2,}/g, ' ')
    .trim();
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

  const [enabled, setEnabled] = useState(true);
  const [channelId, setChannelId] = useState('');
  const [message, setMessage] = useState(DEFAULT_MESSAGE);
  const [busy, setBusy] = useState<null | 'save' | 'test' | 'disable'>(null);

  useEffect(() => {
    const data = cfgQ.data;
    if (!data) return;
    setEnabled(data.enabled);
    setChannelId(data.channelId);
    setMessage(clampGraphemes(data.message || DEFAULT_MESSAGE));
  }, [cfgQ.data]);

  if (!canManage) return null;
  if (cfgQ.isLoading) return <div className="h-40 rounded-xl skeleton" />;

  const channels = channelsQ.data?.channels.filter(channel => channel.type === 0 || channel.type === 5) ?? [];
  const visibleMessageLength = countGraphemes(message);
  const configured = cfgQ.data?.configured ?? false;
  const selectedChannelName = channels.find(channel => channel.id === channelId)?.name;
  const buildBody = () => ({ enabled, channelId, message });

  async function save() {
    if (!channelId) { toast.error('Bitte einen Goodbye-Channel auswählen.'); return; }
    if (!message.trim()) { toast.error('Die Goodbye-Nachricht darf nicht leer sein.'); return; }
    setBusy('save');
    try {
      await api.post(`/api/v2/guilds/${guildId}/goodbye/config`, buildBody());
      await qc.invalidateQueries({ queryKey: ['goodbye', guildId] });
      toast.success('Goodbye-Konfiguration gespeichert.');
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Speichern fehlgeschlagen.');
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    if (!channelId) { toast.error('Bitte einen Goodbye-Channel auswählen.'); return; }
    if (!message.trim()) { toast.error('Die Goodbye-Nachricht darf nicht leer sein.'); return; }
    setBusy('test');
    try {
      await api.post(`/api/v2/guilds/${guildId}/goodbye/test`, buildBody());
      toast.success('Goodbye-Testnachricht gesendet.');
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Test fehlgeschlagen.');
    } finally {
      setBusy(null);
    }
  }

  async function disable() {
    if (!configured) { toast.error('Es ist noch keine Goodbye-Konfiguration gespeichert.'); return; }
    if (!confirm('Goodbye-System wirklich deaktivieren? Die Konfiguration bleibt erhalten.')) return;
    setBusy('disable');
    try {
      await api.post(`/api/v2/guilds/${guildId}/goodbye/disable`);
      await qc.invalidateQueries({ queryKey: ['goodbye', guildId] });
      toast.success('Goodbye-System deaktiviert.');
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Deaktivieren fehlgeschlagen.');
    } finally {
      setBusy(null);
    }
  }

  function reset() {
    const data = cfgQ.data;
    setEnabled(data?.enabled ?? true);
    setChannelId(data?.channelId ?? '');
    setMessage(clampGraphemes(data?.message || DEFAULT_MESSAGE));
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-white inline-flex items-center gap-2">
          <LogOut className="h-5 w-5 text-accent" /> Abschied / Goodbye
        </h2>
        <p className="text-xs text-muted mt-0.5">
          Sendet beim Austritt ein sauber strukturiertes Embed. Eine sicher aufgelöste Discord-Erwähnung steht im Bereich „Mitglied“, löst keinen Ping aus und rohe Discord-IDs werden niemals angezeigt.
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle>Goodbye-System</CardTitle>
              <CardDesc>Goodbye und optionaler Spieler-Cleanup sind getrennte Systeme. Ist Cleanup aktiv, wird sein technischer Nitrado-Status in derselben Nachricht aktualisiert.</CardDesc>
            </div>
            <Badge variant={enabled && configured ? 'ok' : 'neutral'}>
              {enabled && configured ? 'Aktiv' : configured ? 'Inaktiv' : 'Nicht konfiguriert'}
            </Badge>
          </div>
        </CardHeader>

        <div className="space-y-4 mt-2">
          <Switch checked={enabled} onChange={setEnabled} label="Goodbye-System aktiviert" />

          <label className="block">
            <span className="text-xs text-muted block mb-1">Goodbye-Channel</span>
            <Select value={channelId} onChange={event => setChannelId(event.target.value)} disabled={channelsQ.isLoading}>
              <option value="">— Channel wählen —</option>
              {channels.map(channel => <option key={channel.id} value={channel.id}># {channel.name}</option>)}
            </Select>
            <span className="text-[11px] text-muted mt-1 block">
              Der Bot prüft beim Speichern, ob der Channel zu dieser Guild gehört und ob ViewChannel + SendMessages vorhanden sind.
            </span>
          </label>

          <label className="block">
            <span className="text-xs text-muted block mb-1">Abschiedsnachricht</span>
            <textarea
              value={message}
              onChange={event => setMessage(clampGraphemes(event.target.value))}
              rows={6}
              className="input-premium w-full rounded-lg text-white px-3.5 py-2.5 text-sm placeholder:text-muted/80 focus:outline-none resize-y"
              placeholder={DEFAULT_MESSAGE}
            />
            <span className="text-[11px] text-muted">
              {visibleMessageLength}/{MAX_MESSAGE_GRAPHEMES} sichtbare Zeichen · längere Texte werden mit der bestehenden sicheren Discord-Zustellung aufgeteilt.
            </span>
          </label>

          <div className="rounded-lg border border-border/60 bg-bg-elev/40 p-3">
            <p className="text-xs font-medium text-white/90 mb-2">Verfügbare Platzhalter</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5">
              {VARIABLES.map(variable => (
                <button
                  key={variable.key}
                  type="button"
                  onClick={() => setMessage(current => clampGraphemes(`${current} ${variable.key}`))}
                  className="flex items-start gap-2 text-left text-xs hover:bg-bg-elev rounded px-1.5 py-1 transition-colors focus-ring"
                  title="In Nachricht einfügen"
                >
                  <code className="font-mono text-accent shrink-0">{variable.key}</code>
                  <span className="text-muted">{variable.desc}</span>
                </button>
              ))}
            </div>
            <p className="text-[11px] text-muted mt-2">
              Die Discord-Erwähnung muss nicht als Platzhalter eingefügt werden. Sie erscheint nur nach sicherer Discord-Auflösung im Bereich „Mitglied“; andernfalls wird ausschließlich ein lesbarer Name bzw. „Discord-Nutzer“ angezeigt — niemals eine ID-Nummer.
            </p>
          </div>

          <div className="rounded-lg border border-border/60 bg-bg/60 p-3">
            <p className="text-xs font-medium text-white/90 mb-1">Vorschau</p>
            <p className="text-sm text-white/90 whitespace-pre-wrap break-words">{renderPreview(message) || '—'}</p>
            <p className="text-[11px] text-muted mt-2">
              Beispiel: letzter Guild-Nickname „LetzterNick“. Im echten Embed werden Identität, Status sowie Eintritt/Austritt in einer stabilen Mitgliedsgruppe dargestellt.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-muted">
            <div className="rounded-lg border border-border/50 p-2.5">
              <span className="text-white/90 block">Ziel-Channel</span>
              {selectedChannelName ? `# ${selectedChannelName}` : 'Noch nicht ausgewählt'}
            </div>
            <div className="rounded-lg border border-border/50 p-2.5">
              <span className="text-white/90 block">Identitätsquelle</span>
              GuildMemberProfile → letzter Guild-Nickname → Discord-Username → sicherer Text-Fallback
            </div>
          </div>
        </div>
      </Card>

      <div className="flex flex-wrap gap-2">
        <Button onClick={save} disabled={busy !== null}>
          <Save className="h-4 w-4 mr-1" /> {busy === 'save' ? 'Speichert…' : 'Speichern'}
        </Button>
        <Button variant="secondary" onClick={test} disabled={busy !== null}>
          <Send className="h-4 w-4 mr-1" /> {busy === 'test' ? 'Sendet…' : 'Test senden'}
        </Button>
        <Button variant="ghost" onClick={reset} disabled={busy !== null}>
          <RotateCcw className="h-4 w-4 mr-1" /> Zurücksetzen
        </Button>
        <Button variant="ghost" onClick={disable} disabled={busy !== null || !configured}>
          <Power className="h-4 w-4 mr-1" /> {busy === 'disable' ? 'Deaktiviert…' : 'Deaktivieren'}
        </Button>
      </div>
    </div>
  );
}
