import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { useToast } from '@/components/ui/Toast';
import { Settings, Trash2, Plus, X, RefreshCw } from 'lucide-react';

const SNOWFLAKE_RE = /^\d{17,20}$/;

interface SlotLite { id: string; slot: number; alias: string; alias5: string; status: string }

// ----------------------------------------------------------------------------
// Top-Level Wrapper mit Slot-Picker (Backend ist slot-scoped via ?slot=X)
// ----------------------------------------------------------------------------
export function FactionsTab({ guildId, slots }: { guildId: string; slots: SlotLite[] }) {
  const usable = slots.filter(s => s.status === 'ACTIVE');
  const [slot, setSlot] = useState<string>(() => {
    if (usable.length === 0) return '';
    return String(usable[0].slot);
  });

  if (slots.length === 0) {
    return (
      <Card glow>
        <CardHeader><CardTitle>Keine Slots vorhanden</CardTitle></CardHeader>
        <p className="text-muted text-sm">Lege zuerst einen Nitrado-Slot an, bevor du Fraktionen verwalten kannst.</p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h2 className="text-lg font-semibold text-white">Fraktionssystem</h2>
          <p className="text-xs text-muted">Fraktionen werden pro Slot gepflegt. Wähle einen Slot zur Bearbeitung.</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-muted">Slot:</span>
          <Select value={slot} onChange={e => setSlot(e.target.value)} className="w-56">
            {slots.map(s => (
              <option key={s.id} value={String(s.slot)}>
                #{s.slot} — {s.alias || `Slot ${s.slot}`} ({s.status})
              </option>
            ))}
          </Select>
        </div>
      </div>

      {slot && <FactionsPanel guildId={guildId} slot={slot} />}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Faction-Types
// ----------------------------------------------------------------------------
interface FactionRow {
  id: string;
  name: string;
  flagUrl: string | null;
  bannerUrl: string | null;
  mediaUrl: string | null;
  description: string | null;
  color: string | null;
  leaderDiscordId: string | null;
  deputyDiscordId: string | null;
  treasurerDiscordId: string | null;
  embedChannelId: string | null;
  embedMessageId: string | null;
  roleId: string | null;
  joinPolicy: string;
  status: string;
  isActive: boolean;
  memberCount: number;
  members: Array<{ userDiscordId: string; role: string; joinedAt: string }>;
  createdAt: string;
  updatedAt: string;
}

interface FactionDraft {
  name: string;
  description: string;
  color: string;
  flagUrl: string;
  bannerUrl: string;
  mediaUrl: string;
  leaderDiscordId: string;
  deputyDiscordId: string;
  treasurerDiscordId: string;
  embedChannelId: string;
  roleId: string;
  joinPolicy: string;
  status: string;
}

const EMPTY_DRAFT: FactionDraft = {
  name: '', description: '', color: '#dc2626',
  flagUrl: '', bannerUrl: '', mediaUrl: '',
  leaderDiscordId: '', deputyDiscordId: '', treasurerDiscordId: '', embedChannelId: '', roleId: '',
  joinPolicy: 'REQUEST', status: 'ACTIVE',
};

const STATUS_OPTIONS: Array<[string, string]> = [
  ['ACTIVE', '🟢 Aktiv'],
  ['RECRUITING', '🟡 Rekrutiert'],
  ['INACTIVE', '⚪ Inaktiv'],
  ['ARCHIVED', '⚫ Archiviert'],
];

const PRESET_COLORS = ['#dc2626', '#ea580c', '#facc15', '#16a34a', '#0ea5e9', '#7c3aed', '#db2777', '#475569'];

function draftFromRow(f: FactionRow): FactionDraft {
  return {
    name: f.name,
    description: f.description ?? '',
    color: f.color ?? '#dc2626',
    flagUrl: f.flagUrl ?? '',
    bannerUrl: f.bannerUrl ?? '',
    mediaUrl: f.mediaUrl ?? '',
    leaderDiscordId: f.leaderDiscordId ?? '',
    deputyDiscordId: f.deputyDiscordId ?? '',
    treasurerDiscordId: f.treasurerDiscordId ?? '',
    embedChannelId: f.embedChannelId ?? '',
    roleId: f.roleId ?? '',
    joinPolicy: f.joinPolicy,
    status: f.status,
  };
}

interface FactionChannelOption { id: string; name: string; type: number }
interface FactionRoleOption { id: string; name: string; color: string; assignable: boolean }
interface FactionMemberOption {
  id: string;
  username: string | null;
  globalName: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  bot?: boolean;
}

function FactionChannelSelect({ guildId, value, onChange, allowEmpty = true, placeholder }: {
  guildId: string;
  value: string;
  onChange: (id: string) => void;
  allowEmpty?: boolean;
  placeholder?: string;
}) {
  const q = useQuery({
    queryKey: ['factionChannels', guildId],
    queryFn: () => api.get<{ channels: FactionChannelOption[] }>(`/api/v2/guilds/${guildId}/factions/lookups/channels`),
    staleTime: 60_000,
  });
  return (
    <select
      className="w-full bg-bg-elev border border-border rounded-md px-2 py-1.5 text-sm text-white"
      value={value}
      onChange={e => onChange(e.target.value)}
    >
      {allowEmpty && <option value="">{placeholder ?? '— nicht gesetzt —'}</option>}
      {q.data?.channels.map(c => (
        <option key={c.id} value={c.id}>#{c.name}</option>
      ))}
    </select>
  );
}

function FactionRoleSelect({ guildId, value, onChange, placeholder }: {
  guildId: string;
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
}) {
  const q = useQuery({
    queryKey: ['factionRoles', guildId],
    queryFn: () => api.get<{ roles: FactionRoleOption[] }>(`/api/v2/guilds/${guildId}/factions/lookups/roles`),
    staleTime: 60_000,
  });
  return (
    <select
      className="w-full bg-bg-elev border border-border rounded-md px-2 py-1.5 text-sm text-white"
      value={value}
      onChange={e => onChange(e.target.value)}
    >
      <option value="">{placeholder ?? '— keine Rolle —'}</option>
      {q.data?.roles.map(r => (
        <option key={r.id} value={r.id} disabled={!r.assignable}>
          {r.name}{r.assignable ? '' : ' (Bot kann nicht zuweisen)'}
        </option>
      ))}
    </select>
  );
}

/**
 * Member-Combobox: Suche per /factions/lookups/members?q=, speichert Discord-Snowflake.
 * Ohne Eingabe wird der gespeicherte User via /lookups/members/:id aufgeloest und angezeigt.
 */
function MemberCombobox({ guildId, value, onChange, placeholder, allowClear = true }: {
  guildId: string;
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
  allowClear?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const search = useQuery({
    queryKey: ['factionMemberSearch', guildId, debounced],
    queryFn: () => api.get<{ members: FactionMemberOption[] }>(`/api/v2/guilds/${guildId}/factions/lookups/members?q=${encodeURIComponent(debounced)}`),
    enabled: open,
    staleTime: 15_000,
  });

  const selected = useQuery({
    queryKey: ['factionMember', guildId, value],
    queryFn: () => api.get<FactionMemberOption>(`/api/v2/guilds/${guildId}/factions/lookups/members/${value}`),
    enabled: !!value && SNOWFLAKE_RE.test(value),
    staleTime: 5 * 60_000,
  });

  const label = value
    ? (selected.data?.displayName || selected.data?.globalName || selected.data?.username || `ID ${value}`)
    : '';

  return (
    <div className="relative">
      <div className="flex items-center gap-2">
        {value && selected.data?.avatarUrl && (
          <img src={selected.data.avatarUrl} alt="" className="h-7 w-7 rounded-full flex-shrink-0" />
        )}
        <input
          type="text"
          className="flex-1 bg-bg-elev border border-border rounded-md px-2 py-1.5 text-sm text-white placeholder:text-muted focus:outline-none focus:border-accent"
          placeholder={placeholder ?? 'User suchen…'}
          value={open ? query : label}
          onFocus={() => { setOpen(true); setQuery(''); }}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onChange={e => setQuery(e.target.value)}
        />
        {value && allowClear && (
          <button
            type="button"
            className="text-muted hover:text-white text-xs px-2"
            onMouseDown={e => { e.preventDefault(); onChange(''); setQuery(''); }}
            title="Leeren"
          >×</button>
        )}
      </div>
      {open && (
        <div className="absolute z-20 left-0 right-0 mt-1 bg-bg-elev border border-border rounded-md shadow-lg max-h-64 overflow-auto">
          {search.isLoading && <div className="px-3 py-2 text-xs text-muted">Suche…</div>}
          {!search.isLoading && (search.data?.members?.length ?? 0) === 0 && (
            <div className="px-3 py-2 text-xs text-muted">{debounced.length < 2 ? 'Tippe min. 2 Zeichen…' : 'Keine Treffer.'}</div>
          )}
          {search.data?.members.filter(m => !m.bot).map(m => (
            <button
              key={m.id}
              type="button"
              className="w-full flex items-center gap-2 px-2 py-1.5 hover:bg-black/20 text-left"
              onMouseDown={e => { e.preventDefault(); onChange(m.id); setOpen(false); setQuery(''); }}
            >
              {m.avatarUrl && <img src={m.avatarUrl} alt="" className="h-6 w-6 rounded-full" />}
              <div className="min-w-0">
                <div className="text-sm text-white truncate">{m.displayName || m.globalName || m.username}</div>
                <div className="text-xs text-muted truncate">@{m.username} · {m.id}</div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface FactionSystemConfigDto {
  slotId: string;
  factionChannelId: string | null;
  listMessageId: string | null;
  updatedAt: string;
}

function FactionSystemConfigCard({ guildId, slot }: { guildId: string; slot: string }) {
  const qc = useQueryClient();
  const qs = `?slot=${slot}`;
  const cfg = useQuery({
    queryKey: ['factionSystemConfig', guildId, slot],
    queryFn: () => api.get<FactionSystemConfigDto>(`/api/v2/guilds/${guildId}/factions/system-config${qs}`),
  });
  const [draftCh, setDraftCh] = useState<string>('');
  useEffect(() => {
    if (cfg.data) setDraftCh(cfg.data.factionChannelId ?? '');
  }, [cfg.data]);

  const save = useMutation({
    mutationFn: (chId: string | null) =>
      api.put(`/api/v2/guilds/${guildId}/factions/system-config${qs}`, { factionChannelId: chId }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['factionSystemConfig', guildId, slot] });
      void qc.invalidateQueries({ queryKey: ['factions', guildId, slot] });
    },
  });

  const dirty = (cfg.data?.factionChannelId ?? '') !== draftCh;

  return (
    <div className="rounded-md border border-border bg-bg-elev p-3 mb-4">
      <p className="text-sm text-white font-medium mb-1">Sammel-Channel (Server-weit)</p>
      <p className="text-xs text-muted mb-2">
        Server-Default: Fraktionen ohne <em>eigenen</em> Embed-Channel werden hier gepostet.
        Zusätzlich pflegt der Bot hier eine automatisch aktualisierte Übersichtsliste aller Fraktionen.
      </p>
      <div className="flex gap-2 items-center">
        <div className="flex-1">
          <FactionChannelSelect
            guildId={guildId}
            value={draftCh}
            onChange={setDraftCh}
            placeholder="— kein Sammel-Channel —"
          />
        </div>
        <Button
          size="sm"
          disabled={!dirty || save.isPending}
          onClick={() => save.mutate(draftCh || null)}
        >
          {save.isPending ? 'Speichere…' : 'Speichern'}
        </Button>
      </div>
      {save.error && <p className="text-red-400 text-xs mt-1">{(save.error as Error).message}</p>}
      {cfg.data?.listMessageId && (
        <p className="text-xs text-muted mt-1">📌 Übersicht aktiv (msg {cfg.data.listMessageId.slice(0, 8)}…)</p>
      )}
    </div>
  );
}

function FactionMemberInline({ guildId, userId }: { guildId: string; userId: string }) {
  const q = useQuery({
    queryKey: ['factionMember', guildId, userId],
    queryFn: () => api.get<FactionMemberOption>(`/api/v2/guilds/${guildId}/factions/lookups/members/${userId}`),
    enabled: !!userId && SNOWFLAKE_RE.test(userId),
    staleTime: 5 * 60_000,
  });
  const label = q.data?.displayName || q.data?.globalName || q.data?.username || `ID ${userId}`;
  return (
    <div className="flex items-center gap-2 min-w-0">
      {q.data?.avatarUrl
        ? <img src={q.data.avatarUrl} alt="" className="h-6 w-6 rounded-full flex-shrink-0" />
        : <div className="h-6 w-6 rounded-full bg-black/40 flex-shrink-0" />}
      <span className="text-sm text-white truncate">{label}</span>
    </div>
  );
}

function FactionsPanel({ guildId, slot }: { guildId: string; slot: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const qs = `?slot=${slot}`;
  const [draft, setDraft] = useState<FactionDraft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [memberDraft, setMemberDraft] = useState<Record<string, { user: string; role: string }>>({});
  const [uploadErr, setUploadErr] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['factions', guildId, slot],
    queryFn: () => api.get<{ factions: FactionRow[] }>(`/api/v2/guilds/${guildId}/factions${qs}`),
  });

  const buildPayload = (b: FactionDraft) => ({
    name: b.name.trim(),
    description: b.description.trim() || null,
    color: b.color || null,
    flagUrl: b.flagUrl || null,
    bannerUrl: b.bannerUrl || null,
    mediaUrl: b.mediaUrl || null,
    leaderDiscordId: b.leaderDiscordId.trim() || null,
    deputyDiscordId: b.deputyDiscordId.trim() || null,
    treasurerDiscordId: b.treasurerDiscordId.trim() || null,
    embedChannelId: b.embedChannelId.trim() || null,
    roleId: b.roleId.trim() || null,
    joinPolicy: b.joinPolicy,
    status: b.status,
  });

  const create = useMutation({
    mutationFn: (b: FactionDraft) => api.post(`/api/v2/guilds/${guildId}/factions${qs}`, buildPayload(b)),
    onSuccess: () => {
      setDraft(EMPTY_DRAFT);
      void qc.invalidateQueries({ queryKey: ['factions', guildId, slot] });
      toast.success('Fraktion erstellt.');
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Erstellen fehlgeschlagen.'),
  });

  const update = useMutation({
    mutationFn: (vars: { id: string; b: FactionDraft }) =>
      api.patch(`/api/v2/guilds/${guildId}/factions/${vars.id}${qs}`, buildPayload(vars.b)),
    onSuccess: () => {
      setEditingId(null);
      setDraft(EMPTY_DRAFT);
      void qc.invalidateQueries({ queryKey: ['factions', guildId, slot] });
      toast.success('Fraktion gespeichert.');
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Speichern fehlgeschlagen.'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/v2/guilds/${guildId}/factions/${id}${qs}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['factions', guildId, slot] });
      toast.success('Fraktion geloescht.');
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Loeschen fehlgeschlagen.'),
  });

  const republish = useMutation({
    mutationFn: (id: string) => api.post(`/api/v2/guilds/${guildId}/factions/${id}/republish${qs}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['factions', guildId, slot] });
      toast.success('Embed neu gepostet.');
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Republish fehlgeschlagen.'),
  });

  const addMember = useMutation({
    mutationFn: (vars: { factionId: string; user: string; role: string }) =>
      api.post(`/api/v2/guilds/${guildId}/factions/${vars.factionId}/members${qs}`, {
        userDiscordId: vars.user, role: vars.role,
      }),
    onSuccess: (_d, vars) => {
      setMemberDraft(s => ({ ...s, [vars.factionId]: { user: '', role: 'MEMBER' } }));
      void qc.invalidateQueries({ queryKey: ['factions', guildId, slot] });
      toast.success('Mitglied hinzugefuegt.');
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Hinzufuegen fehlgeschlagen.'),
  });

  const removeMember = useMutation({
    mutationFn: (vars: { factionId: string; userDiscordId: string }) =>
      api.del(`/api/v2/guilds/${guildId}/factions/${vars.factionId}/members/${vars.userDiscordId}${qs}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['factions', guildId, slot] });
      toast.success('Mitglied entfernt.');
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Entfernen fehlgeschlagen.'),
  });

  async function handleUpload(field: 'flagUrl' | 'bannerUrl' | 'mediaUrl', file: File | null) {
    if (!file) return;
    setUploadErr(null);
    const kind = field === 'flagUrl' ? 'flag' : field === 'bannerUrl' ? 'banner' : 'media';
    try {
      const r = await api.upload<{ url: string }>(`/api/v2/guilds/${guildId}/factions/upload${qs}&kind=${kind}`, file);
      setDraft(d => ({ ...d, [field]: r.url }));
    } catch (e) {
      setUploadErr((e as Error).message);
    }
  }

  const validId = (s: string) => !s || SNOWFLAKE_RE.test(s.trim());
  const formValid =
    draft.name.trim().length >= 2 && draft.name.trim().length <= 60
    && validId(draft.leaderDiscordId)
    && validId(draft.deputyDiscordId)
    && validId(draft.treasurerDiscordId)
    && validId(draft.embedChannelId);

  function startEdit(f: FactionRow) {
    setEditingId(f.id);
    setDraft(draftFromRow(f));
    setUploadErr(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
    setUploadErr(null);
  }

  return (
    <Card>
      <CardHeader><CardTitle>Fraktionssystem</CardTitle></CardHeader>
      <FactionSystemConfigCard guildId={guildId} slot={slot} />
      {list.isLoading && <p className="text-muted">Lade…</p>}
      {list.error && <p className="text-red-400 text-sm">{(list.error as Error).message}</p>}

      {/* Liste bestehender Fraktionen */}
      <div className="space-y-2 mb-6">
        {list.data?.factions.length === 0 && <p className="text-muted text-sm">Keine Fraktionen.</p>}
        {list.data?.factions.map(f => {
          const statusLabel = STATUS_OPTIONS.find(([k]) => k === f.status)?.[1] ?? f.status;
          return (
            <div key={f.id} className="bg-bg-elev rounded-md border border-border p-3 space-y-2"
                 style={f.color ? { borderLeft: `4px solid ${f.color}` } : undefined}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3 min-w-0">
                  {f.flagUrl
                    ? <img src={f.flagUrl} alt="" className="h-10 w-10 rounded object-cover bg-black flex-shrink-0" />
                    : <div className="h-10 w-10 rounded bg-black/40 flex-shrink-0 flex items-center justify-center text-muted text-xs">—</div>}
                  <div className="min-w-0">
                    <p className="text-white font-medium truncate">{f.name}</p>
                    <p className="text-muted text-xs">
                      {statusLabel} · {f.joinPolicy} · {f.memberCount} Mitglieder
                      {f.embedChannelId && f.embedMessageId ? ' · 📌 Embed live' : f.embedChannelId ? ' · ⚠ Embed nicht gepostet' : ''}
                    </p>
                  </div>
                </div>
                <div className="flex gap-1 flex-shrink-0">
                  {f.embedChannelId && (
                    <Button size="sm" variant="ghost" onClick={() => republish.mutate(f.id)} disabled={republish.isPending}>
                      <RefreshCw className="h-3 w-3" />
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => startEdit(f)}>
                    <Settings className="h-3 w-3" />
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => { if (confirm(`Fraktion "${f.name}" wirklich loeschen?`)) remove.mutate(f.id); }}>
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>

              <div className="flex gap-2 pt-2 border-t border-border items-center">
                <div className="flex-1">
                  <MemberCombobox
                    guildId={guildId}
                    value={memberDraft[f.id]?.user ?? ''}
                    onChange={uid => setMemberDraft(s => ({ ...s, [f.id]: { user: uid, role: s[f.id]?.role ?? 'MEMBER' } }))}
                    placeholder="Mitglied suchen…"
                  />
                </div>
                <Select
                  value={memberDraft[f.id]?.role ?? 'MEMBER'}
                  onChange={e => setMemberDraft(s => ({ ...s, [f.id]: { user: s[f.id]?.user ?? '', role: e.target.value } }))}
                  className="w-32"
                >
                  <option value="MEMBER">MEMBER</option>
                  <option value="LEADER">LEADER</option>
                  <option value="TREASURER">TREASURER</option>
                  <option value="PENDING">PENDING</option>
                </Select>
                <Button
                  size="sm"
                  disabled={!SNOWFLAKE_RE.test(memberDraft[f.id]?.user ?? '') || addMember.isPending}
                  onClick={() => addMember.mutate({
                    factionId: f.id,
                    user: memberDraft[f.id]?.user ?? '',
                    role: memberDraft[f.id]?.role ?? 'MEMBER',
                  })}
                  aria-label="Mitglied hinzufuegen"
                >
                  <Plus className="h-3 w-3" />
                </Button>
              </div>

              {/* Mitglieder-Liste mit Remove direkt in der Karte (nicht nur im Edit-Modus). */}
              {f.members.length > 0 && (
                <div className="pt-2 border-t border-border">
                  <p className="text-[11px] uppercase tracking-wider text-muted mb-1">Mitglieder ({f.members.length})</p>
                  <div className="space-y-1 max-h-40 overflow-y-auto">
                    {f.members.map(m => (
                      <div key={m.userDiscordId} className="flex items-center justify-between gap-2 px-2 py-1 rounded bg-black/30">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-[10px] text-muted w-20 flex-shrink-0 font-mono">{m.role}</span>
                          <FactionMemberInline guildId={guildId} userId={m.userDiscordId} />
                        </div>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            if (confirm(`Mitglied wirklich aus "${f.name}" entfernen?`)) {
                              removeMember.mutate({ factionId: f.id, userDiscordId: m.userDiscordId });
                            }
                          }}
                          disabled={removeMember.isPending}
                          title="Mitglied entfernen"
                          aria-label={`Mitglied ${m.userDiscordId} entfernen`}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Form: Neue Fraktion ODER Bearbeiten */}
      <div className="border-t border-border pt-4 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-sm text-white/80">{editingId ? 'Fraktion bearbeiten' : 'Neue Fraktion'}</p>
          <div className="flex gap-2">
            {editingId && (
              <Button
                size="sm"
                variant="danger"
                onClick={() => {
                  if (editingId && confirm('Diese Fraktion wirklich löschen? Alle Mitgliedschaften werden entfernt.')) {
                    remove.mutate(editingId);
                    cancelEdit();
                  }
                }}
              >
                <Trash2 className="h-3 w-3 mr-1" />Fraktion löschen
              </Button>
            )}
            {editingId && <Button size="sm" variant="ghost" onClick={cancelEdit}><X className="h-3 w-3 mr-1" />Abbrechen</Button>}
          </div>
        </div>

        <div className="grid gap-2 md:grid-cols-2">
          <Input
            placeholder="Fraktionsname * (2-60)"
            value={draft.name}
            onChange={e => setDraft({ ...draft, name: e.target.value })}
            maxLength={60}
          />
          <Select value={draft.status} onChange={e => setDraft({ ...draft, status: e.target.value })}>
            {STATUS_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select>

          <Select value={draft.joinPolicy} onChange={e => setDraft({ ...draft, joinPolicy: e.target.value })}>
            <option value="OPEN">🔓 OPEN — direkter Beitritt</option>
            <option value="REQUEST">✋ REQUEST — Bewerbung erforderlich</option>
            <option value="CLOSED">🔒 CLOSED — nur Einladung</option>
          </Select>
          <div>
            <span className="block text-xs text-muted mb-1">Eigener Embed-Channel (optional)</span>
            <FactionChannelSelect
              guildId={guildId}
              value={draft.embedChannelId}
              onChange={id => setDraft({ ...draft, embedChannelId: id })}
              placeholder="— Server-Sammel-Channel nutzen —"
            />
          </div>

          <div>
            <span className="block text-xs text-muted mb-1">Leitung</span>
            <MemberCombobox
              guildId={guildId}
              value={draft.leaderDiscordId}
              onChange={id => setDraft({ ...draft, leaderDiscordId: id })}
              placeholder="User suchen…"
            />
          </div>
          <div>
            <span className="block text-xs text-muted mb-1">Stellvertretung</span>
            <MemberCombobox
              guildId={guildId}
              value={draft.deputyDiscordId}
              onChange={id => setDraft({ ...draft, deputyDiscordId: id })}
              placeholder="User suchen…"
            />
          </div>
          <div>
            <span className="block text-xs text-muted mb-1">Schatzmeister</span>
            <MemberCombobox
              guildId={guildId}
              value={draft.treasurerDiscordId}
              onChange={id => setDraft({ ...draft, treasurerDiscordId: id })}
              placeholder="User suchen…"
            />
          </div>
          <div>
            <span className="block text-xs text-muted mb-1">Fraktionsrolle (optional)</span>
            <FactionRoleSelect
              guildId={guildId}
              value={draft.roleId}
              onChange={id => setDraft({ ...draft, roleId: id })}
              placeholder="— keine Rolle —"
            />
          </div>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={draft.color}
              onChange={e => setDraft({ ...draft, color: e.target.value })}
              className="h-9 w-12 rounded border border-border bg-transparent cursor-pointer"
              title="Fraktionsfarbe"
            />
            <div className="flex gap-1">
              {PRESET_COLORS.map(c => (
                <button
                  key={c} type="button"
                  onClick={() => setDraft({ ...draft, color: c })}
                  className="h-6 w-6 rounded border border-border"
                  style={{ background: c }}
                  title={c}
                />
              ))}
            </div>
          </div>
        </div>

        <textarea
          placeholder="Beschreibung (optional, max. 1000 Zeichen)"
          value={draft.description}
          onChange={e => setDraft({ ...draft, description: e.target.value })}
          maxLength={1000}
          rows={3}
          className="w-full rounded-md bg-bg-elev border border-border px-3 py-2 text-sm text-white placeholder:text-muted focus:outline-none focus:border-accent"
        />

        {editingId && (() => {
          const editingFaction = list.data?.factions.find(x => x.id === editingId);
          if (!editingFaction) return null;
          return (
            <div className="rounded-md border border-border bg-bg-elev p-3 space-y-2">
              <p className="text-sm text-white font-medium">Mitglieder ({editingFaction.members.length})</p>
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {editingFaction.members.length === 0 && (
                  <p className="text-xs text-muted">Noch keine Mitglieder hinzugefuegt.</p>
                )}
                {editingFaction.members.map(m => (
                  <div key={m.userDiscordId} className="flex items-center justify-between gap-2 px-2 py-1 rounded bg-black/30">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-xs text-muted w-20 flex-shrink-0">{m.role}</span>
                      <FactionMemberInline guildId={guildId} userId={m.userDiscordId} />
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => removeMember.mutate({ factionId: editingId, userDiscordId: m.userDiscordId })}
                      disabled={removeMember.isPending}
                      title="Mitglied entfernen"
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
              </div>
              <div className="flex gap-2 items-center pt-2 border-t border-border">
                <div className="flex-1">
                  <MemberCombobox
                    guildId={guildId}
                    value={memberDraft[editingId]?.user ?? ''}
                    onChange={uid => setMemberDraft(s => ({ ...s, [editingId]: { user: uid, role: s[editingId]?.role ?? 'MEMBER' } }))}
                    placeholder="Mitglied suchen…"
                  />
                </div>
                <Select
                  value={memberDraft[editingId]?.role ?? 'MEMBER'}
                  onChange={e => setMemberDraft(s => ({ ...s, [editingId]: { user: s[editingId]?.user ?? '', role: e.target.value } }))}
                  className="w-32"
                >
                  <option value="MEMBER">MEMBER</option>
                  <option value="LEADER">LEADER</option>
                  <option value="TREASURER">TREASURER</option>
                  <option value="PENDING">PENDING</option>
                </Select>
                <Button
                  size="sm"
                  disabled={!SNOWFLAKE_RE.test(memberDraft[editingId]?.user ?? '') || addMember.isPending}
                  onClick={() => addMember.mutate({
                    factionId: editingId,
                    user: memberDraft[editingId]?.user ?? '',
                    role: memberDraft[editingId]?.role ?? 'MEMBER',
                  })}
                >
                  <Plus className="h-3 w-3 mr-1" />Hinzufuegen
                </Button>
              </div>
            </div>
          );
        })()}

        {/* Upload-Bereich */}
        <div className="grid gap-3 md:grid-cols-2">
          <FileUploadField
            label="Flagge (optional) — JPG, PNG, GIF, WEBP, MP4"
            currentUrl={draft.flagUrl}
            onUpload={f => handleUpload('flagUrl', f)}
            onClear={() => setDraft(d => ({ ...d, flagUrl: '' }))}
          />
          <FileUploadField
            label="Armbinde (optional) — JPG, PNG, GIF, WEBP, MP4"
            currentUrl={draft.bannerUrl}
            onUpload={f => handleUpload('bannerUrl', f)}
            onClear={() => setDraft(d => ({ ...d, bannerUrl: '' }))}
          />
        </div>

        {uploadErr && <p className="text-red-400 text-xs">{uploadErr}</p>}

        <div className="flex items-center gap-2">
          {editingId ? (
            <Button
              disabled={!formValid || update.isPending}
              onClick={() => update.mutate({ id: editingId, b: draft })}
            >
              {update.isPending ? 'Speichere…' : 'Speichern'}
            </Button>
          ) : (
            <Button
              disabled={!formValid || create.isPending}
              onClick={() => create.mutate(draft)}
            >
              {create.isPending ? 'Erstelle…' : 'Erstellen'}
            </Button>
          )}
          {(create.error || update.error) && (
            <p className="text-red-400 text-xs">{((create.error || update.error) as Error).message}</p>
          )}
        </div>
      </div>
    </Card>
  );
}

function FileUploadField({ label, currentUrl, onUpload, onClear }: {
  label: string;
  currentUrl: string;
  onUpload: (file: File) => void;
  onClear: () => void;
}) {
  const isVideo = currentUrl.endsWith('.mp4');
  return (
    <div className="space-y-2">
      <label className="text-xs text-muted block">{label}</label>
      <div className="flex items-center gap-2">
        <input
          type="file"
          accept="image/jpeg,image/png,image/gif,image/webp,video/mp4"
          onChange={e => { const f = e.target.files?.[0]; if (f) onUpload(f); e.target.value = ''; }}
          className="text-xs text-white file:mr-2 file:px-2 file:py-1 file:rounded file:border-0 file:bg-accent file:text-white file:cursor-pointer"
        />
        {currentUrl && (
          <Button size="sm" variant="ghost" onClick={onClear}><X className="h-3 w-3" /></Button>
        )}
      </div>
      {currentUrl && (
        <div className="flex items-center gap-2 text-xs text-muted">
          {isVideo
            ? <video src={currentUrl} className="h-12 w-12 rounded object-cover bg-black" muted />
            : <img src={currentUrl} alt="" className="h-12 w-12 rounded object-cover bg-black" />}
          <span className="truncate">{currentUrl}</span>
        </div>
      )}
    </div>
  );
}
