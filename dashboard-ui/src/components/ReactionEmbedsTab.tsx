/**
 * Reaktions-Embeds ("Reaktions Embeds") — Dashboard-only.
 *
 * Self-Role-Menus mit Buttons / Dropdown / Emoji-Reaktionen. Optional kann ein
 * im Embed-Builder erstelltes Embed als Nachrichtendesign verknuepft werden.
 * Zweispaltig: links Editor, rechts Live-Vorschau (Embed + Komponenten).
 *
 * Backend: /api/v2/guilds/:guildId/reaction-embeds (CRUD + Optionen + send/sync/archive).
 */
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ToggleLeft, Plus, Save, Send, RotateCcw, Trash2, Archive, ArchiveRestore,
  ArrowUp, ArrowDown, X, MousePointerClick,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Card, CardHeader, CardTitle, CardDesc } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Switch } from '@/components/ui/Switch';
import { Badge } from '@/components/ui/Badge';
import { useToast } from '@/components/ui/Toast';
import { DiscordEmbedPreview, type EmbedPreviewData } from '@/components/embed/DiscordEmbedPreview';

// ── Typen ─────────────────────────────────────────────────────────────────
type ComponentType = 'BUTTON' | 'SELECT' | 'REACTION';
type AssignMode = 'GIVE' | 'REMOVE' | 'TOGGLE';
type Mode = 'MULTI' | 'SINGLE';
type ButtonStyle = 'PRIMARY' | 'SECONDARY' | 'SUCCESS' | 'DANGER';

interface ApiOption {
  id: string;
  roleId: string;
  label: string;
  emoji: string | null;
  description: string | null;
  position: number;
  buttonStyle: ButtonStyle;
  isActive: boolean;
}

interface ApiMenu {
  id: string;
  channelId: string;
  messageId: string | null;
  isPosted: boolean;
  title: string;
  description: string | null;
  mode: Mode;
  isActive: boolean;
  componentType: ComponentType;
  assignMode: AssignMode;
  maxRolesPerUser: number | null;
  archived: boolean;
  embedId: string | null;
  createdAt: string;
  updatedAt: string;
  options: ApiOption[];
}

interface DiscordChannel { id: string; name: string; type: number; parentId: string | null }
interface DiscordRole { id: string; name: string; color: string; position: number; managed: boolean }
interface ApiEmbedLite {
  id: string; name: string; content: string | null; title: string | null; description: string | null;
  url: string | null; color: string | null; authorName: string | null; authorIconUrl: string | null;
  authorUrl: string | null; footerText: string | null; footerIconUrl: string | null;
  thumbnailUrl: string | null; imageUrl: string | null; showTimestamp: boolean;
  fields: Array<{ name: string; value: string; inline: boolean }>;
}

interface MenuForm {
  title: string;
  description: string;
  channelId: string;
  componentType: ComponentType;
  assignMode: AssignMode;
  mode: Mode;
  maxRolesPerUser: string; // Eingabe als String, '' = unbegrenzt
  embedId: string;
}

interface OptionForm {
  id?: string; // vorhandene DB-Option
  roleId: string;
  label: string;
  emoji: string;
  description: string;
  buttonStyle: ButtonStyle;
  isActive: boolean;
}

const BUTTON_STYLE_COLORS: Record<ButtonStyle, string> = {
  PRIMARY: '#5865f2',
  SECONDARY: '#4e5058',
  SUCCESS: '#248046',
  DANGER: '#da373c',
};

function emptyMenuForm(): MenuForm {
  return {
    title: '', description: '', channelId: '', componentType: 'BUTTON',
    assignMode: 'TOGGLE', mode: 'MULTI', maxRolesPerUser: '', embedId: '',
  };
}

function menuToForm(m: ApiMenu): MenuForm {
  return {
    title: m.title,
    description: m.description ?? '',
    channelId: m.channelId,
    componentType: m.componentType,
    assignMode: m.assignMode,
    mode: m.mode,
    maxRolesPerUser: m.maxRolesPerUser != null ? String(m.maxRolesPerUser) : '',
    embedId: m.embedId ?? '',
  };
}

