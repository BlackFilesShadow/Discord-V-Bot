import { useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Languages, Plus, Save, Trash2, Power, X, Clock, Repeat, Zap } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Card, CardHeader, CardTitle, CardDesc } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { useToast } from '@/components/ui/Toast';
import { TranslationImageField } from './TranslationImageField';

type Mode = 'now' | 'once' | 'recurring';
type Lang = { code: string; name: string; emoji: string };
type Post = {
  id: string;
  channelId: string;
  sourceText: string;
  sourceLang: string;
  targetLang: string;
  customTitle: string | null;
  imageUrl: string | null;
  hasImage?: boolean;
  rolePings: string[];
  mode: Mode;
  scheduledFor: string | null;
  recurrenceCron: string | null;
  nextRunAt: string | null;
  isActive: boolean;
};
type Channel = { id: string; name: string; type: number; parentId: string | null };
type Role = { id: string; name: string; color: string; position: number; managed: boolean };
type Form = {
  channelId: string;
  sourceText: string;
  sourceLang: string;
  targetLang: string;
  customTitle: string;
  rolePings: string[];
  mode: Mode;
  scheduledAt: string;
  recurrence: string;
  imageFile: File | null;
  hasExistingImage: boolean;
  removeImage: boolean;
};

const MODES: Record<Mode, { label: string; icon: typeof Zap; hint: string }> = {
  now: { label: 'Sofort', icon: Zap, hint: 'Wird unmittelbar gesendet.' },
  once: { label: 'Geplant (einmalig)', icon: Clock, hint: 'Wird einmal zum gewählten Zeitpunkt gesendet.' },
  recurring: { label: 'Wiederkehrend', icon: Repeat, hint: 'Format: HOURLY:MM · DAILY:HH:MM · WEEKLY:DAY:HH:MM · MONTHLY:DD:HH:MM.' },
};
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const IMAGE_MAX = 10 * 1024 * 1024;
const blank = (): Form => ({
  channelId: '',
  sourceText: '',
  sourceLang: 'auto',
  targetLang: 'de',
  customTitle: '',
  rolePings: [],
  mode: 'now',
  scheduledAt: '',
  recurrence: 'DAILY:12:00',
  imageFile: null,
  hasExistingImage: false,
  removeImage: false,
});
const localTime = (iso: string) => {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const toForm = (p: Post): Form => ({
  channelId: p.channelId,
  sourceText: p.sourceText,
  sourceLang: p.sourceLang || 'auto',
  targetLang: p.targetLang,
  customTitle: p.customTitle ?? '',
  rolePings: p.rolePings ?? [],
  mode: p.mode,
  scheduledAt: p.scheduledFor ? localTime(p.scheduledFor) : '',
  recurrence: p.recurrenceCron ?? 'DAILY:12:00',
  imageFile: null,
  hasExistingImage: p.hasImage ?? Boolean(p.imageUrl),
  removeImage: false,
});

function readableSchedule(post: Post): string {
  if (post.mode === 'now') return 'Sofort';
  if (post.mode === 'once') return post.scheduledFor ? `Einmalig · ${new Date(post.scheduledFor).toLocaleString()}` : 'Einmalig';
  return post.recurrenceCron ? `Wiederkehrend · ${post.recurrenceCron}` : 'Wiederkehrend';
}

function TranslationViewer({
  posts,
  languages,
  isLoading,
  error,
}: {
  posts: Post[];
  languages: Lang[];
  isLoading: boolean;
  error: Error | null;
}) {
  const langName = (code: string) => languages.find(l => l.code === code)?.name ?? code;

  if (isLoading) return <div className="h-40 rounded-xl skeleton" />;
  if (error) {
    return (
      <Card glow>
        <CardHeader><CardTitle>Nicht erlaubt</CardTitle></CardHeader>
        <p className="text-muted text-sm">Übersetzungen konnten nicht gelesen werden.</p>
        <p className="text-danger text-xs mt-2 break-words">{error.message}</p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-white">Übersetzungen</h2>
        <p className="text-xs text-muted mt-1">
          Nur-Lesezugriff: bestehende Übersetzungs-Posts sind sichtbar, Änderungen benötigen <code>translate.manage</code>.
        </p>
      </div>

      {posts.length === 0 && (
        <Card><p className="text-muted text-sm">Noch keine Übersetzungs-Posts vorhanden.</p></Card>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {posts.map(post => {
          const Icon = MODES[post.mode].icon;
          return (
            <Card key={post.id} className="min-w-0">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="font-semibold text-white break-words">{post.customTitle || 'Ohne Titel'}</h3>
                  <p className="text-xs text-muted mt-1 break-words">{langName(post.sourceLang)} → {langName(post.targetLang)}</p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Badge>{MODES[post.mode].label}</Badge>
                  {post.isActive ? <Badge variant="ok">Aktiv</Badge> : <Badge variant="neutral">Pausiert</Badge>}
                  {(post.hasImage ?? Boolean(post.imageUrl)) && <Badge>Bild</Badge>}
                </div>
              </div>

              <div className="mt-3 space-y-2 text-sm">
                <div className="rounded-md border border-border/70 bg-bg-elev/40 p-2.5 min-w-0">
                  <p className="text-xs text-muted mb-1">Quelle</p>
                  <p className="text-white/90 whitespace-pre-wrap break-words">{post.sourceText || '—'}</p>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="rounded-md border border-border/70 bg-bg-elev/40 p-2.5 min-w-0">
                    <p className="text-xs text-muted mb-1">Ziel-Channel</p>
                    <p className="text-white break-all">{post.channelId}</p>
                  </div>
                  <div className="rounded-md border border-border/70 bg-bg-elev/40 p-2.5 min-w-0">
                    <p className="text-xs text-muted mb-1">Zeitplan</p>
                    <p className="text-white break-words inline-flex items-center gap-1.5"><Icon size={14} />{readableSchedule(post)}</p>
                  </div>
                </div>
                <p className="text-xs text-muted break-words">
                  {post.rolePings.length} Ping-Rolle(n){post.nextRunAt ? ` · nächste Ausführung ${new Date(post.nextRunAt).toLocaleString()}` : ''}
                </p>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

export function TranslatedPostsTab({ guildId, canManage }: { guildId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const postsQ = useQuery({
    queryKey: ['translated-posts', guildId],
    queryFn: () => api.get<{ posts: Post[] }>(`/api/v2/guilds/${guildId}/translated-posts`),
    enabled: !!guildId,
    retry: false,
  });
  const langQ = useQuery({
    queryKey: ['translate-languages', guildId],
    queryFn: () => api.get<{ languages: Lang[] }>(`/api/v2/guilds/${guildId}/translated-posts/meta/languages`),
    enabled: !!guildId,
    retry: false,
  });
  const channelsQ = useQuery({
    queryKey: ['guild-channels', guildId],
    queryFn: () => api.get<{ channels: Channel[] }>(`/api/v2/guilds/${guildId}/channels`),
    enabled: !!guildId && canManage,
  });
  const rolesQ = useQuery({
    queryKey: ['guild-roles', guildId],
    queryFn: () => api.get<{ roles: Role[] }>(`/api/v2/guilds/${guildId}/roles`),
    enabled: !!guildId && canManage,
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<Form>(blank());
  const [busy, setBusy] = useState(false);
  const busyLock = useRef(false);

  const posts = postsQ.data?.posts ?? [];
  const languages = langQ.data?.languages ?? [];
  const channels = (channelsQ.data?.channels ?? []).filter(c => c.type === 0 || c.type === 5);
  const roles = (rolesQ.data?.roles ?? []).filter(r => r.id !== guildId && !r.managed).sort((a, b) => b.position - a.position);
  const channelNames = useMemo(() => Object.fromEntries((channelsQ.data?.channels ?? []).map(c => [c.id, c.name])), [channelsQ.data]);
  const langName = (code: string) => languages.find(l => l.code === code)?.name ?? code;
  const patch = (x: Partial<Form>) => setForm(f => ({ ...f, ...x }));
  const reset = () => { setEditingId(null); setCreating(false); setForm(blank()); };
  const toggleRole = (id: string) => setForm(f => ({ ...f, rolePings: f.rolePings.includes(id) ? f.rolePings.filter(r => r !== id) : [...f.rolePings, id].slice(0, 3) }));
  const chooseImage = (file: File | null) => {
    if (!file) return patch({ imageFile: null });
    if (!IMAGE_TYPES.has(file.type)) return toast.error('Nur PNG, JPEG, GIF oder WebP sind erlaubt.');
    if (file.size > IMAGE_MAX) return toast.error('Bild darf maximal 10 MiB groß sein.');
    patch({ imageFile: file, removeImage: false });
  };
  const body = () => {
    const fd = new FormData();
    [['channelId', form.channelId], ['sourceText', form.sourceText.trim()], ['sourceLang', form.sourceLang], ['targetLang', form.targetLang], ['customTitle', form.customTitle.trim()], ['rolePings', JSON.stringify(form.rolePings)], ['mode', form.mode]].forEach(([k, v]) => fd.append(k, v));
    if (form.mode === 'once') fd.append('scheduledAt', new Date(form.scheduledAt).toISOString());
    if (form.mode === 'recurring') fd.append('recurrence', form.recurrence.trim());
    if (form.imageFile) fd.append('image', form.imageFile, form.imageFile.name);
    else if (form.removeImage) fd.append('removeImage', 'true');
    return fd;
  };
  const save = async () => {
    if (busyLock.current) return;
    if (!/^\d{17,20}$/.test(form.channelId)) return toast.error('Bitte einen Ziel-Channel wählen.');
    if (!form.customTitle.trim()) return toast.error('Titel ist erforderlich.');
    if (!form.sourceText.trim()) return toast.error('Text ist erforderlich.');
    if (form.mode === 'once' && !form.scheduledAt) return toast.error('Bitte einen Zeitpunkt wählen.');
    busyLock.current = true;
    setBusy(true);
    try {
      const saved = editingId
        ? await api.form<Post>('PUT', `/api/v2/guilds/${guildId}/translated-posts/${editingId}`, body())
        : await api.form<Post>('POST', `/api/v2/guilds/${guildId}/translated-posts`, body());
      await qc.invalidateQueries({ queryKey: ['translated-posts', guildId] });
      toast.success(form.mode === 'now' ? 'Übersetzung wird gesendet.' : 'Übersetzung gespeichert.');
      if (form.mode === 'now') reset();
      else { setEditingId(saved.id); setCreating(false); setForm(toForm(saved)); }
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Speichern fehlgeschlagen.');
    } finally {
      busyLock.current = false;
      setBusy(false);
    }
  };
  const remove = async (p: Post) => {
    if (!confirm('Diese Übersetzung wirklich löschen?')) return;
    if (busyLock.current) return;
    busyLock.current = true;
    setBusy(true);
    try {
      await api.del(`/api/v2/guilds/${guildId}/translated-posts/${p.id}`);
      await qc.invalidateQueries({ queryKey: ['translated-posts', guildId] });
      if (editingId === p.id) reset();
      toast.success('Übersetzung gelöscht.');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Löschen fehlgeschlagen.');
    } finally {
      busyLock.current = false;
      setBusy(false);
    }
  };
  const toggle = async (p: Post) => {
    if (busyLock.current) return;
    busyLock.current = true;
    setBusy(true);
    try {
      await api.post(`/api/v2/guilds/${guildId}/translated-posts/${p.id}/toggle`, { isActive: !p.isActive });
      await qc.invalidateQueries({ queryKey: ['translated-posts', guildId] });
      toast.success(p.isActive ? 'Übersetzung deaktiviert.' : 'Übersetzung aktiviert.');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Statusänderung fehlgeschlagen.');
    } finally {
      busyLock.current = false;
      setBusy(false);
    }
  };

  if (!canManage) {
    return (
      <TranslationViewer
        posts={posts}
        languages={languages}
        isLoading={postsQ.isLoading || langQ.isLoading}
        error={(postsQ.error ?? langQ.error) as Error | null}
      />
    );
  }

  if (postsQ.isError || langQ.isError) {
    const error = (postsQ.error ?? langQ.error) as Error;
    return (
      <Card glow>
        <CardHeader><CardTitle>Übersetzungen</CardTitle></CardHeader>
        <p className="text-danger text-sm">Übersetzungen konnten nicht geladen werden.</p>
        <p className="text-muted text-xs mt-2 break-words">{error.message}</p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2"><Languages size={18}/> Übersetzungen</CardTitle>
              <CardDesc>Texte automatisch übersetzen und als Embed posten.</CardDesc>
            </div>
            <Button size="sm" onClick={() => { setCreating(true); setEditingId(null); setForm(blank()); }}><Plus size={16}/> Neu</Button>
          </div>
        </CardHeader>
        <div className="px-4 pb-4 space-y-2">
          {(postsQ.isLoading || langQ.isLoading) && <p className="text-muted text-sm">Lade…</p>}
          {posts.map(p => {
            const Icon = MODES[p.mode].icon;
            return (
              <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
                <button className="flex-1 text-left min-w-0" onClick={() => { setEditingId(p.id); setCreating(false); setForm(toForm(p)); }}>
                  <div className="flex flex-wrap gap-2 items-center">
                    <Icon size={15}/><span className="break-words">{p.customTitle}</span><Badge>{langName(p.sourceLang)} → {langName(p.targetLang)}</Badge>{(p.hasImage ?? Boolean(p.imageUrl)) && <Badge>Bild</Badge>}
                  </div>
                  <div className="text-xs text-muted break-all">#{channelNames[p.channelId] ?? p.channelId}</div>
                </button>
                <div className="flex gap-1 shrink-0">
                  {p.mode !== 'now' && <Button size="sm" variant="ghost" onClick={() => toggle(p)} disabled={busy} aria-label={`Übersetzung ${p.customTitle} ${p.isActive ? 'deaktivieren' : 'aktivieren'}`}><Power size={15}/></Button>}
                  <Button size="sm" variant="ghost" onClick={() => remove(p)} disabled={busy} aria-label={`Übersetzung ${p.customTitle} löschen`}><Trash2 size={15}/></Button>
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {(creating || editingId) && (
        <Card>
          <CardHeader>
            <div className="flex justify-between gap-2"><CardTitle>{editingId ? 'Übersetzung bearbeiten' : 'Neue Übersetzung'}</CardTitle><Button size="sm" variant="ghost" onClick={reset} disabled={busy} aria-label="Übersetzungseditor schließen"><X size={16}/></Button></div>
          </CardHeader>
          <div className="px-4 pb-4 space-y-3">
            <Field label="Titel"><Input value={form.customTitle} onChange={e => patch({ customTitle: e.target.value })}/></Field>
            <Field label="Text (Quelle)"><textarea className="w-full min-h-[100px] rounded-md border border-border bg-bg-elev p-2" value={form.sourceText} maxLength={4000} onChange={e => patch({ sourceText: e.target.value })}/></Field>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="Quellsprache"><Select value={form.sourceLang} onChange={e => patch({ sourceLang: e.target.value })}><option value="auto">Automatisch</option>{languages.map(l => <option key={l.code} value={l.code}>{l.emoji} {l.name}</option>)}</Select></Field>
              <Field label="Zielsprache"><Select value={form.targetLang} onChange={e => patch({ targetLang: e.target.value })}>{languages.map(l => <option key={l.code} value={l.code}>{l.emoji} {l.name}</option>)}</Select></Field>
              <Field label="Ziel-Channel"><Select value={form.channelId} onChange={e => patch({ channelId: e.target.value })}><option value="">— wählen —</option>{channels.map(c => <option key={c.id} value={c.id}>#{c.name}</option>)}</Select></Field>
            </div>
            <Field label="Bild (optional)"><TranslationImageField file={form.imageFile} hasExisting={form.hasExistingImage} onFile={chooseImage} onRemove={() => patch({ imageFile: null, hasExistingImage: false, removeImage: true })}/></Field>
            <Field label="Zeitplan">
              <div className="flex flex-col gap-2 sm:flex-row">
                {(Object.keys(MODES) as Mode[]).map(m => {
                  const I = MODES[m].icon;
                  return <button key={m} className={`flex-1 border rounded-md p-2 ${form.mode === m ? 'border-brand' : 'border-border'}`} onClick={() => patch({ mode: m })}><I size={14} className="inline"/> {MODES[m].label}</button>;
                })}
              </div>
            </Field>
            {form.mode === 'once' && <Field label="Zeitpunkt"><Input type="datetime-local" value={form.scheduledAt} onChange={e => patch({ scheduledAt: e.target.value })}/></Field>}
            {form.mode === 'recurring' && <Field label="Wiederholung"><Input value={form.recurrence} onChange={e => patch({ recurrence: e.target.value })}/></Field>}
            <Field label="Ping-Rollen (optional, max. 3)"><div className="flex flex-wrap gap-1.5 border border-border rounded-md p-2">{roles.map(r => <button key={r.id} onClick={() => toggleRole(r.id)} className={form.rolePings.includes(r.id) ? 'text-white' : 'text-muted'}>@{r.name}</button>)}</div></Field>
            <Button onClick={save} disabled={busy}><Save size={16}/> {form.mode === 'now' ? 'Senden' : 'Speichern'}</Button>
          </div>
        </Card>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="text-muted text-xs mb-1 block">{label}</span>{children}</label>;
}
