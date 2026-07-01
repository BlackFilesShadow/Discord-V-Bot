/**
 * Embed-Builder ("Eingebettete Nachrichten") — Dashboard-only.
 *
 * Verwaltet eigenständige Embeds/Vorlagen pro Guild und postet/synchronisiert
 * sie in einen Ziel-Channel. Zweispaltig: links Editor, rechts Live-Vorschau.
 *
 * Backend: /api/v2/guilds/:guildId/embeds (CRUD + duplicate + send + sync + media).
 */
import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Layers, Plus, Save, Send, RotateCcw, Copy, Trash2, Upload, ArrowUp, ArrowDown, X, FileText, PencilLine,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Card, CardHeader, CardTitle, CardDesc } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Switch } from '@/components/ui/Switch';
import { Badge } from '@/components/ui/Badge';
import { useToast } from '@/components/ui/Toast';
import { DiscordEmbedPreview } from '@/components/embed/DiscordEmbedPreview';

interface EmbedField { name: string; value: string; inline: boolean }

interface ApiEmbed {
  id: string;
  name: string;
  channelId: string | null;
  messageId: string | null;
  content: string | null;
  title: string | null;
  description: string | null;
  url: string | null;
  color: string | null;
  authorName: string | null;
  authorIconUrl: string | null;
  authorUrl: string | null;
  footerText: string | null;
  footerIconUrl: string | null;
  thumbnailUrl: string | null;
  imageUrl: string | null;
  showTimestamp: boolean;
  fields: EmbedField[];
  isTemplate: boolean;
  isDraft: boolean;
  isPosted: boolean;
  createdAt: string;
  updatedAt: string;
}

interface EmbedForm {
  name: string;
  channelId: string;
  content: string;
  title: string;
  description: string;
  url: string;
  color: string;
  authorName: string;
  authorIconUrl: string;
  authorUrl: string;
  footerText: string;
  footerIconUrl: string;
  thumbnailUrl: string;
  imageUrl: string;
  showTimestamp: boolean;
  fields: EmbedField[];
  isTemplate: boolean;
}

interface DiscordChannel { id: string; name: string; type: number; parentId: string | null }

const COLOR_PRESETS: Array<{ name: string; hex: string }> = [
  { name: 'Blurple', hex: '#5865f2' },
  { name: 'Grün', hex: '#22c55e' },
  { name: 'Rot', hex: '#dc2626' },
  { name: 'Gelb', hex: '#eab308' },
  { name: 'Orange', hex: '#f97316' },
  { name: 'Türkis', hex: '#06b6d4' },
  { name: 'Pink', hex: '#ec4899' },
  { name: 'Grau', hex: '#4f545c' },
];

const LIMITS = { title: 256, description: 4096, footerText: 2048, authorName: 256, content: 2000, fieldName: 256, fieldValue: 1024, fieldCount: 25 };

function emptyForm(): EmbedForm {
  return {
    name: '', channelId: '', content: '', title: '', description: '', url: '', color: '#5865f2',
    authorName: '', authorIconUrl: '', authorUrl: '', footerText: '', footerIconUrl: '',
    thumbnailUrl: '', imageUrl: '', showTimestamp: false, fields: [], isTemplate: false,
  };
}

function toForm(a: ApiEmbed): EmbedForm {
  return {
    name: a.name,
    channelId: a.channelId ?? '',
    content: a.content ?? '',
    title: a.title ?? '',
    description: a.description ?? '',
    url: a.url ?? '',
    color: a.color ?? '#5865f2',
    authorName: a.authorName ?? '',
    authorIconUrl: a.authorIconUrl ?? '',
    authorUrl: a.authorUrl ?? '',
    footerText: a.footerText ?? '',
    footerIconUrl: a.footerIconUrl ?? '',
    thumbnailUrl: a.thumbnailUrl ?? '',
    imageUrl: a.imageUrl ?? '',
    showTimestamp: a.showTimestamp,
    fields: a.fields.map(f => ({ name: f.name, value: f.value, inline: f.inline })),
    isTemplate: a.isTemplate,
  };
}

