/**
 * Übersetzungen ("Übersetzungen") — Dashboard-only.
 *
 * Verwaltet geplante / wiederkehrende Auto-Übersetzungs-Posts pro Guild.
 * Ersetzt den früheren Slash-Command /translate-post. Ein Text wird in eine
 * Zielsprache übersetzt und als Embed in einen Channel gepostet — sofort,
 * einmalig geplant oder wiederkehrend. Das Senden übernimmt der Scheduler.
 *
 * Backend: /api/v2/guilds/:guildId/translated-posts
 */
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Languages, Plus, Save, Trash2, Power, X, Clock, Repeat, Zap } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Card, CardHeader, CardTitle, CardDesc } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { useToast } from '@/components/ui/Toast';

type Mode = 'now' | 'once' | 'recurring';

interface ApiLanguage { code: string; name: string; emoji: string }

interface ApiPost {
  id: string;
  channelId: string;
  sourceText: string;
  sourceLang: string;
  targetLang: string;
  customTitle: string | null;
  imageUrl: string | null;
  rolePings: string[];
  mode: Mode;
  scheduledFor: string | null;
  recurrenceCron: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface DiscordChannel { id: string; name: string; type: number; parentId: string | null }
interface DiscordRole { id: string; name: string; color: string; position: number; managed: boolean }

interface PostForm {
  channelId: string;
  sourceText: string;
  sourceLang: string;
  targetLang: string;
  customTitle: string;
  imageUrl: string;
  rolePings: string[];
  mode: Mode;
  scheduledAt: string;
  recurrence: string;
}

const MODE_META: Record<Mode, { label: string; icon: typeof Zap; hint: string }> = {
  now: { label: 'Sofort', icon: Zap, hint: 'Wird unmittelbar gesendet.' },
  once: { label: 'Geplant (einmalig)', icon: Clock, hint: 'Wird einmal zum gewählten Zeitpunkt gesendet.' },
  recurring: { label: 'Wiederkehrend', icon: Repeat, hint: 'Format: HOURLY:MM · DAILY:HH:MM · WEEKLY:DAY:HH:MM · MONTHLY:DD:HH:MM.' },
};

function emptyForm(): PostForm {
  return {
    channelId: '', sourceText: '', sourceLang: 'auto', targetLang: 'de', customTitle: '',
    imageUrl: '', rolePings: [], mode: 'now', scheduledAt: '', recurrence: 'DAILY:12:00',
  };
}

function postToForm(p: ApiPost): PostForm {
  return {
    channelId: p.channelId,
    sourceText: p.sourceText,
    sourceLang: p.sourceLang || 'auto',
    targetLang: p.targetLang,
    customTitle: p.customTitle ?? '',
    imageUrl: p.imageUrl ?? '',
    rolePings: p.rolePings ?? [],
    mode: p.mode,
    scheduledAt: p.scheduledFor ? toLocalInput(p.scheduledFor) : '',
    recurrence: p.recurrenceCron ?? 'DAILY:12:00',
  };
}

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 16);
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
}

