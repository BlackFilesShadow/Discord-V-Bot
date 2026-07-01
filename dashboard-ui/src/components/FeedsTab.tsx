/**
 * Feeds ("Feeds") — Dashboard-only.
 *
 * Verwaltet Live-Feeds (RSS, News, Twitch, Steam, YouTube, Webhook) pro Guild.
 * Ersetzt den früheren Slash-Command /feed. News-Feeds werden automatisch ins
 * Deutsche übersetzt. Neue Feeds/Streams werden im Ziel-Channel als Embed
 * gepostet (Name + Channel-Link + Quell-URL), optional mit Rollen-Ping.
 *
 * Backend: /api/v2/guilds/:guildId/feeds
 */
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Rss, Plus, Save, Trash2, Power, PlayCircle, X, Radio, Youtube, Gamepad2, Newspaper, Webhook, Copy, RefreshCw,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Card, CardHeader, CardTitle, CardDesc } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Switch } from '@/components/ui/Switch';
import { Badge } from '@/components/ui/Badge';
import { useToast } from '@/components/ui/Toast';

type FeedType = 'RSS' | 'NEWS' | 'TWITCH' | 'STEAM' | 'YOUTUBE' | 'WEBHOOK';

interface ApiFeed {
  id: string;
  name: string;
  feedType: FeedType;
  url: string;
  channelId: string;
  interval: number;
  lastChecked: string | null;
  isActive: boolean;
  mentionRoles: string[];
  hasWebhookSecret: boolean;
  createdAt: string;
  updatedAt: string;
}

interface DiscordChannel { id: string; name: string; type: number; parentId: string | null }
interface DiscordRole { id: string; name: string; color: string; position: number; managed: boolean }

interface FeedForm {
  name: string;
  feedType: FeedType;
  url: string;
  channelId: string;
  interval: string;
  mentionRoles: string[];
  pingEnabled: boolean;
}

const FEED_META: Record<FeedType, { label: string; icon: typeof Rss; hint: string; placeholder: string }> = {
  RSS: { label: 'RSS-Feed', icon: Rss, hint: 'RSS-, Atom-, XML- oder JSON-Feed-URL.', placeholder: 'https://example.com/feed.xml' },
  NEWS: { label: 'News (→ Deutsch)', icon: Newspaper, hint: 'Beliebige oeffentliche News-/Webseiten-URL — Titel/Text werden ins Deutsche uebersetzt.', placeholder: 'https://example.com/news' },
  TWITCH: { label: 'Twitch-Stream', icon: Radio, hint: 'Twitch-Kanal-URL (technische Grundlage ist die URL).', placeholder: 'https://twitch.tv/name' },
  STEAM: { label: 'Steam-News', icon: Gamepad2, hint: 'Steam Store-, Community- oder News-URL.', placeholder: 'https://store.steampowered.com/app/730' },
  YOUTUBE: { label: 'YouTube', icon: Youtube, hint: 'YouTube Kanal-, Handle- oder Playlist-URL.', placeholder: 'https://youtube.com/@name' },
  WEBHOOK: { label: 'Webhook (eingehend)', icon: Webhook, hint: 'Frei wählbares Label — liefert eine signierte Webhook-URL.', placeholder: 'z. B. Externes System' },
};

function emptyForm(): FeedForm {
  return { name: '', feedType: 'RSS', url: '', channelId: '', interval: '300', mentionRoles: [], pingEnabled: false };
}

function feedToForm(f: ApiFeed): FeedForm {
  return {
    name: f.name, feedType: f.feedType, url: f.url, channelId: f.channelId,
    interval: String(f.interval), mentionRoles: f.mentionRoles ?? [], pingEnabled: (f.mentionRoles?.length ?? 0) > 0,
  };
}