function buildPayload(f: EmbedForm, isDraft: boolean): Record<string, unknown> {
  return {
    name: f.name.trim(),
    channelId: f.channelId || null,
    content: f.content,
    title: f.title,
    description: f.description,
    url: f.url,
    color: f.color,
    authorName: f.authorName,
    authorIconUrl: f.authorIconUrl,
    authorUrl: f.authorUrl,
    footerText: f.footerText,
    footerIconUrl: f.footerIconUrl,
    thumbnailUrl: f.thumbnailUrl,
    imageUrl: f.imageUrl,
    showTimestamp: f.showTimestamp,
    fields: f.fields
      .map(x => ({ name: x.name.trim(), value: x.value.trim(), inline: x.inline }))
      .filter(x => x.name.length > 0 && x.value.length > 0),
    isTemplate: f.isTemplate,
    isDraft,
  };
}

export function EmbedBuilderTab({ guildId, canManage }: { guildId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();

  const listQ = useQuery({
    queryKey: ['embeds', guildId],
    queryFn: () => api.get<{ embeds: ApiEmbed[] }>(`/api/v2/guilds/${guildId}/embeds`),
    enabled: !!guildId,
  });
  const channelsQ = useQuery({
    queryKey: ['guild-channels', guildId],
    queryFn: () => api.get<{ channels: DiscordChannel[] }>(`/api/v2/guilds/${guildId}/channels`),
    enabled: !!guildId && canManage,
  });

  const [editingId, setEditingId] = useState<string | 'new' | null>(null);
  const [form, setForm] = useState<EmbedForm>(emptyForm());
  const [busy, setBusy] = useState<null | 'save' | 'send' | 'sync' | 'delete' | 'dup'>(null);
  const [uploading, setUploading] = useState<null | string>(null);
  const fileRefs = {
    author: useRef<HTMLInputElement>(null),
    footer: useRef<HTMLInputElement>(null),
    thumb: useRef<HTMLInputElement>(null),
    image: useRef<HTMLInputElement>(null),
  };

  const current = editingId && editingId !== 'new'
    ? listQ.data?.embeds.find(e => e.id === editingId) ?? null
    : null;

  const channelNames: Record<string, string> = {};
  for (const c of channelsQ.data?.channels ?? []) channelNames[c.id] = c.name;

  const textChannels = (channelsQ.data?.channels ?? []).filter(c => c.type === 0 || c.type === 5);

  function set<K extends keyof EmbedForm>(key: K, value: EmbedForm[K]) {
    setForm(prev => ({ ...prev, [key]: value }));
  }

  function startNew() {
    setForm(emptyForm());
    setEditingId('new');
  }

  function startEdit(a: ApiEmbed) {
    setForm(toForm(a));
    setEditingId(a.id);
  }

  function cancelEdit() {
    setEditingId(null);
    setForm(emptyForm());
  }

  async function refetch() {
    await qc.invalidateQueries({ queryKey: ['embeds', guildId] });
  }

  /** Speichert das Formular (create/update) und gibt die ID zurueck. */
  async function persist(isDraft: boolean): Promise<string | null> {
    if (form.name.trim().length === 0) {
      toast.error('Name darf nicht leer sein.');
      return null;
    }
    const payload = buildPayload(form, isDraft);
    try {
      if (editingId === 'new' || editingId === null) {
        const created = await api.post<ApiEmbed>(`/api/v2/guilds/${guildId}/embeds`, payload);
        setEditingId(created.id);
        await refetch();
        return created.id;
      }
      await api.put<ApiEmbed>(`/api/v2/guilds/${guildId}/embeds/${editingId}`, payload);
      await refetch();
      return editingId;
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Speichern fehlgeschlagen.');
      return null;
    }
  }

  async function onSave() {
    setBusy('save');
    const id = await persist(true);
    setBusy(null);
    if (id) toast.success('Embed gespeichert.');
  }

  async function onSend() {
    if (!form.channelId) { toast.error('Bitte zuerst einen Ziel-Channel wählen.'); return; }
    setBusy('send');
    const id = await persist(false);
    if (!id) { setBusy(null); return; }
    try {
      const r = await api.post<{ messageId: string }>(`/api/v2/guilds/${guildId}/embeds/${id}/send`, { channelId: form.channelId });
      toast.success(`Embed gesendet (Nachricht ${r.messageId}).`);
      await refetch();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Senden fehlgeschlagen.');
    }
    setBusy(null);
  }

  async function onSync() {
    if (!current?.isPosted) return;
    setBusy('sync');
    const id = await persist(false);
    if (!id) { setBusy(null); return; }
    try {
      await api.post(`/api/v2/guilds/${guildId}/embeds/${id}/sync`, {});
      toast.success('Gepostete Nachricht aktualisiert.');
      await refetch();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Synchronisieren fehlgeschlagen.');
    }
    setBusy(null);
  }

  async function onDuplicate(id: string) {
    setBusy('dup');
    try {
      const copy = await api.post<ApiEmbed>(`/api/v2/guilds/${guildId}/embeds/${id}/duplicate`, {});
      await refetch();
      startEdit(copy);
      toast.success('Embed dupliziert.');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Duplizieren fehlgeschlagen.');
    }
    setBusy(null);
  }

  async function onDelete(id: string) {
    if (!window.confirm('Diesen Embed wirklich löschen? Eine bereits gepostete Nachricht wird ebenfalls entfernt.')) return;
    setBusy('delete');
    try {
      await api.del(`/api/v2/guilds/${guildId}/embeds/${id}`);
      await refetch();
      if (editingId === id) cancelEdit();
      toast.success('Embed gelöscht.');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Löschen fehlgeschlagen.');
    }
    setBusy(null);
  }

  async function uploadImage(kind: string, ref: React.RefObject<HTMLInputElement>, target: keyof EmbedForm) {
    const file = ref.current?.files?.[0];
    if (!file) return;
    setUploading(kind);
    try {
      const r = await api.upload<{ url: string }>(`/api/v2/guilds/${guildId}/embeds/media`, file);
      set(target, r.url as EmbedForm[typeof target]);
      toast.success('Bild hochgeladen.');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Upload fehlgeschlagen.');
    } finally {
      setUploading(null);
      if (ref.current) ref.current.value = '';
    }
  }

  // Feld-Operationen
  function addField() {
    if (form.fields.length >= LIMITS.fieldCount) return;
    set('fields', [...form.fields, { name: '', value: '', inline: false }]);
  }
  function updateField(i: number, patch: Partial<EmbedField>) {
    set('fields', form.fields.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  }
  function removeField(i: number) {
    set('fields', form.fields.filter((_, idx) => idx !== i));
  }
  function moveField(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= form.fields.length) return;
    const next = [...form.fields];
    [next[i], next[j]] = [next[j], next[i]];
    set('fields', next);
  }

  if (!canManage) {
    return (
      <Card>
        <CardHeader><Layers className="h-5 w-5 text-accent" /><CardTitle>Eingebettete Nachrichten</CardTitle></CardHeader>
        <CardDesc>Du hast keine Berechtigung, Embeds zu verwalten (benötigt <code>embeds.manage</code>).</CardDesc>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Liste */}
      <Card>
        <CardHeader className="!mb-3 justify-between">
          <div className="flex items-center gap-3">
            <Layers className="h-5 w-5 text-accent" />
            <div>
              <CardTitle>Eingebettete Nachrichten</CardTitle>
              <CardDesc>Erstelle Embeds &amp; Vorlagen und poste sie in einen Channel.</CardDesc>
            </div>
          </div>
          <Button size="sm" onClick={startNew}><Plus className="h-4 w-4" /> Neuer Embed</Button>
        </CardHeader>

        {listQ.isLoading && <div className="h-16 rounded-xl skeleton" />}
        {listQ.data && listQ.data.embeds.length === 0 && (
          <p className="text-muted text-sm">Noch keine Embeds. Lege den ersten mit „Neuer Embed“ an.</p>
        )}
        <div className="grid gap-2 sm:grid-cols-2">
          {listQ.data?.embeds.map(e => (
            <button
              key={e.id}
              type="button"
              onClick={() => startEdit(e)}
              className={`text-left rounded-lg border px-3 py-2.5 transition-colors ${
                editingId === e.id ? 'border-accent/50 bg-accent/10' : 'border-border hover:border-white/15 hover:bg-bg-elev'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="truncate font-medium text-white">{e.name}</span>
                {e.isTemplate && <Badge variant="info">Vorlage</Badge>}
                {e.isPosted ? <Badge variant="ok">gepostet</Badge> : e.isDraft ? <Badge variant="warn">Entwurf</Badge> : null}
              </div>
              <div className="mt-0.5 truncate text-xs text-muted">
                {e.title || e.description || 'Kein Titel'}
              </div>
            </button>
          ))}
        </div>
      </Card>

      {/* Editor + Vorschau */}
      {editingId && (
        <div className="grid gap-4 lg:grid-cols-2">
          {/* Editor */}
          <Card className="space-y-4">
            <CardHeader className="!mb-1 justify-between">
              <div className="flex items-center gap-2">
                {editingId === 'new' ? <Plus className="h-5 w-5 text-accent" /> : <PencilLine className="h-5 w-5 text-accent" />}
                <CardTitle>{editingId === 'new' ? 'Neuer Embed' : 'Embed bearbeiten'}</CardTitle>
              </div>
              <button type="button" onClick={cancelEdit} className="text-muted hover:text-white focus-ring rounded p-1" aria-label="Editor schließen">
                <X className="h-4 w-4" />
              </button>
            </CardHeader>

            <Field label="Name (intern)">
              <Input value={form.name} maxLength={120} onChange={e => set('name', e.target.value)} placeholder="z. B. Regeln, Willkommens-Panel" />
            </Field>

            <Field label="Nachrichtentext (außerhalb des Embeds, optional)" hint={`${form.content.length}/${LIMITS.content}`}>
              <textarea
                value={form.content}
                maxLength={LIMITS.content}
                onChange={e => set('content', e.target.value)}
                rows={2}
                className="input-premium w-full rounded-lg px-3.5 py-2.5 text-sm text-white"
                placeholder="Optionaler Text über dem Embed. Channel verlinken mit <#Kanal-ID>."
              />
            </Field>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Titel" hint={`${form.title.length}/${LIMITS.title}`}>
                <Input value={form.title} maxLength={LIMITS.title} onChange={e => set('title', e.target.value)} />
              </Field>
              <Field label="Titel-URL (optional)">
                <Input value={form.url} onChange={e => set('url', e.target.value)} placeholder="https://…" />
              </Field>
            </div>

            <Field label="Beschreibung" hint={`${form.description.length}/${LIMITS.description}`}>
              <textarea
                value={form.description}
                maxLength={LIMITS.description}
                onChange={e => set('description', e.target.value)}
                rows={5}
                className="input-premium w-full rounded-lg px-3.5 py-2.5 text-sm text-white"
                placeholder="Haupttext des Embeds. Zeilenumbrüche & <#Kanal-ID> werden unterstützt."
              />
            </Field>

            {/* Farbe */}
            <Field label="Farbe">
              <div className="flex flex-wrap items-center gap-2">
                {COLOR_PRESETS.map(p => (
                  <button
                    key={p.hex}
                    type="button"
                    title={p.name}
                    onClick={() => set('color', p.hex)}
                    className={`h-7 w-7 rounded-full border-2 transition-transform hover:scale-110 ${
                      p.hex.toLowerCase() === form.color.toLowerCase() ? 'border-white' : 'border-transparent'
                    }`}
                    style={{ backgroundColor: p.hex }}
                  />
                ))}
                <input type="color" value={/^#[0-9a-fA-F]{6}$/.test(form.color) ? form.color : '#5865f2'} onChange={e => set('color', e.target.value)} className="h-8 w-10 cursor-pointer rounded bg-transparent" />
                <Input value={form.color} onChange={e => set('color', e.target.value)} className="w-28 font-mono text-xs" maxLength={9} />
              </div>
            </Field>

            {/* Autor */}
            <fieldset className="rounded-lg border border-border p-3">
              <legend className="px-1 text-xs uppercase tracking-wider text-muted">Autor</legend>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Name"><Input value={form.authorName} maxLength={LIMITS.authorName} onChange={e => set('authorName', e.target.value)} /></Field>
                <Field label="URL"><Input value={form.authorUrl} onChange={e => set('authorUrl', e.target.value)} placeholder="https://…" /></Field>
              </div>
              <ImageField
                label="Icon-URL"
                value={form.authorIconUrl}
                onChange={v => set('authorIconUrl', v)}
                inputRef={fileRefs.author}
                uploading={uploading === 'author'}
                onUpload={() => uploadImage('author', fileRefs.author, 'authorIconUrl')}
              />
            </fieldset>

            {/* Bilder */}
            <fieldset className="rounded-lg border border-border p-3">
              <legend className="px-1 text-xs uppercase tracking-wider text-muted">Bilder</legend>
              <ImageField
                label="Thumbnail-URL (klein, oben rechts)"
                value={form.thumbnailUrl}
                onChange={v => set('thumbnailUrl', v)}
                inputRef={fileRefs.thumb}
                uploading={uploading === 'thumb'}
                onUpload={() => uploadImage('thumb', fileRefs.thumb, 'thumbnailUrl')}
              />
              <ImageField
                label="Großes Bild-URL (unten)"
                value={form.imageUrl}
                onChange={v => set('imageUrl', v)}
                inputRef={fileRefs.image}
                uploading={uploading === 'image'}
                onUpload={() => uploadImage('image', fileRefs.image, 'imageUrl')}
              />
            </fieldset>

            {/* Footer */}
            <fieldset className="rounded-lg border border-border p-3">
              <legend className="px-1 text-xs uppercase tracking-wider text-muted">Footer</legend>
              <Field label="Text" hint={`${form.footerText.length}/${LIMITS.footerText}`}>
                <Input value={form.footerText} maxLength={LIMITS.footerText} onChange={e => set('footerText', e.target.value)} />
              </Field>
              <ImageField
                label="Icon-URL"
                value={form.footerIconUrl}
                onChange={v => set('footerIconUrl', v)}
                inputRef={fileRefs.footer}
                uploading={uploading === 'footer'}
                onUpload={() => uploadImage('footer', fileRefs.footer, 'footerIconUrl')}
              />
              <div className="mt-2">
                <Switch checked={form.showTimestamp} onChange={v => set('showTimestamp', v)} label="Zeitstempel anzeigen" />
              </div>
            </fieldset>

            {/* Felder */}
            <fieldset className="rounded-lg border border-border p-3">
              <legend className="px-1 text-xs uppercase tracking-wider text-muted">Felder ({form.fields.length}/{LIMITS.fieldCount})</legend>
              <div className="space-y-3">
                {form.fields.map((f, i) => (
                  <div key={i} className="rounded-md border border-border/70 bg-bg-elev/40 p-2.5">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span className="text-xs text-muted">Feld {i + 1}</span>
                      <div className="flex items-center gap-1">
                        <button type="button" onClick={() => moveField(i, -1)} disabled={i === 0} className="rounded p-1 text-muted hover:text-white disabled:opacity-30 focus-ring" aria-label="Nach oben"><ArrowUp className="h-3.5 w-3.5" /></button>
                        <button type="button" onClick={() => moveField(i, 1)} disabled={i === form.fields.length - 1} className="rounded p-1 text-muted hover:text-white disabled:opacity-30 focus-ring" aria-label="Nach unten"><ArrowDown className="h-3.5 w-3.5" /></button>
                        <button type="button" onClick={() => removeField(i)} className="rounded p-1 text-red-400 hover:text-red-300 focus-ring" aria-label="Feld entfernen"><Trash2 className="h-3.5 w-3.5" /></button>
                      </div>
                    </div>
                    <Input value={f.name} maxLength={LIMITS.fieldName} onChange={e => updateField(i, { name: e.target.value })} placeholder="Feld-Titel" className="mb-2" />
                    <textarea
                      value={f.value}
                      maxLength={LIMITS.fieldValue}
                      onChange={e => updateField(i, { value: e.target.value })}
                      rows={2}
                      className="input-premium mb-2 w-full rounded-lg px-3 py-2 text-sm text-white"
                      placeholder="Feld-Inhalt"
                    />
                    <Switch checked={f.inline} onChange={v => updateField(i, { inline: v })} label="Inline (nebeneinander)" />
                  </div>
                ))}
                <Button variant="secondary" size="sm" onClick={addField} disabled={form.fields.length >= LIMITS.fieldCount}>
                  <Plus className="h-4 w-4" /> Feld hinzufügen
                </Button>
              </div>
            </fieldset>

            {/* Optionen */}
            <div className="flex flex-wrap items-center gap-4">
              <Switch checked={form.isTemplate} onChange={v => set('isTemplate', v)} label="Als Vorlage markieren" />
            </div>

            {/* Ziel-Channel + Aktionen */}
            <div className="border-t border-border pt-4">
              <Field label="Ziel-Channel (zum Senden)">
                <Select value={form.channelId} onChange={e => set('channelId', e.target.value)}>
                  <option value="">— Channel wählen —</option>
                  {textChannels.map(c => (
                    <option key={c.id} value={c.id}>#{c.name}</option>
                  ))}
                </Select>
              </Field>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button onClick={onSave} loading={busy === 'save'}><Save className="h-4 w-4" /> Speichern</Button>
                <Button variant="primary" onClick={onSend} loading={busy === 'send'} disabled={!form.channelId}><Send className="h-4 w-4" /> Senden</Button>
                {current?.isPosted && (
                  <Button variant="secondary" onClick={onSync} loading={busy === 'sync'}><RotateCcw className="h-4 w-4" /> Nachricht aktualisieren</Button>
                )}
                {editingId !== 'new' && current && (
                  <>
                    <Button variant="secondary" onClick={() => onDuplicate(current.id)} loading={busy === 'dup'}><Copy className="h-4 w-4" /> Duplizieren</Button>
                    <Button variant="danger" onClick={() => onDelete(current.id)} loading={busy === 'delete'}><Trash2 className="h-4 w-4" /> Löschen</Button>
                  </>
                )}
              </div>
              {current?.isPosted && current.channelId && (
                <p className="mt-2 text-xs text-muted">
                  Gepostet in #{channelNames[current.channelId] ?? current.channelId}. „Nachricht aktualisieren“ überträgt Änderungen auf die bestehende Nachricht.
                </p>
              )}
            </div>
          </Card>

          {/* Vorschau */}
          <div className="lg:sticky lg:top-4 lg:self-start">
            <Card className="!p-4">
              <CardHeader className="!mb-3">
                <FileText className="h-5 w-5 text-accent" />
                <CardTitle>Live-Vorschau</CardTitle>
              </CardHeader>
              <DiscordEmbedPreview data={form} channels={channelNames} />
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-sm font-medium text-white/90">{label}</span>
        {hint && <span className="text-[11px] text-muted">{hint}</span>}
      </div>
      {children}
    </label>
  );
}

function ImageField({
  label, value, onChange, inputRef, uploading, onUpload,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  inputRef: React.RefObject<HTMLInputElement>;
  uploading: boolean;
  onUpload: () => void;
}) {
  return (
    <div className="mt-2">
      <div className="mb-1 text-sm font-medium text-white/90">{label}</div>
      <div className="flex items-center gap-2">
        <Input value={value} onChange={e => onChange(e.target.value)} placeholder="https://… oder hochladen" className="flex-1" />
        {value && (
          <button type="button" onClick={() => onChange('')} className="rounded p-2 text-muted hover:text-white focus-ring" aria-label="Zurücksetzen">
            <X className="h-4 w-4" />
          </button>
        )}
        <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" onChange={onUpload} />
        <Button variant="secondary" size="sm" type="button" loading={uploading} onClick={() => inputRef.current?.click()}>
          <Upload className="h-4 w-4" /> Upload
        </Button>
      </div>
    </div>
  );
}