export function TranslatedPostsTab({ guildId, canManage }: { guildId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();

  const listQ = useQuery({
    queryKey: ['translated-posts', guildId],
    queryFn: () => api.get<{ posts: ApiPost[] }>(`/api/v2/guilds/${guildId}/translated-posts`),
  });
  const langQ = useQuery({
    queryKey: ['translate-languages', guildId],
    queryFn: () => api.get<{ languages: ApiLanguage[] }>(`/api/v2/guilds/${guildId}/translated-posts/meta/languages`),
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
  const [form, setForm] = useState<PostForm>(emptyForm());
  const [busy, setBusy] = useState(false);

  const posts = listQ.data?.posts ?? [];
  const languages = langQ.data?.languages ?? [];
  const textChannels = (channelsQ.data?.channels ?? []).filter(c => c.type === 0 || c.type === 5);
  const selectableRoles = (rolesQ.data?.roles ?? [])
    .filter(r => r.id !== guildId && !r.managed)
    .sort((a, b) => b.position - a.position);
  const channelNames = useMemo(() => {
    const m: Record<string, string> = {};
    for (const c of channelsQ.data?.channels ?? []) m[c.id] = c.name;
    return m;
  }, [channelsQ.data]);
  const langName = (code: string) => languages.find(l => l.code === code)?.name ?? code;

  function reset() { setEditingId(null); setCreating(false); setForm(emptyForm()); }
  function startCreate() { setCreating(true); setEditingId(null); setForm(emptyForm()); }
  function startEdit(p: ApiPost) { setEditingId(p.id); setCreating(false); setForm(postToForm(p)); }
  function patch(x: Partial<PostForm>) { setForm(f => ({ ...f, ...x })); }

  function toggleRole(id: string) {
    setForm(f => ({
      ...f,
      rolePings: f.rolePings.includes(id) ? f.rolePings.filter(r => r !== id) : [...f.rolePings, id].slice(0, 3),
    }));
  }

  function validate(): string | null {
    if (!/^\d{17,20}$/.test(form.channelId)) return 'Bitte einen Ziel-Channel wählen.';
    if (form.customTitle.trim().length < 1) return 'Titel ist erforderlich.';
    if (form.sourceText.trim().length < 1) return 'Text ist erforderlich.';
    if (form.sourceText.length > 4000) return 'Text max. 4000 Zeichen.';
    if (form.mode === 'once' && !form.scheduledAt) return 'Bitte einen Zeitpunkt wählen.';
    if (form.mode === 'recurring' && !form.recurrence.trim()) return 'Bitte eine Wiederholung angeben.';
    return null;
  }

  function payload(): Record<string, unknown> {
    const base: Record<string, unknown> = {
      channelId: form.channelId,
      sourceText: form.sourceText.trim(),
      sourceLang: form.sourceLang,
      targetLang: form.targetLang,
      customTitle: form.customTitle.trim(),
      imageUrl: form.imageUrl.trim() || null,
      rolePings: form.rolePings,
      mode: form.mode,
    };
    if (form.mode === 'once') base.scheduledAt = new Date(form.scheduledAt).toISOString();
    if (form.mode === 'recurring') base.recurrence = form.recurrence.trim();
    return base;
  }

  async function save() {
    const err = validate();
    if (err) { toast.error(err); return; }
    setBusy(true);
    try {
      if (editingId) {
        await api.put(`/api/v2/guilds/${guildId}/translated-posts/${editingId}`, payload());
      } else {
        const created = await api.post<ApiPost>(`/api/v2/guilds/${guildId}/translated-posts`, payload());
        setEditingId(created.id);
        setCreating(false);
      }
      await qc.invalidateQueries({ queryKey: ['translated-posts', guildId] });
      toast.success(form.mode === 'now' ? 'Übersetzung wird gesendet.' : 'Übersetzung gespeichert.');
      if (form.mode === 'now') reset();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Speichern fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }

  async function toggle(p: ApiPost) {
    setBusy(true);
    try {
      await api.post(`/api/v2/guilds/${guildId}/translated-posts/${p.id}/toggle`, { isActive: !p.isActive });
      await qc.invalidateQueries({ queryKey: ['translated-posts', guildId] });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Aktion fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(p: ApiPost) {
    if (!confirm('Diese Übersetzung wirklich löschen?')) return;
    setBusy(true);
    try {
      await api.del(`/api/v2/guilds/${guildId}/translated-posts/${p.id}`);
      await qc.invalidateQueries({ queryKey: ['translated-posts', guildId] });
      if (editingId === p.id) reset();
      toast.success('Übersetzung gelöscht.');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Löschen fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }

  if (!canManage) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Übersetzungen</CardTitle>
          <CardDesc>Du hast keine Berechtigung, Übersetzungen zu verwalten (benötigt <code>translate.manage</code>).</CardDesc>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2"><Languages size={18} /> Übersetzungen</CardTitle>
              <CardDesc>Texte automatisch übersetzen und als Embed posten — sofort, geplant oder wiederkehrend.</CardDesc>
            </div>
            <Button size="sm" onClick={startCreate} disabled={busy}><Plus size={16} /> Neu</Button>
          </div>
        </CardHeader>
        <div className="px-4 pb-4 space-y-2">
          {listQ.isLoading && <p className="text-muted text-sm">Lade…</p>}
          {posts.length === 0 && !listQ.isLoading && <p className="text-muted text-sm">Noch keine Übersetzungen.</p>}
          {posts.map(p => {
            const Icon = MODE_META[p.mode].icon;
            return (
              <div key={p.id} className={`flex items-center justify-between gap-2 rounded-md border px-3 py-2 ${editingId === p.id ? 'border-brand' : 'border-border'}`}>
                <button className="flex-1 text-left min-w-0" onClick={() => startEdit(p)}>
                  <div className="flex items-center gap-2">
                    <Icon size={15} className="text-muted shrink-0" />
                    <span className="text-white text-sm font-medium truncate">{p.customTitle || p.sourceText.slice(0, 40)}</span>
                    <Badge>{langName(p.sourceLang)} → {langName(p.targetLang)}</Badge>
                    {p.isActive ? <Badge variant="ok">Aktiv</Badge> : <Badge variant="neutral">Pausiert</Badge>}
                  </div>
                  <div className="text-muted text-xs mt-0.5 truncate">
                    #{channelNames[p.channelId] ?? p.channelId} · {MODE_META[p.mode].label}
                    {p.mode !== 'now' && ` · nächster Lauf: ${fmtDate(p.nextRunAt)}`}
                    {p.rolePings.length > 0 && ` · ${p.rolePings.length} Ping-Rolle(n)`}
                  </div>
                </button>
                <div className="flex items-center gap-1 shrink-0">
                  {p.mode !== 'now' && (
                    <Button size="sm" variant="ghost" title={p.isActive ? 'Pausieren' : 'Aktivieren'} onClick={() => toggle(p)} disabled={busy}><Power size={15} /></Button>
                  )}
                  <Button size="sm" variant="ghost" title="Löschen" onClick={() => remove(p)} disabled={busy}><Trash2 size={15} /></Button>
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
              <CardTitle>{editingId ? 'Übersetzung bearbeiten' : 'Neue Übersetzung'}</CardTitle>
              <Button size="sm" variant="ghost" onClick={reset}><X size={16} /></Button>
            </div>
          </CardHeader>
          <div className="px-4 pb-4 space-y-3">
            <Field label="Titel">
              <Input value={form.customTitle} maxLength={200} onChange={e => patch({ customTitle: e.target.value })} placeholder="Embed-Titel" />
            </Field>
            <Field label="Text (Quelle)">
              <textarea
                className="w-full min-h-[100px] rounded-md border border-border bg-bg-elev px-3 py-2 text-sm text-white placeholder:text-muted focus-ring resize-y"
                value={form.sourceText}
                maxLength={4000}
                onChange={e => patch({ sourceText: e.target.value })}
                placeholder="Zu übersetzender Text…"
              />
              <p className="text-muted text-xs mt-1">{form.sourceText.length}/4000</p>
            </Field>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Quellsprache">
                <Select value={form.sourceLang} onChange={e => patch({ sourceLang: e.target.value })}>
                  <option value="auto">Automatisch</option>
                  {languages.map(l => <option key={l.code} value={l.code}>{l.emoji} {l.name}</option>)}
                </Select>
              </Field>
              <Field label="Zielsprache">
                <Select value={form.targetLang} onChange={e => patch({ targetLang: e.target.value })}>
                  {languages.map(l => <option key={l.code} value={l.code}>{l.emoji} {l.name}</option>)}
                </Select>
              </Field>
              <Field label="Ziel-Channel">
                <Select value={form.channelId} onChange={e => patch({ channelId: e.target.value })}>
                  <option value="">— wählen —</option>
                  {textChannels.map(c => <option key={c.id} value={c.id}>#{c.name}</option>)}
                </Select>
              </Field>
            </div>
            <Field label="Bild-URL (optional)">
              <Input value={form.imageUrl} onChange={e => patch({ imageUrl: e.target.value })} placeholder="https://…" />
            </Field>

            <Field label="Zeitplan">
              <div className="flex gap-2">
                {(Object.keys(MODE_META) as Mode[]).map(m => {
                  const M = MODE_META[m];
                  const MIcon = M.icon;
                  return (
                    <button
                      key={m}
                      onClick={() => patch({ mode: m })}
                      className={`flex-1 text-xs rounded-md border px-3 py-2 flex items-center justify-center gap-1.5 transition-colors ${form.mode === m ? 'border-brand bg-brand/20 text-white' : 'border-border text-muted hover:text-white'}`}
                    >
                      <MIcon size={14} /> {M.label}
                    </button>
                  );
                })}
              </div>
              <p className="text-muted text-xs mt-1">{MODE_META[form.mode].hint}</p>
            </Field>
            {form.mode === 'once' && (
              <Field label="Zeitpunkt">
                <Input type="datetime-local" value={form.scheduledAt} onChange={e => patch({ scheduledAt: e.target.value })} />
              </Field>
            )}
            {form.mode === 'recurring' && (
              <Field label="Wiederholung">
                <Input value={form.recurrence} onChange={e => patch({ recurrence: e.target.value })} placeholder="DAILY:12:00" />
              </Field>
            )}

            <Field label="Ping-Rollen (optional, max. 3)">
              <div className="flex flex-wrap gap-1.5 max-h-32 overflow-auto rounded-md border border-border p-2">
                {selectableRoles.length === 0 && <span className="text-muted text-xs">Keine Rollen verfügbar.</span>}
                {selectableRoles.map(r => (
                  <button
                    key={r.id}
                    onClick={() => toggleRole(r.id)}
                    className={`text-xs rounded px-2 py-1 border transition-colors ${form.rolePings.includes(r.id) ? 'border-brand bg-brand/20 text-white' : 'border-border text-muted hover:text-white'}`}
                  >
                    @{r.name}
                  </button>
                ))}
              </div>
            </Field>

            <div className="flex gap-2 pt-2 border-t border-border">
              <Button onClick={save} disabled={busy}><Save size={16} /> {form.mode === 'now' ? 'Senden' : 'Speichern'}</Button>
            </div>
          </div>
        </Card>
      )}
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
