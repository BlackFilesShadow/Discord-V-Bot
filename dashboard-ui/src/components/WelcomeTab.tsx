/**
 * Willkommen-System (Guild-Level). Sammel-Page fuer Onboarding neuer Mitglieder:
 * Willkommensnachricht (/welcome), Auto-Rollen (Read-only /autorole) + Selfrole-Hinweis.
 *
 * Backend: GET/POST /api/v2/guilds/:guildId/welcome/config,
 *          POST /api/v2/guilds/:guildId/welcome/test,
 *          POST /api/v2/guilds/:guildId/welcome/disable,
 *          GET  /api/v2/guilds/:guildId/welcome/autoroles
 * Datenhaltung: BotConfig key=`welcome:<guildId>` (welcomeManager) + AutoRole-Model.
 */
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Sparkles, Send, Power, Save, RotateCcw, UserPlus, Shield, AlertTriangle, CheckCircle2, Circle } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Card, CardHeader, CardTitle, CardDesc } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Switch } from '@/components/ui/Switch';
import { StatCard } from '@/components/ui/StatCard';
import { Badge } from '@/components/ui/Badge';
import { useToast } from '@/components/ui/Toast';

interface WelcomeConfig {
  configured: boolean;
  enabled: boolean;
  channelId: string;
  message: string;
  mode: 'text' | 'ai';
  mediaUrl: string | null;
}

interface DiscordChannel { id: string; name: string; type: number; parentId: string | null }

interface AutoRole {
  id: string;
  roleId: string;
  roleName: string;
  triggerType: 'JOIN' | 'REACTION' | 'LEVEL' | 'ACTIVITY' | 'EVENT' | 'GIVEAWAY' | 'CUSTOM';
  triggerValue: string | null;
  isActive: boolean;
  expiresAt: string | null;
  createdAt: string;
}

const TRIGGER_LABELS: Record<AutoRole['triggerType'], string> = {
  JOIN: 'Beitritt', REACTION: 'Reaktion', LEVEL: 'Level',
  ACTIVITY: 'Aktivität', EVENT: 'Event', GIVEAWAY: 'Giveaway', CUSTOM: 'Custom',
};

const VARIABLES: Array<{ key: string; desc: string; example: string }> = [
  { key: '{user}', desc: 'Erwähnung des neuen Mitglieds', example: '@MaxMustermann' },
  { key: '{guild}', desc: 'Name des Servers', example: 'Mein Server' },
  { key: '{count}', desc: 'Aktuelle Mitgliederzahl', example: '128' },
  { key: '{date}', desc: 'Aktuelles Datum', example: '3. April 2026' },
  { key: '{time}', desc: 'Aktuelle Uhrzeit', example: '14:30' },
  { key: '{year}', desc: 'Aktuelles Jahr', example: '2026' },
];

const DEFAULT_MESSAGE = 'Willkommen {user} auf {guild}! 🎉 Du bist Mitglied Nr. {count}.';

function renderPreview(template: string): string {
  const now = new Date();
  const date = new Intl.DateTimeFormat('de-DE', { dateStyle: 'long', timeZone: 'Europe/Berlin' }).format(now);
  const time = new Intl.DateTimeFormat('de-DE', { timeStyle: 'short', timeZone: 'Europe/Berlin' }).format(now);
  return template
    .replace(/\{user\}/g, '@MaxMustermann')
    .replace(/\{guild\}/g, 'Mein Server')
    .replace(/\{count\}/g, '128')
    .replace(/\{member_count\}/g, '128')
    .replace(/\{date\}/g, date)
    .replace(/\{time\}/g, time)
    .replace(/\{year\}/g, String(now.getFullYear()));
}