function optionToForm(o: ApiOption): OptionForm {
  return {
    id: o.id, roleId: o.roleId, label: o.label, emoji: o.emoji ?? '',
    description: o.description ?? '', buttonStyle: o.buttonStyle, isActive: o.isActive,
  };
}

export function ReactionEmbedsTab({ guildId, canManage }: { guildId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();

  const listQ = useQuery({
    queryKey: ['reaction-embeds', guildId],
    queryFn: () => api.get<{ menus: ApiMenu[] }>(`/api/v2/guilds/${guildId}/reaction-embeds`),
  });
  const channelsQ = useQuery({
    queryKey: ['guild-channels', guildId],
    queryFn: () => api.get<{ channels: DiscordChannel[] }>(`/api/v2/guilds/${guildId}/channels`),
  });
  const rolesQ = useQuery({
    queryKey: ['guild-roles', guildId],
    queryFn: () => api.get<{ roles: DiscordRole[] }>(`/api/v2/guilds/${guildId}/roles`),
  });
  const embedsQ = useQuery({
    queryKey: ['embeds', guildId],
    queryFn: () => api.get<{ embeds: ApiEmbedLite[] }>(`/api/v2/guilds/${guildId}/embeds`),
  });

  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<MenuForm>(emptyMenuForm());
  const [options, setOptions] = useState<OptionForm[]>([]);
  const [busy, setBusy] = useState(false);

  const menus = listQ.data?.menus ?? [];
  const textChannels = (channelsQ.data?.channels ?? []).filter(c => c.type === 0 || c.type === 5);
  const selectableRoles = (rolesQ.data?.roles ?? [])
    .filter(r => r.id !== guildId && !r.managed)
    .sort((a, b) => b.position - a.position);
  const roleName = (id: string) => selectableRoles.find(r => r.id === id)?.name ?? rolesQ.data?.roles.find(r => r.id === id)?.name ?? id;
  const channelNames = useMemo(() => {
    const map: Record<string, string> = {};
    for (const c of channelsQ.data?.channels ?? []) map[c.id] = c.name;
    return map;
  }, [channelsQ.data]);

  const linkedEmbed = form.embedId ? embedsQ.data?.embeds.find(e => e.id === form.embedId) ?? null : null;

  function resetEditor() {
    setEditingId(null);
    setCreating(false);
    setForm(emptyMenuForm());
    setOptions([]);
  }

  function startCreate() {
    setCreating(true);
    setEditingId(null);
    setForm(emptyMenuForm());
    setOptions([]);
  }

  function startEdit(m: ApiMenu) {
    setEditingId(m.id);
    setCreating(false);
    setForm(menuToForm(m));
    setOptions(m.options.slice().sort((a, b) => a.position - b.position).map(optionToForm));
  }

  function patch(p: Partial<MenuForm>) { setForm(f => ({ ...f, ...p })); }

  // ── Options-Editor (lokaler Zustand) ──────────────────────────────────────
  function addOption() {
    if (options.length >= 25) { toast.error('Maximal 25 Optionen pro Menü.'); return; }
    setOptions(o => [...o, {
      roleId: selectableRoles[0]?.id ?? '', label: '', emoji: '',
      description: '', buttonStyle: 'SECONDARY', isActive: true,
    }]);
  }
  function patchOption(idx: number, p: Partial<OptionForm>) {
    setOptions(o => o.map((it, i) => (i === idx ? { ...it, ...p } : it)));
  }
  function removeOption(idx: number) { setOptions(o => o.filter((_, i) => i !== idx)); }
  function moveOption(idx: number, dir: -1 | 1) {
    setOptions(o => {
      const next = o.slice();
      const j = idx + dir;
      if (j < 0 || j >= next.length) return o;
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
  }

  // ── Persistenz ─────────────────────────────────────────────────────────────
  function menuPayload(): Record<string, unknown> {
    return {
      title: form.title.trim(),
      description: form.description.trim() || null,
      channelId: form.channelId,
      componentType: form.componentType,
      assignMode: form.assignMode,
      mode: form.mode,
      maxRolesPerUser: form.maxRolesPerUser === '' ? null : Number(form.maxRolesPerUser),
      embedId: form.embedId || null,
    };
  }

  function validate(): string | null {
    if (form.title.trim().length < 1) return 'Titel ist erforderlich.';
    if (!/^\d{17,20}$/.test(form.channelId)) return 'Bitte einen Ziel-Channel wählen.';
    if (form.maxRolesPerUser !== '') {
      const n = Number(form.maxRolesPerUser);
      if (!Number.isInteger(n) || n < 1 || n > 25) return 'Max. Rollen pro User muss 1..25 sein.';
    }
    for (const o of options) {
      if (!/^\d{17,20}$/.test(o.roleId)) return 'Jede Option benötigt eine gültige Rolle.';
      if (o.label.trim().length < 1) return 'Jede Option benötigt eine Bezeichnung.';
      if (form.componentType === 'REACTION' && o.isActive && !o.emoji.trim()) {
        return 'Bei Reaktions-Menüs benötigt jede aktive Option ein Emoji.';
      }
    }
    return null;
  }

  /** Synchronisiert Optionen eines bestehenden Menüs mit dem Backend (Create/Update/Delete/Reorder). */
  async function syncOptions(menuId: string, original: ApiOption[]) {
    const originalById = new Map(original.map(o => [o.id, o]));
    const keptIds = new Set(options.filter(o => o.id).map(o => o.id!));
    // Loeschen: in original, aber nicht mehr in Form.
    for (const o of original) {
      if (!keptIds.has(o.id)) {
        await api.del(`/api/v2/guilds/${guildId}/reaction-embeds/${menuId}/options/${o.id}`);
      }
    }
    // Anlegen/Aktualisieren in Reihenfolge.
    const finalIds: string[] = [];
    for (const o of options) {
      const body = {
        roleId: o.roleId, label: o.label.trim(), emoji: o.emoji.trim() || null,
        description: o.description.trim() || null, buttonStyle: o.buttonStyle, isActive: o.isActive,
      };
      if (o.id && originalById.has(o.id)) {
        await api.put(`/api/v2/guilds/${guildId}/reaction-embeds/${menuId}/options/${o.id}`, body);
        finalIds.push(o.id);
      } else {
        const created = await api.post<ApiOption>(`/api/v2/guilds/${guildId}/reaction-embeds/${menuId}/options`, body);
        finalIds.push(created.id);
      }
    }
    if (finalIds.length > 1) {
      await api.post(`/api/v2/guilds/${guildId}/reaction-embeds/${menuId}/reorder`, { order: finalIds });
    }
  }

  async function save(): Promise<string | null> {
    const err = validate();
    if (err) { toast.error(err); return null; }
    setBusy(true);
    try {
      let menuId: string;
      let original: ApiOption[] = [];
      if (editingId) {
        menuId = editingId;
        original = menus.find(m => m.id === editingId)?.options ?? [];
        await api.put(`/api/v2/guilds/${guildId}/reaction-embeds/${menuId}`, menuPayload());
      } else {
        const created = await api.post<ApiMenu>(`/api/v2/guilds/${guildId}/reaction-embeds`, menuPayload());
        menuId = created.id;
      }
      await syncOptions(menuId, original);
      await qc.invalidateQueries({ queryKey: ['reaction-embeds', guildId] });
      toast.success('Reaktions-Embed gespeichert.');
      setEditingId(menuId);
      setCreating(false);
      return menuId;
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Speichern fehlgeschlagen.');
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function saveAndSend() {
    const menuId = await save();
    if (!menuId) return;
    setBusy(true);
    try {
      const r = await api.post<{ messageId: string }>(`/api/v2/guilds/${guildId}/reaction-embeds/${menuId}/send`, {});
      toast.success(`Gesendet (Nachricht ${r.messageId}).`);
      await qc.invalidateQueries({ queryKey: ['reaction-embeds', guildId] });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Senden fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }

  async function sync(id: string) {
    setBusy(true);
    try {
      await api.post(`/api/v2/guilds/${guildId}/reaction-embeds/${id}/sync`, {});
      toast.success('Nachricht aktualisiert.');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Sync fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }

  async function toggleArchive(m: ApiMenu) {
    setBusy(true);
    try {
      await api.post(`/api/v2/guilds/${guildId}/reaction-embeds/${m.id}/archive`, { archived: !m.archived });
      await qc.invalidateQueries({ queryKey: ['reaction-embeds', guildId] });
      toast.success(m.archived ? 'Reaktiviert.' : 'Archiviert.');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Aktion fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!confirm('Dieses Reaktions-Embed wirklich löschen? Die gepostete Nachricht wird ebenfalls entfernt.')) return;
    setBusy(true);
    try {
      await api.del(`/api/v2/guilds/${guildId}/reaction-embeds/${id}`);
      await qc.invalidateQueries({ queryKey: ['reaction-embeds', guildId] });
      if (editingId === id) resetEditor();
      toast.success('Gelöscht.');
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
          <CardTitle>Reaktions Embeds</CardTitle>
          <CardDesc>Du hast keine Berechtigung, Reaktionsrollen zu verwalten (benötigt <code>reactionroles.manage</code>).</CardDesc>
        </CardHeader>
      </Card>
    );
  }

  const previewData: EmbedPreviewData = linkedEmbed
    ? { ...linkedEmbed }
    : {
        title: form.title || '🎭 Rollen-Menü',
        description: [
          form.description,
          options.filter(o => o.isActive).map(o => `${o.emoji ? o.emoji + ' ' : ''}@${roleName(o.roleId)}${o.description ? ` — ${o.description}` : ''}`).join('\n') || '_Keine Optionen._',
        ].filter(Boolean).join('\n\n'),
        color: '#5865f2',
      };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_400px] gap-4">
      {/* ── Linke Spalte: Liste + Editor ─────────────────────────────── */}
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <div>
                <CardTitle className="flex items-center gap-2"><ToggleLeft size={18} /> Reaktions Embeds</CardTitle>
                <CardDesc>Rollen-Menüs mit Buttons, Dropdown oder Emoji-Reaktionen.</CardDesc>
              </div>
              <Button size="sm" onClick={startCreate} disabled={busy}><Plus size={16} /> Neu</Button>
            </div>
          </CardHeader>
          <div className="px-4 pb-4 space-y-2">
            {listQ.isLoading && <p className="text-muted text-sm">Lade…</p>}
            {menus.length === 0 && !listQ.isLoading && <p className="text-muted text-sm">Noch keine Reaktions-Embeds.</p>}
            {menus.map(m => (
              <div key={m.id} className={`flex items-center justify-between gap-2 rounded-md border px-3 py-2 ${editingId === m.id ? 'border-brand' : 'border-border'}`}>
                <button className="flex-1 text-left" onClick={() => startEdit(m)}>
                  <div className="flex items-center gap-2">
                    <span className="text-white text-sm font-medium">{m.title}</span>
                    <Badge>{m.componentType}</Badge>
                    {m.archived && <Badge variant="neutral">Archiviert</Badge>}
                    {m.isPosted && !m.archived && <Badge variant="ok">Gepostet</Badge>}
                  </div>
                  <div className="text-muted text-xs mt-0.5">#{channelNames[m.channelId] ?? m.channelId} · {m.options.length} Option(en)</div>
                </button>
                <div className="flex items-center gap-1">
                  {m.isPosted && <Button size="sm" variant="ghost" title="Nachricht aktualisieren" onClick={() => sync(m.id)} disabled={busy}><RotateCcw size={15} /></Button>}
                  <Button size="sm" variant="ghost" title={m.archived ? 'Reaktivieren' : 'Archivieren'} onClick={() => toggleArchive(m)} disabled={busy}>
                    {m.archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}
                  </Button>
                  <Button size="sm" variant="ghost" title="Löschen" onClick={() => remove(m.id)} disabled={busy}><Trash2 size={15} /></Button>
                </div>
              </div>
            ))}
          </div>
        </Card>

        {(creating || editingId) && (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>{editingId ? 'Menü bearbeiten' : 'Neues Menü'}</CardTitle>
                <Button size="sm" variant="ghost" onClick={resetEditor}><X size={16} /></Button>
              </div>
            </CardHeader>
            <div className="px-4 pb-4 space-y-3">
              <Field label="Titel">
                <Input value={form.title} maxLength={120} onChange={e => patch({ title: e.target.value })} placeholder="Wähle deine Rollen" />
              </Field>
              <Field label="Beschreibung (optional)">
                <textarea
                  className="w-full min-h-[64px] rounded-md bg-bg-elev border border-border text-white px-3 py-2 text-sm focus-ring"
                  value={form.description} maxLength={2000}
                  onChange={e => patch({ description: e.target.value })}
                  placeholder="Kurzer Hinweistext…"
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Ziel-Channel">
                  <Select value={form.channelId} onChange={e => patch({ channelId: e.target.value })}>
                    <option value="">— wählen —</option>
                    {textChannels.map(c => <option key={c.id} value={c.id}>#{c.name}</option>)}
                  </Select>
                </Field>
                <Field label="Verknüpftes Embed (optional)">
                  <Select value={form.embedId} onChange={e => patch({ embedId: e.target.value })}>
                    <option value="">— Standard-Layout —</option>
                    {(embedsQ.data?.embeds ?? []).map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
                  </Select>
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Interaktion">
                  <Select value={form.componentType} onChange={e => patch({ componentType: e.target.value as ComponentType })}>
                    <option value="BUTTON">Buttons</option>
                    <option value="SELECT">Dropdown-Menü</option>
                    <option value="REACTION">Emoji-Reaktionen</option>
                  </Select>
                </Field>
                <Field label="Rollen-Verhalten">
                  <Select value={form.assignMode} onChange={e => patch({ assignMode: e.target.value as AssignMode })}>
                    <option value="TOGGLE">Umschalten (geben/entfernen)</option>
                    <option value="GIVE">Nur geben</option>
                    <option value="REMOVE">Nur entfernen</option>
                  </Select>
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Auswahl-Modus">
                  <Select value={form.mode} onChange={e => patch({ mode: e.target.value as Mode })}>
                    <option value="MULTI">Mehrere Rollen erlaubt</option>
                    <option value="SINGLE">Nur eine Rolle gleichzeitig</option>
                  </Select>
                </Field>
                <Field label="Max. Rollen / User (leer = unbegrenzt)">
                  <Input
                    type="number" min={1} max={25}
                    value={form.maxRolesPerUser}
                    disabled={form.mode === 'SINGLE'}
                    onChange={e => patch({ maxRolesPerUser: e.target.value })}
                    placeholder="∞"
                  />
                </Field>
              </div>

              {/* Optionen */}
              <div className="pt-2 border-t border-border">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-white text-sm font-medium">Rollen-Optionen ({options.length}/25)</span>
                  <Button size="sm" variant="secondary" onClick={addOption} disabled={busy || options.length >= 25}><Plus size={14} /> Option</Button>
                </div>
                <div className="space-y-2">
                  {options.length === 0 && <p className="text-muted text-xs">Noch keine Optionen. Füge mindestens eine Rolle hinzu.</p>}
                  {options.map((o, idx) => (
                    <div key={o.id ?? `new-${idx}`} className="rounded-md border border-border p-2 space-y-2">
                      <div className="flex items-center gap-2">
                        <div className="flex flex-col gap-0.5">
                          <button className="text-muted hover:text-white disabled:opacity-30" onClick={() => moveOption(idx, -1)} disabled={idx === 0}><ArrowUp size={13} /></button>
                          <button className="text-muted hover:text-white disabled:opacity-30" onClick={() => moveOption(idx, 1)} disabled={idx === options.length - 1}><ArrowDown size={13} /></button>
                        </div>
                        <Select value={o.roleId} onChange={e => patchOption(idx, { roleId: e.target.value })} className="flex-1">
                          <option value="">— Rolle —</option>
                          {selectableRoles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                        </Select>
                        <Switch checked={o.isActive} onChange={v => patchOption(idx, { isActive: v })} />
                        <button className="text-muted hover:text-red-400" onClick={() => removeOption(idx)}><Trash2 size={15} /></button>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <Input value={o.label} maxLength={80} onChange={e => patchOption(idx, { label: e.target.value })} placeholder="Bezeichnung" />
                        <Input value={o.emoji} maxLength={64} onChange={e => patchOption(idx, { emoji: e.target.value })} placeholder="Emoji (z. B. 🎮 oder <:name:id>)" />
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <Input value={o.description} maxLength={100} onChange={e => patchOption(idx, { description: e.target.value })} placeholder="Beschreibung (optional)" />
                        {form.componentType === 'BUTTON' ? (
                          <Select value={o.buttonStyle} onChange={e => patchOption(idx, { buttonStyle: e.target.value as ButtonStyle })}>
                            <option value="PRIMARY">Blau (Primary)</option>
                            <option value="SECONDARY">Grau (Secondary)</option>
                            <option value="SUCCESS">Grün (Success)</option>
                            <option value="DANGER">Rot (Danger)</option>
                          </Select>
                        ) : <div />}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex flex-wrap gap-2 pt-2 border-t border-border">
                <Button onClick={save} disabled={busy}><Save size={16} /> Speichern</Button>
                <Button variant="secondary" onClick={saveAndSend} disabled={busy}><Send size={16} /> Speichern &amp; Senden</Button>
              </div>
            </div>
          </Card>
        )}
      </div>

      {/* ── Rechte Spalte: Live-Vorschau ─────────────────────────────── */}
      <div className="space-y-3">
        <Card>
          <CardHeader><CardTitle className="text-sm">Vorschau</CardTitle></CardHeader>
          <div className="px-4 pb-4">
            <DiscordEmbedPreview data={previewData} channels={channelNames} />
            <ComponentPreview form={form} options={options} roleName={roleName} />
          </div>
        </Card>
      </div>
    </div>
  );
}

// ── Komponenten-Vorschau (Buttons/Select/Reaktionen) ──────────────────────
function ComponentPreview({ form, options, roleName }: { form: MenuForm; options: OptionForm[]; roleName: (id: string) => string }) {
  const active = options.filter(o => o.isActive);
  if (active.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {form.componentType === 'BUTTON' && active.map((o, i) => (
        <span key={i} className="inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-sm text-white" style={{ backgroundColor: BUTTON_STYLE_COLORS[o.buttonStyle] }}>
          {o.emoji && <span>{o.emoji}</span>}{o.label || roleName(o.roleId)}
        </span>
      ))}
      {form.componentType === 'SELECT' && (
        <div className="w-full rounded bg-[#1e1f22] border border-[#2b2d31] px-3 py-2 text-sm text-[#b5bac1] flex items-center gap-2">
          <MousePointerClick size={14} /> Rollen auswählen… ({active.length} Optionen)
        </div>
      )}
      {form.componentType === 'REACTION' && (
        <div className="flex flex-wrap gap-2">
          {active.map((o, i) => (
            <span key={i} className="inline-flex items-center gap-1 rounded bg-[#2b2d31] px-2 py-1 text-sm text-white">
              {o.emoji || '❓'} <span className="text-[#b5bac1] text-xs">{roleName(o.roleId)}</span>
            </span>
          ))}
        </div>
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