export function FeedsTab({ guildId, canManage }: { guildId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();

  const listQ = useQuery({
    queryKey: ['feeds', guildId],
    queryFn: () => api.get<{ feeds: ApiFeed[] }>(`/api/v2/guilds/${guildId}/feeds`),
  });
  const channelsQ = useQuery({
    queryKey: ['guild-channels', guildId],
    queryFn: () => api.get<{ channels: DiscordChannel[] }>(`/api/v2/guilds/${guildId}/channels`),
  });
  const rolesQ = useQuery({
    queryKey: ['guild-roles', guildId],
    queryFn: () => api.get<{ roles: DiscordRole[] }>(`/api/v2/guilds/${guildId}/roles`),
  });

  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<FeedForm>(emptyForm());
  const [busy, setBusy] = useState(false);
  const [webhookInfo, setWebhookInfo] = useState<{ url: string; secret: string } | null>(null);

  const feeds = listQ.data?.feeds ?? [];
  const textChannels = (channelsQ.data?.channels ?? []).filter(c => c.type === 0 || c.type === 5);
  // Alle pingbaren Rollen ausnahmslos anzeigen (nur @everyone ausgenommen).
  const selectableRoles = (rolesQ.data?.roles ?? [])
    .filter(r => r.id !== guildId)
    .sort((a, b) => b.position - a.position);
  const channelNames = useMemo(() => {
    const m: Record<string, string> = {};
    for (const c of channelsQ.data?.channels ?? []) m[c.id] = c.name;
    return m;
  }, [channelsQ.data]);
  const roleName = (id: string) => selectableRoles.find(r => r.id === id)?.name ?? id;

  function reset() { setEditingId(null); setCreating(false); setForm(emptyForm()); setWebhookInfo(null); }
  function startCreate() { setCreating(true); setEditingId(null); setForm(emptyForm()); setWebhookInfo(null); }
  function startEdit(f: ApiFeed) { setEditingId(f.id); setCreating(false); setForm(feedToForm(f)); setWebhookInfo(null); }
  function patch(p: Partial<FeedForm>) { setForm(f => ({ ...f, ...p })); }

  function toggleRole(id: string) {
    setForm(f => ({
      ...f,
      mentionRoles: f.mentionRoles.includes(id) ? f.mentionRoles.filter(r => r !== id) : [...f.mentionRoles, id].slice(0, 20),
    }));
  }

  function validate(): string | null {
    if (form.feedType !== 'NEWS' && form.name.trim().length < 1) return 'Name ist erforderlich.';
    if (!/^\d{17,20}$/.test(form.channelId)) return 'Bitte einen Ziel-Channel wählen.';
    if (form.feedType !== 'WEBHOOK' && form.url.trim().length < 1) return 'Feed URL ist erforderlich.';
    const iv = Number(form.interval);
    if (!Number.isInteger(iv) || iv < 60 || iv > 86400) return 'Intervall muss 60..86400 Sekunden sein.';
    return null;
  }

  function payload(): Record<string, unknown> {
    return {
      name: form.name.trim(),
      feedType: form.feedType,
      url: form.feedType === 'WEBHOOK' ? (form.url.trim() || form.name.trim()) : form.url.trim(),
      channelId: form.channelId,
      interval: Number(form.interval),
      // Rollen-Ping optional: nur senden, wenn aktiviert.
      mentionRoles: form.pingEnabled ? form.mentionRoles : [],
    };
  }

  async function save() {
    const err = validate();
    if (err) { toast.error(err); return; }
    setBusy(true);
    try {
      if (editingId) {
        await api.put(`/api/v2/guilds/${guildId}/feeds/${editingId}`, payload());
      } else {
        const created = await api.post<ApiFeed>(`/api/v2/guilds/${guildId}/feeds`, payload());
        setEditingId(created.id);
        setCreating(false);
        if (created.feedType === 'WEBHOOK') await loadWebhook(created.id);
      }
      await qc.invalidateQueries({ queryKey: ['feeds', guildId] });
      toast.success('Feed gespeichert.');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Speichern fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }

  async function toggle(f: ApiFeed) {
    setBusy(true);
    try {
      await api.post(`/api/v2/guilds/${guildId}/feeds/${f.id}/toggle`, { isActive: !f.isActive });
      await qc.invalidateQueries({ queryKey: ['feeds', guildId] });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Aktion fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }

  async function testNow(f: ApiFeed) {
    setBusy(true);
    try {
      await api.post(`/api/v2/guilds/${guildId}/feeds/${f.id}/test`, {});
      toast.success('Feed wurde jetzt geprüft.');
      await qc.invalidateQueries({ queryKey: ['feeds', guildId] });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Prüfung fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(f: ApiFeed) {
    if (!confirm(`Feed „${f.name}" wirklich löschen?`)) return;
    setBusy(true);
    try {
      await api.del(`/api/v2/guilds/${guildId}/feeds/${f.id}`);
      await qc.invalidateQueries({ queryKey: ['feeds', guildId] });
      if (editingId === f.id) reset();
      toast.success('Feed gelöscht.');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Löschen fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }

  async function loadWebhook(id: string) {
    try {
      const r = await api.get<{ webhookUrl: string; secret: string }>(`/api/v2/guilds/${guildId}/feeds/${id}/webhook`);
      setWebhookInfo({ url: r.webhookUrl, secret: r.secret });
    } catch { /* ignore */ }
  }

  async function rotateWebhook(id: string) {
    setBusy(true);
    try {
      const r = await api.post<{ secret: string }>(`/api/v2/guilds/${guildId}/feeds/${id}/webhook/rotate`, {});
      setWebhookInfo(w => (w ? { ...w, secret: r.secret } : w));
      toast.success('Neues Webhook-Secret erzeugt.');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Rotation fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }

  if (!canManage) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Feeds</CardTitle>
          <CardDesc>Du hast keine Berechtigung, Feeds zu verwalten (benötigt <code>feeds.manage</code>).</CardDesc>
        </CardHeader>
      </Card>
    );
  }

  const meta = FEED_META[form.feedType];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2"><Rss size={18} /> Feeds</CardTitle>
              <CardDesc>Live-Feeds aus RSS, News, Twitch, Steam, YouTube oder eingehenden Webhooks. News werden automatisch ins Deutsche übersetzt.</CardDesc>
            </div>
            <Button size="sm" onClick={startCreate} disabled={busy}><Plus size={16} /> Neu</Button>
          </div>
        </CardHeader>
        <div className="px-4 pb-4 space-y-2">
          {listQ.isLoading && <p className="text-muted text-sm">Lade…</p>}
          {feeds.length === 0 && !listQ.isLoading && <p className="text-muted text-sm">Noch keine Feeds.</p>}
          {feeds.map(f => {
            const Icon = FEED_META[f.feedType].icon;
            return (
              <div key={f.id} className={`flex items-center justify-between gap-2 rounded-md border px-3 py-2 ${editingId === f.id ? 'border-brand' : 'border-border'}`}>
                <button className="flex-1 text-left min-w-0" onClick={() => startEdit(f)}>
                  <div className="flex items-center gap-2">
                    <Icon size={15} className="text-muted shrink-0" />
                    <span className="text-white text-sm font-medium truncate">{f.name}</span>
                    <Badge>{FEED_META[f.feedType].label}</Badge>
                    {f.isActive ? <Badge variant="ok">Aktiv</Badge> : <Badge variant="neutral">Pausiert</Badge>}
                  </div>
                  <div className="text-muted text-xs mt-0.5 truncate">
                    #{channelNames[f.channelId] ?? f.channelId} · alle {f.interval}s
                    {f.mentionRoles.length > 0 && ` · ${f.mentionRoles.length} Ping-Rolle(n)`}
                  </div>
                </button>
                <div className="flex items-center gap-1 shrink-0">
                  <Button size="sm" variant="ghost" title="Jetzt prüfen" onClick={() => testNow(f)} disabled={busy}><PlayCircle size={15} /></Button>
                  <Button size="sm" variant="ghost" title={f.isActive ? 'Pausieren' : 'Aktivieren'} onClick={() => toggle(f)} disabled={busy}><Power size={15} /></Button>
                  <Button size="sm" variant="ghost" title="Löschen" onClick={() => remove(f)} disabled={busy}><Trash2 size={15} /></Button>
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {(creating || editingId) && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between w-full">
              <CardTitle>{editingId ? 'Feed bearbeiten' : 'Neuer Feed'}</CardTitle>
              <Button size="sm" variant="ghost" onClick={reset}><X size={16} /></Button>
            </div>
          </CardHeader>
          <div className="px-4 pb-4 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Name (optional bei News)">
                <Input value={form.name} maxLength={100} onChange={e => patch({ name: e.target.value })} placeholder="Anzeigename (nur Darstellung)" />
              </Field>
              <Field label="Typ">
                <Select value={form.feedType} onChange={e => patch({ feedType: e.target.value as FeedType, url: '' })}>
                  {(Object.keys(FEED_META) as FeedType[]).map(t => <option key={t} value={t}>{FEED_META[t].label}</option>)}
                </Select>
              </Field>
            </div>
            {form.feedType !== 'WEBHOOK' && (
              <Field label="Feed URL">
                <Input value={form.url} onChange={e => patch({ url: e.target.value })} placeholder={meta.placeholder} />
                <p className="text-muted text-xs mt-1">{meta.hint}</p>
              </Field>
            )}
            {form.feedType === 'WEBHOOK' && (
              <Field label="Label (optional)">
                <Input value={form.url} onChange={e => patch({ url: e.target.value })} placeholder={meta.placeholder} />
                <p className="text-muted text-xs mt-1">{meta.hint}</p>
              </Field>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Ziel-Channel">
                <Select value={form.channelId} onChange={e => patch({ channelId: e.target.value })}>
                  <option value="">— wählen —</option>
                  {textChannels.map(c => <option key={c.id} value={c.id}>#{c.name}</option>)}
                </Select>
              </Field>
              <Field label="Prüf-Intervall (Sekunden)">
                <Input type="number" min={60} max={86400} value={form.interval} onChange={e => patch({ interval: e.target.value })} />
              </Field>
            </div>

            <Field label="Rollen-Ping">
              <div className="mb-2">
                <Switch checked={form.pingEnabled} onChange={v => patch({ pingEnabled: v })} label="Rollen-Ping aktivieren" />
              </div>
              {form.pingEnabled && (
                <>
                  <div className="flex flex-wrap gap-1.5 max-h-32 overflow-auto rounded-md border border-border p-2">
                    {selectableRoles.length === 0 && <span className="text-muted text-xs">Keine Rollen verfügbar.</span>}
                    {selectableRoles.map(r => (
                      <button
                        key={r.id}
                        onClick={() => toggleRole(r.id)}
                        className={`text-xs rounded px-2 py-1 border transition-colors ${form.mentionRoles.includes(r.id) ? 'border-brand bg-brand/20 text-white' : 'border-border text-muted hover:text-white'}`}
                      >
                        @{r.name}
                      </button>
                    ))}
                  </div>
                  {form.mentionRoles.length > 0 && (
                    <p className="text-muted text-xs mt-1">Ping: {form.mentionRoles.map(roleName).map(n => `@${n}`).join(', ')}</p>
                  )}
                </>
              )}
            </Field>

            {webhookInfo && (
              <div className="rounded-md border border-border bg-bg-elev p-3 space-y-2">
                <div className="flex items-center gap-2 text-white text-sm font-medium"><Webhook size={15} /> Webhook-Zugang</div>
                <CopyRow label="URL" value={webhookInfo.url} toast={toast} />
                <CopyRow label="Secret" value={webhookInfo.secret} toast={toast} mono />
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="secondary" onClick={() => editingId && rotateWebhook(editingId)} disabled={busy}><RefreshCw size={14} /> Secret rotieren</Button>
                  <span className="text-muted text-xs">HMAC-SHA256 über Roh-Body im Header <code>X-Signature</code>.</span>
                </div>
              </div>
            )}
            {editingId && form.feedType === 'WEBHOOK' && !webhookInfo && (
              <Button size="sm" variant="secondary" onClick={() => loadWebhook(editingId)}><Webhook size={14} /> Webhook-Zugang anzeigen</Button>
            )}

            <div className="flex gap-2 pt-2 border-t border-border">
              <Button onClick={save} disabled={busy}><Save size={16} /> Speichern</Button>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}

function CopyRow({ label, value, toast, mono }: { label: string; value: string; toast: ReturnType<typeof useToast>; mono?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted text-xs w-12 shrink-0">{label}</span>
      <code className={`flex-1 truncate text-xs text-white/90 ${mono ? 'font-mono' : ''}`}>{value}</code>
      <button
        className="text-muted hover:text-white"
        title="Kopieren"
        onClick={() => { void navigator.clipboard.writeText(value); toast.success(`${label} kopiert.`); }}
      >
        <Copy size={14} />
      </button>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-muted text-xs mb-1 block">{label}</span>
      {children}
    </label>
  );
}