export function WelcomeTab({ guildId, canManage }: { guildId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();

  const cfgQ = useQuery({
    queryKey: ['welcome', guildId],
    queryFn: () => api.get<WelcomeConfig>(`/api/v2/guilds/${guildId}/welcome/config`),
    enabled: !!guildId,
  });
  const channelsQ = useQuery({
    queryKey: ['guild-channels', guildId],
    queryFn: () => api.get<{ channels: DiscordChannel[] }>(`/api/v2/guilds/${guildId}/channels`),
    enabled: !!guildId && canManage,
  });
  const autorolesQ = useQuery({
    queryKey: ['welcome-autoroles', guildId],
    queryFn: () => api.get<{ autoroles: AutoRole[] }>(`/api/v2/guilds/${guildId}/welcome/autoroles`),
    enabled: !!guildId && canManage,
  });
  const [enabled, setEnabled] = useState(true);
  const [channelId, setChannelId] = useState('');
  const [mode, setMode] = useState<'text' | 'ai'>('text');
  const [message, setMessage] = useState(DEFAULT_MESSAGE);
  const [mediaUrl, setMediaUrl] = useState('');
  const [busy, setBusy] = useState<null | 'save' | 'test' | 'disable'>(null);

  // Server-State in lokale Form-States spiegeln (nur beim Laden / Reload).
  useEffect(() => {
    const d = cfgQ.data;
    if (!d) return;
    setEnabled(d.enabled);
    setChannelId(d.channelId);
    setMode(d.mode);
    setMessage(d.message || DEFAULT_MESSAGE);
    setMediaUrl(d.mediaUrl ?? '');
  }, [cfgQ.data]);

  if (!canManage) {
    return (
      <Card glow>
        <CardHeader><CardTitle>Nicht erlaubt</CardTitle></CardHeader>
        <p className="text-muted text-sm">Nur der Server-Owner oder berechtigte Manager können das Willkommen-System verwalten.</p>
      </Card>
    );
  }

  const channels = channelsQ.data?.channels.filter(c => c.type === 0 || c.type === 5) ?? [];
  const data = cfgQ.data;
  const autoroles = autorolesQ.data?.autoroles ?? [];
  const activeAutoroles = autoroles.filter(a => a.isActive);
  const joinAutoroles = autoroles.filter(a => a.triggerType === 'JOIN');
  const channelName = (id: string) => channels.find(c => c.id === id)?.name ?? '#' + id.slice(-4);

  // Vollstaendigkeit (Sektion E): System gilt nur als einsatzbereit mit Channel + Nachricht.
  const channelSet = !!(data?.configured && data.channelId);
  const messageSet = !!(data?.configured && data.message?.trim());
  const incomplete = !channelSet || !messageSet;
  const autoroleStatus: { label: string; variant: 'ok' | 'warn' | 'neutral' } =
    activeAutoroles.length > 0
      ? { label: 'Aktiv', variant: 'ok' }
      : autoroles.length > 0
        ? { label: 'Konfiguriert (inaktiv)', variant: 'warn' }
        : { label: 'Integration geplant', variant: 'neutral' };

  const buildBody = () => ({ enabled, channelId, message, mode, mediaUrl: mediaUrl.trim() || null });

  async function save() {
    if (!channelId) { toast.error('Bitte einen Channel auswählen.'); return; }
    setBusy('save');
    try {
      await api.post(`/api/v2/guilds/${guildId}/welcome/config`, buildBody());
      await qc.invalidateQueries({ queryKey: ['welcome', guildId] });
      toast.success('Willkommen-Konfiguration gespeichert.');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Speichern fehlgeschlagen.');
    } finally { setBusy(null); }
  }

  async function test() {
    if (!channelId) { toast.error('Bitte einen Channel auswählen.'); return; }
    setBusy('test');
    try {
      await api.post(`/api/v2/guilds/${guildId}/welcome/test`, buildBody());
      toast.success('Testnachricht gesendet.');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Test fehlgeschlagen.');
    } finally { setBusy(null); }
  }

  async function disable() {
    if (!confirm('Willkommen-System wirklich deaktivieren? Die Konfiguration bleibt erhalten.')) return;
    setBusy('disable');
    try {
      await api.post(`/api/v2/guilds/${guildId}/welcome/disable`);
      await qc.invalidateQueries({ queryKey: ['welcome', guildId] });
      toast.success('Willkommen-System deaktiviert.');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Deaktivieren fehlgeschlagen.');
    } finally { setBusy(null); }
  }

  function reset() {
    const d = cfgQ.data;
    setEnabled(d?.enabled ?? true);
    setChannelId(d?.channelId ?? '');
    setMode(d?.mode ?? 'text');
    setMessage(d?.message || DEFAULT_MESSAGE);
    setMediaUrl(d?.mediaUrl ?? '');
  }

  if (cfgQ.isLoading) return <div className="h-40 rounded-xl skeleton" />;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-white inline-flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-accent" /> Willkommen
        </h2>
        <p className="text-xs text-muted mt-0.5">
          Hier verwaltest du alle Funktionen für neue Mitglieder: Willkommensnachricht, Testnachricht,
          Vorschau und automatische Rollen.
        </p>
      </div>

      {/* A. Übersicht */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Willkommen-System" value={data?.enabled ? 'Aktiv' : 'Inaktiv'} accent={data?.enabled ? 'ok' : 'neutral'} />
        <StatCard label="Channel" value={channelSet ? channelName(data!.channelId) : '—'} accent={channelSet ? 'neutral' : 'warn'} />
        <StatCard label="Auto-Rollen" value={autoroleStatus.label} accent={autoroleStatus.variant === 'ok' ? 'ok' : autoroleStatus.variant === 'warn' ? 'warn' : 'neutral'} />
        <StatCard label="Modus" value={data?.configured ? (data.mode === 'ai' ? 'KI' : 'Text') : '—'} />
      </div>

      {/* E. Konfig-Warnung */}
      {incomplete && (
        <Card className="border-warn/40">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="h-5 w-5 text-warn shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-white">Willkommen-System ist noch nicht vollständig konfiguriert.</p>
              <p className="text-xs text-muted mt-0.5">
                {!channelSet && 'Es ist noch kein Channel gesetzt. '}
                {!messageSet && 'Es ist noch keine Nachricht gespeichert. '}
                Setze Channel und Nachricht und speichere, um das System zu aktivieren.
              </p>
            </div>
          </div>
        </Card>
      )}

      {/* A. Modul-Liste */}
      <Card>
        <CardHeader><CardTitle>Onboarding-Module</CardTitle><CardDesc>Alle Funktionen rund um neue Mitglieder.</CardDesc></CardHeader>
        <div className="mt-2 divide-y divide-border/50">
          <div className="flex items-center gap-3 py-2.5">
            <Sparkles className="h-4 w-4 text-accent shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-sm text-white font-medium">Willkommensnachricht</p>
              <p className="text-[11px] text-muted">Ersetzt <code className="font-mono">/welcome</code> · wird über das Dashboard verwaltet</p>
            </div>
            <Badge variant={data?.enabled ? 'ok' : 'neutral'}>{data?.enabled ? 'Aktiv' : 'Inaktiv'}</Badge>
          </div>
          <div className="flex items-center gap-3 py-2.5">
            <UserPlus className="h-4 w-4 text-accent shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-sm text-white font-medium">Auto-Rollen</p>
              <p className="text-[11px] text-muted">Bezogen auf <code className="font-mono">/autorole</code> · unter Willkommen gelistet</p>
            </div>
            <Badge variant={autoroleStatus.variant}>{autoroleStatus.label}</Badge>
          </div>
          <div className="flex items-center gap-3 py-2.5">
            <Shield className="h-4 w-4 text-muted shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-sm text-white font-medium">Selfrole</p>
              <p className="text-[11px] text-muted">Bezogen auf <code className="font-mono">/selfrole</code> · Admin-Command bleibt in Discord</p>
            </div>
            <Badge variant="info">Bleibt Discord</Badge>
          </div>
        </div>
      </Card>

      {/* B. Willkommensnachricht */}
      <Card>
        <CardHeader><CardTitle>Willkommensnachricht</CardTitle><CardDesc>Aktivierung, Channel, Modus und Nachricht.</CardDesc></CardHeader>
        <div className="space-y-4 mt-2">
          <Switch checked={enabled} onChange={setEnabled} label="Willkommen-System aktiviert" />

          <div className="grid sm:grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs text-muted block mb-1">Channel</span>
              <Select value={channelId} onChange={e => setChannelId(e.target.value)}>
                <option value="">— Channel wählen —</option>
                {channels.map(c => <option key={c.id} value={c.id}># {c.name}</option>)}
              </Select>
            </label>
            <label className="block">
              <span className="text-xs text-muted block mb-1">Modus</span>
              <Select value={mode} onChange={e => setMode(e.target.value as 'text' | 'ai')}>
                <option value="text">Text (statisch)</option>
                <option value="ai">KI (generiert)</option>
              </Select>
            </label>
          </div>

          <label className="block">
            <span className="text-xs text-muted block mb-1">
              {mode === 'ai' ? 'KI-Anweisung / Vorgabe' : 'Nachricht'}
            </span>
            <textarea
              value={message}
              onChange={e => setMessage(e.target.value)}
              rows={4}
              maxLength={1000}
              className="input-premium w-full rounded-lg text-white px-3.5 py-2.5 text-sm placeholder:text-muted/80 focus:outline-none resize-y"
              placeholder={DEFAULT_MESSAGE}
            />
            <span className="text-[11px] text-muted">{message.length}/1000 Zeichen</span>
          </label>

          <label className="block">
            <span className="text-xs text-muted block mb-1">Medien-URL (optional)</span>
            <input
              value={mediaUrl}
              onChange={e => setMediaUrl(e.target.value)}
              className="input-premium w-full rounded-lg text-white px-3.5 py-2.5 text-sm placeholder:text-muted/80 focus:outline-none"
              placeholder="https://… (jpg, png, gif, webp, mp4, webm, mov)"
            />
          </label>

          {/* Variablen-Hilfe */}
          <div className="rounded-lg border border-border/60 bg-bg-elev/40 p-3">
            <p className="text-xs font-medium text-white/90 mb-2">Verfügbare Platzhalter</p>
            <div className="grid sm:grid-cols-2 gap-x-4 gap-y-1.5">
              {VARIABLES.map(v => (
                <button
                  key={v.key}
                  type="button"
                  onClick={() => setMessage(m => m + ' ' + v.key)}
                  className="flex items-center gap-2 text-left text-xs hover:bg-bg-elev rounded px-1.5 py-1 transition-colors focus-ring"
                  title="In Nachricht einfügen"
                >
                  <code className="font-mono text-accent shrink-0">{v.key}</code>
                  <span className="text-muted truncate">{v.desc}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </Card>

      {/* D. Vorschau */}
      <Card>
        <CardHeader><CardTitle>Vorschau & Test</CardTitle><CardDesc>Beispielhafte Ersetzung mit Beispieldaten.</CardDesc></CardHeader>
        <div className="mt-2 rounded-lg border border-border/60 bg-bg/60 p-3">
          {mode === 'ai' ? (
            <p className="text-xs text-muted italic">
              Im KI-Modus dient der Text als Anweisung. Die tatsächliche Begrüßung wird beim Beitritt generiert.
              Anweisung-Vorschau: <span className="text-white/90 not-italic">{renderPreview(message)}</span>
            </p>
          ) : (
            <p className="text-sm text-white/90 whitespace-pre-wrap break-words">{renderPreview(message) || '—'}</p>
          )}
        </div>
        <p className="text-[11px] text-muted mt-2">
          Beispielwerte: <code className="font-mono">{'{user}'}</code> → @MaxMustermann ·{' '}
          <code className="font-mono">{'{guild}'}</code> → Mein Server ·{' '}
          <code className="font-mono">{'{count}'}</code> → 128
        </p>
      </Card>

      {/* C. Auto-Rollen */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle>Auto-Rollen</CardTitle>
            <Badge variant={autoroleStatus.variant}>{autoroleStatus.label}</Badge>
          </div>
          <CardDesc>Automatisch vergebene Rollen für neue Mitglieder (Trigger „Beitritt" u. a.).</CardDesc>
        </CardHeader>
        <div className="mt-2 space-y-2">
          {autorolesQ.isLoading && <div className="h-16 rounded-lg skeleton" />}
          {!autorolesQ.isLoading && autoroles.length === 0 && (
            <p className="text-xs text-muted">
              Auto-Rollen werden hier zukünftig verwaltet. Der Discord-Command{' '}
              <code className="font-mono">/autorole</code> bleibt vorerst aktiv. Aktuell sind keine Auto-Rollen konfiguriert.
            </p>
          )}
          {!autorolesQ.isLoading && autoroles.length > 0 && (
            <>
              {joinAutoroles.length > 0 && (
                <p className="text-[11px] text-muted">
                  {joinAutoroles.length} Rolle(n) werden beim Beitritt automatisch vergeben.
                </p>
              )}
              <div className="divide-y divide-border/50">
                {autoroles.map(a => (
                  <div key={a.id} className="flex items-center gap-2.5 py-2">
                    {a.isActive
                      ? <CheckCircle2 className="h-4 w-4 text-ok shrink-0" />
                      : <Circle className="h-4 w-4 text-muted shrink-0" />}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-white truncate">@{a.roleName}</p>
                      <p className="text-[11px] text-muted">
                        Trigger: {TRIGGER_LABELS[a.triggerType]}{a.triggerValue ? ` (${a.triggerValue})` : ''}
                        {a.expiresAt ? ` · befristet bis ${new Date(a.expiresAt).toLocaleDateString('de-DE')}` : ''}
                      </p>
                    </div>
                    <Badge variant={a.isActive ? 'ok' : 'neutral'}>{a.isActive ? 'Aktiv' : 'Inaktiv'}</Badge>
                  </div>
                ))}
              </div>
            </>
          )}
          <p className="text-[11px] text-muted border-t border-border/50 pt-2 mt-1">
            Verwaltung (Erstellen, Löschen, Trigger ändern) erfolgt aktuell über den Discord-Command{' '}
            <code className="font-mono">/autorole</code>. Die vollständige Dashboard-Integration ist geplant.
          </p>
        </div>
      </Card>

      {/* Aktionen */}
      <div className="flex flex-wrap gap-2">
        <Button onClick={save} disabled={busy !== null}>
          <Save className="h-4 w-4 mr-1" /> {busy === 'save' ? 'Speichert…' : 'Speichern'}
        </Button>
        <Button variant="secondary" onClick={test} disabled={busy !== null}>
          <Send className="h-4 w-4 mr-1" /> {busy === 'test' ? 'Sendet…' : 'Testnachricht senden'}
        </Button>
        <Button variant="ghost" onClick={reset} disabled={busy !== null}>
          <RotateCcw className="h-4 w-4 mr-1" /> Zurücksetzen
        </Button>
        {data?.enabled && (
          <Button variant="danger" onClick={disable} disabled={busy !== null} className="ml-auto">
            <Power className="h-4 w-4 mr-1" /> {busy === 'disable' ? 'Deaktiviert…' : 'Deaktivieren'}
          </Button>
        )}
      </div>
    </div>
  );
}
