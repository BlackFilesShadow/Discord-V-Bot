import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { useToast } from '@/components/ui/Toast';

const base = '/api/v2/dev/command-center';
type Tab = 'diagnostics' | 'admins' | 'database' | 'config' | 'security' | 'xp' | 'commands';

function errorText(e: unknown): string {
  return e instanceof ApiError ? e.message : (e as Error)?.message ?? 'Unbekannter Fehler';
}
function JsonBlock({ value }: { value: unknown }) {
  return <pre className="text-[11px] whitespace-pre-wrap break-all bg-bg-elev rounded-md p-3 max-h-96 overflow-auto">{JSON.stringify(value, null, 2)}</pre>;
}
function StepUp({ reason, setReason, reAuth, setReAuth }: { reason: string; setReason: (v: string) => void; reAuth: string; setReAuth: (v: string) => void }) {
  return <div className="grid gap-2 md:grid-cols-2 mb-3"><Input value={reason} onChange={e => setReason(e.target.value)} placeholder="Begründung (mind. 6 Zeichen)"/><Input value={reAuth} onChange={e => setReAuth(e.target.value)} placeholder="DEV-Passwort oder TOTP" type="password" autoComplete="current-password"/></div>;
}

export default function CommandCenter() {
  const [tab, setTab] = useState<Tab>('diagnostics');
  const tabs: Array<[Tab, string]> = [
    ['diagnostics', 'Diagnostik'], ['admins', 'Admins'], ['database', 'Datenbank'], ['config', 'Konfiguration'],
    ['security', 'Security'], ['xp', 'XP-Konfiguration'], ['commands', 'Command Registry'],
  ];
  return <div className="space-y-4">
    <Card glow><h1 className="text-lg font-semibold">DEV Command Center</h1><p className="text-sm text-muted mt-1">Dashboard-Ersatz der ehemaligen DEV-Slash-Commands. Hersteller-Funktionen bleiben bewusst in Discord. Sensible Mutationen werden zentral serverseitig erneut authentisiert. Sensible Exporte besitzen einen getrennten, POST-only geschützten DEV-Bereich.</p><div className="flex flex-wrap gap-2 mt-4">{tabs.map(([key, label]) => <Button key={key} size="sm" variant={tab === key ? 'primary' : 'ghost'} onClick={() => setTab(key)}>{label}</Button>)}</div></Card>
    {tab === 'diagnostics' && <Diagnostics/>}
    {tab === 'admins' && <Admins/>}
    {tab === 'database' && <DatabaseTools/>}
    {tab === 'config' && <ConfigTools/>}
    {tab === 'security' && <SecurityTools/>}
    {tab === 'xp' && <XpTools/>}
    {tab === 'commands' && <CommandReload/>}
  </div>;
}

function Diagnostics() {
  const q = useQuery({ queryKey: [base, 'diagnostics'], queryFn: () => api.get<Record<string, unknown>>(`${base}/diagnostics`), refetchInterval: 15_000 });
  return <Card glow><div className="flex justify-between gap-3"><div><h2 className="font-semibold">Ping / Status / Dev-Eval</h2><p className="text-xs text-muted">WebSocket, Uptime, DB-Roundtrip, Cache, CPU/RAM und Prozessspeicher.</p></div><Button size="sm" variant="ghost" onClick={() => q.refetch()}>Aktualisieren</Button></div><div className="mt-3">{q.isError ? <p className="text-danger">{errorText(q.error)}</p> : <JsonBlock value={q.data ?? {}}/>}</div></Card>;
}

function Admins() {
  const qc = useQueryClient(); const toast = useToast();
  const [discordId, setDiscordId] = useState(''); const [reason, setReason] = useState('Adminverwaltung'); const [reAuth, setReAuth] = useState('');
  const q = useQuery({ queryKey: [base, 'admins'], queryFn: () => api.get<{ items: Array<{ id: string; discordId: string; username: string; role: string }> }>(`${base}/admins`) });
  const add = useMutation({ mutationFn: () => api.post(`${base}/admins`, { discordId, reason, reAuth }), onSuccess: () => { toast.success('Admin hinzugefügt'); void qc.invalidateQueries({ queryKey: [base, 'admins'] }); }, onError: e => toast.error('Fehler', errorText(e)) });
  const remove = useMutation({ mutationFn: (id: string) => api.del(`${base}/admins/${id}`, { reason, reAuth }), onSuccess: () => { toast.success('Admin entfernt'); void qc.invalidateQueries({ queryKey: [base, 'admins'] }); }, onError: e => toast.error('Fehler', errorText(e)) });
  return <Card glow><h2 className="font-semibold mb-3">Admin-Rollen</h2><StepUp reason={reason} setReason={setReason} reAuth={reAuth} setReAuth={setReAuth}/><div className="flex flex-col gap-2 sm:flex-row"><Input value={discordId} onChange={e => setDiscordId(e.target.value)} placeholder="Discord-ID"/><Button size="sm" onClick={() => add.mutate()} disabled={!discordId}>ADMIN hinzufügen</Button></div><div className="space-y-2 mt-4">{(q.data?.items ?? []).map(a => <div key={a.id} className="flex flex-col items-start justify-between gap-2 border border-border rounded-md p-2 sm:flex-row sm:items-center"><span><b>{a.username}</b> <span className="text-muted text-xs break-all">{a.discordId} · {a.role}</span></span>{a.role === 'ADMIN' && <Button size="sm" variant="danger" onClick={() => remove.mutate(a.discordId)}>Entfernen</Button>}</div>)}</div></Card>;
}

function DatabaseTools() {
  const toast = useToast();
  const [userQ, setUserQ] = useState(''); const [pkgQ, setPkgQ] = useState(''); const [reason, setReason] = useState('Datenbank Cleanup'); const [reAuth, setReAuth] = useState('');
  const stats = useQuery({ queryKey: [base, 'database'], queryFn: () => api.get<Record<string, unknown>>(`${base}/database`) });
  const users = useQuery({ queryKey: [base, 'db-users', userQ], queryFn: () => api.get(`${base}/database/users?q=${encodeURIComponent(userQ)}`), enabled: userQ.length > 0 });
  const packages = useQuery({ queryKey: [base, 'db-packages', pkgQ], queryFn: () => api.get(`${base}/database/packages?q=${encodeURIComponent(pkgQ)}`), enabled: pkgQ.length > 0 });
  const cleanup = useMutation({ mutationFn: () => api.post(`${base}/database/cleanup`, { reason, reAuth }), onSuccess: data => { toast.success('Cleanup abgeschlossen', JSON.stringify(data)); void stats.refetch(); }, onError: e => toast.error('Cleanup fehlgeschlagen', errorText(e)) });
  return <div className="space-y-4"><Card><h2 className="font-semibold mb-3">Datenbankübersicht</h2><JsonBlock value={stats.data ?? {}}/></Card><Card><h2 className="font-semibold mb-3">User-/Paket-Suche</h2><div className="grid gap-2 md:grid-cols-2"><Input value={userQ} onChange={e => setUserQ(e.target.value)} placeholder="Username / Discord-ID / E-Mail"/><Input value={pkgQ} onChange={e => setPkgQ(e.target.value)} placeholder="Paketname"/></div><div className="grid gap-3 md:grid-cols-2 mt-3"><JsonBlock value={users.data ?? {}}/><JsonBlock value={packages.data ?? {}}/></div></Card><Card glow><h2 className="font-semibold mb-3">Abgelaufene Sessions / OTPs bereinigen</h2><StepUp reason={reason} setReason={setReason} reAuth={reAuth} setReAuth={setReAuth}/><Button size="sm" variant="danger" onClick={() => cleanup.mutate()} loading={cleanup.isPending}>Cleanup ausführen</Button></Card></div>;
}

interface ConfigResponse { allowedKeys: string[]; items: unknown[] }
function ConfigTools() {
  const qc = useQueryClient(); const toast = useToast();
  const [key, setKey] = useState(''); const [value, setValue] = useState(''); const [description, setDescription] = useState(''); const [reason, setReason] = useState('Konfiguration ändern'); const [reAuth, setReAuth] = useState('');
  const q = useQuery({ queryKey: [base, 'config'], queryFn: () => api.get<ConfigResponse>(`${base}/config`) });
  const save = useMutation({ mutationFn: () => api.put(`${base}/config/${encodeURIComponent(key)}`, { value, description, reason, reAuth }), onSuccess: () => { toast.success('Konfiguration gespeichert'); void qc.invalidateQueries({ queryKey: [base, 'config'] }); }, onError: e => toast.error('Fehler', errorText(e)) });
  const del = useMutation({ mutationFn: () => api.del(`${base}/config/${encodeURIComponent(key)}`, { reason, reAuth }), onSuccess: () => { toast.success('Konfiguration gelöscht'); void qc.invalidateQueries({ queryKey: [base, 'config'] }); }, onError: e => toast.error('Fehler', errorText(e)) });
  return <Card glow><h2 className="font-semibold mb-3">Live-Konfiguration</h2><StepUp reason={reason} setReason={setReason} reAuth={reAuth} setReAuth={setReAuth}/><div className="grid gap-2 md:grid-cols-3"><Select value={key} onChange={e => setKey(e.target.value)}><option value="">— Schlüssel —</option>{(q.data?.allowedKeys ?? []).map(k => <option key={k} value={k}>{k}</option>)}</Select><Input value={value} onChange={e => setValue(e.target.value)} placeholder="Wert (JSON oder Text)"/><Input value={description} onChange={e => setDescription(e.target.value)} placeholder="Beschreibung optional"/></div><div className="flex flex-wrap gap-2 mt-2"><Button size="sm" onClick={() => save.mutate()} disabled={!key}>Setzen</Button><Button size="sm" variant="danger" onClick={() => del.mutate()} disabled={!key}>Löschen</Button></div><div className="mt-4"><JsonBlock value={q.data?.items ?? []}/></div></Card>;
}

function SecurityTools() {
  const qc = useQueryClient(); const toast = useToast();
  const [ip, setIpValue] = useState(''); const [listType, setListType] = useState('BLACKLIST'); const [listReason, setListReason] = useState(''); const [hours, setHours] = useState('0'); const [eventId, setEventId] = useState(''); const [reason, setReason] = useState('Security Änderung'); const [reAuth, setReAuth] = useState('');
  const q = useQuery({ queryKey: [base, 'security'], queryFn: () => api.get<Record<string, unknown>>(`${base}/security`) });
  const setIpMutation = useMutation({ mutationFn: () => api.put(`${base}/security/ip/${encodeURIComponent(ip)}`, { listType, listReason, durationHours: Number(hours), reason, reAuth }), onSuccess: () => { toast.success('IP-Liste aktualisiert'); void qc.invalidateQueries({ queryKey: [base, 'security'] }); }, onError: e => toast.error('Fehler', errorText(e)) });
  const removeIp = useMutation({ mutationFn: () => api.del(`${base}/security/ip/${encodeURIComponent(ip)}`, { reason, reAuth }), onSuccess: () => { toast.success('IP entfernt'); void qc.invalidateQueries({ queryKey: [base, 'security'] }); }, onError: e => toast.error('Fehler', errorText(e)) });
  const resolve = useMutation({ mutationFn: () => api.post(`${base}/security/events/${eventId}/resolve`, { reason, reAuth }), onSuccess: () => { toast.success('Event gelöst'); void qc.invalidateQueries({ queryKey: [base, 'security'] }); }, onError: e => toast.error('Fehler', errorText(e)) });
  return <div className="space-y-4"><Card glow><h2 className="font-semibold mb-3">IP Black-/Whitelist & Event-Auflösung</h2><StepUp reason={reason} setReason={setReason} reAuth={reAuth} setReAuth={setReAuth}/><div className="grid gap-2 md:grid-cols-4"><Input value={ip} onChange={e => setIpValue(e.target.value)} placeholder="IPv4 / IPv6"/><Select value={listType} onChange={e => setListType(e.target.value)}><option value="BLACKLIST">BLACKLIST</option><option value="WHITELIST">WHITELIST</option></Select><Input value={listReason} onChange={e => setListReason(e.target.value)} placeholder="Listen-Begründung"/><Input value={hours} onChange={e => setHours(e.target.value)} type="number" placeholder="Stunden (0=permanent)"/></div><div className="flex flex-wrap gap-2 mt-2"><Button size="sm" onClick={() => setIpMutation.mutate()} disabled={!ip}>IP setzen</Button><Button size="sm" variant="danger" onClick={() => removeIp.mutate()} disabled={!ip}>IP entfernen</Button></div><div className="flex flex-col gap-2 mt-4 sm:flex-row"><Input value={eventId} onChange={e => setEventId(e.target.value)} placeholder="SecurityEvent-ID"/><Button size="sm" onClick={() => resolve.mutate()} disabled={!eventId}>Event als gelöst markieren</Button></div></Card><Card><JsonBlock value={q.data ?? {}}/></Card></div>;
}

interface GuildRow { id: string; name: string; botPresent: boolean }
interface XpConfigView {
  id: string;
  messageXpMin: number;
  messageXpMax: number;
  voiceXpPerMinute: number;
  levelMultiplier: number;
  maxLevel: number;
  maxLevelRoleId: string | null;
  allowedRoleIds: string[];
  allowedChannelIds: string[];
}
interface XpData {
  config: XpConfigView;
  levelRoles: Array<{ level: number; roleId: string }>;
  roleOptions: Array<{ id: string; name: string }>;
  channelOptions: Array<{ id: string; name: string; type?: number }>;
}

function toggleId(list: string[], id: string, checked: boolean): string[] {
  return checked ? [...new Set([...list, id])] : list.filter(value => value !== id);
}

function XpTools() {
  const qc = useQueryClient(); const toast = useToast();
  const [guildId, setGuildId] = useState(''); const [reason, setReason] = useState('XP Konfiguration'); const [reAuth, setReAuth] = useState('');
  const [min, setMin] = useState(''); const [max, setMax] = useState(''); const [voice, setVoice] = useState(''); const [multiplier, setMultiplier] = useState(''); const [maxLevel, setMaxLevel] = useState('');
  const [maxRole, setMaxRole] = useState(''); const [allowedRoles, setAllowedRoles] = useState<string[]>([]); const [allowedChannels, setAllowedChannels] = useState<string[]>([]);
  const [level, setLevel] = useState(''); const [levelRoleId, setLevelRoleId] = useState('');
  const guilds = useQuery({ queryKey: ['dev-command-guilds'], queryFn: () => api.get<{ guilds: GuildRow[] }>('/api/v2/guilds') });
  const xp = useQuery({ queryKey: [base, 'xp', guildId], queryFn: () => api.get<XpData>(`${base}/xp/${guildId}`), enabled: !!guildId });

  useEffect(() => {
    setMin(''); setMax(''); setVoice(''); setMultiplier(''); setMaxLevel('');
    setMaxRole(''); setAllowedRoles([]); setAllowedChannels([]); setLevel(''); setLevelRoleId('');
  }, [guildId]);

  useEffect(() => {
    const cfg = xp.data?.config;
    if (!cfg) return;
    setMin(String(cfg.messageXpMin));
    setMax(String(cfg.messageXpMax));
    setVoice(String(cfg.voiceXpPerMinute));
    setMultiplier(String(cfg.levelMultiplier));
    setMaxLevel(String(cfg.maxLevel));
    setMaxRole(cfg.maxLevelRoleId ?? '');
    setAllowedRoles(Array.isArray(cfg.allowedRoleIds) ? cfg.allowedRoleIds : []);
    setAllowedChannels(Array.isArray(cfg.allowedChannelIds) ? cfg.allowedChannelIds : []);
  }, [xp.data]);

  const patch = useMutation({
    mutationFn: () => api.patch(`${base}/xp/${guildId}`, {
      messageXpMin: Number(min),
      messageXpMax: Number(max),
      voiceXpPerMinute: Number(voice),
      levelMultiplier: Number(multiplier),
      maxLevel: Number(maxLevel),
      maxLevelRoleId: maxRole || null,
      clearMaxLevelRoleId: maxRole === '',
      allowedRoleIds: allowedRoles,
      clearAllowedRoleIds: allowedRoles.length === 0,
      allowedChannelIds: allowedChannels,
      clearAllowedChannelIds: allowedChannels.length === 0,
      reason,
      reAuth,
    }),
    onSuccess: () => { toast.success('XP-Konfiguration gespeichert'); void qc.invalidateQueries({ queryKey: [base, 'xp', guildId] }); },
    onError: e => toast.error('Fehler', errorText(e)),
  });
  const levelRoleSave = useMutation({ mutationFn: () => api.put(`${base}/xp/${guildId}/level-role/${level}`, { roleId: levelRoleId, reason, reAuth }), onSuccess: () => { toast.success('Level-Rolle gespeichert'); void qc.invalidateQueries({ queryKey: [base, 'xp', guildId] }); }, onError: e => toast.error('Fehler', errorText(e)) });
  const levelRoleDelete = useMutation({ mutationFn: () => api.del(`${base}/xp/${guildId}/level-role/${level}`, { reason, reAuth }), onSuccess: () => { toast.success('Level-Rolle entfernt'); void qc.invalidateQueries({ queryKey: [base, 'xp', guildId] }); }, onError: e => toast.error('Fehler', errorText(e)) });

  const ready = Boolean(xp.data && min !== '' && max !== '' && voice !== '' && multiplier !== '' && maxLevel !== '');
  return <div className="space-y-4">
    <Card glow>
      <h2 className="font-semibold mb-3">Guild-spezifische XP-Konfiguration</h2>
      <Select value={guildId} onChange={e => setGuildId(e.target.value)}><option value="">— Guild wählen —</option>{(guilds.data?.guilds ?? []).filter(g => g.botPresent).map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</Select>
      {guildId && <>
        <div className="mt-3"><StepUp reason={reason} setReason={setReason} reAuth={reAuth} setReAuth={setReAuth}/></div>
        {xp.isLoading ? <p className="text-sm text-muted">XP-Konfiguration wird geladen…</p> : xp.isError ? <p className="text-sm text-danger">{errorText(xp.error)}</p> : <>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            <Input value={min} onChange={e => setMin(e.target.value)} type="number" min={0} max={10000} placeholder="Message XP min"/>
            <Input value={max} onChange={e => setMax(e.target.value)} type="number" min={0} max={10000} placeholder="Message XP max"/>
            <Input value={voice} onChange={e => setVoice(e.target.value)} type="number" min={0} max={10000} placeholder="Voice XP/min"/>
            <Input value={multiplier} onChange={e => setMultiplier(e.target.value)} type="number" min={0} max={100} step="0.1" placeholder="Level Multiplier"/>
            <Input value={maxLevel} onChange={e => setMaxLevel(e.target.value)} type="number" min={1} max={100} placeholder="Max Level"/>
          </div>

          <div className="grid gap-3 mt-4 lg:grid-cols-3">
            <div>
              <label className="text-xs text-muted block mb-1">Max-Level-Rolle</label>
              <Select value={maxRole} onChange={e => setMaxRole(e.target.value)}>
                <option value="">Keine Max-Level-Rolle</option>
                {(xp.data?.roleOptions ?? []).map(role => <option key={role.id} value={role.id}>{role.name}</option>)}
              </Select>
            </div>
            <fieldset className="border border-border rounded-lg p-3 min-w-0">
              <legend className="text-xs text-muted px-1">Erlaubte Rollen</legend>
              <div className="max-h-44 overflow-auto space-y-1">
                {(xp.data?.roleOptions ?? []).map(role => <label key={role.id} className="flex items-center gap-2 rounded px-1 py-1 text-sm cursor-pointer"><input type="checkbox" checked={allowedRoles.includes(role.id)} onChange={e => setAllowedRoles(current => toggleId(current, role.id, e.target.checked))}/><span className="truncate">{role.name}</span></label>)}
                {(xp.data?.roleOptions ?? []).length === 0 && <p className="text-xs text-muted">Keine verwendbaren Rollen.</p>}
              </div>
            </fieldset>
            <fieldset className="border border-border rounded-lg p-3 min-w-0">
              <legend className="text-xs text-muted px-1">Erlaubte Text-/Voice-Channels</legend>
              <div className="max-h-44 overflow-auto space-y-1">
                {(xp.data?.channelOptions ?? []).map(channel => <label key={channel.id} className="flex items-center gap-2 rounded px-1 py-1 text-sm cursor-pointer"><input type="checkbox" checked={allowedChannels.includes(channel.id)} onChange={e => setAllowedChannels(current => toggleId(current, channel.id, e.target.checked))}/><span className="truncate">{channel.name}</span></label>)}
                {(xp.data?.channelOptions ?? []).length === 0 && <p className="text-xs text-muted">Keine verwendbaren Channels.</p>}
              </div>
            </fieldset>
          </div>

          <div className="flex flex-wrap gap-2 mt-3">
            <Button size="sm" onClick={() => patch.mutate()} loading={patch.isPending} disabled={!ready}>XP speichern</Button>
            <span className="text-xs text-muted self-center">Leere Rollen-/Channel-Auswahl wird bewusst als „Filter entfernen“ gespeichert.</span>
          </div>

          <div className="grid gap-2 mt-5 sm:grid-cols-[120px_minmax(0,1fr)_auto_auto]">
            <Input value={level} onChange={e => setLevel(e.target.value)} type="number" min={1} max={1000} placeholder="Level"/>
            <Select value={levelRoleId} onChange={e => setLevelRoleId(e.target.value)}><option value="">— Level-Rolle wählen —</option>{(xp.data?.roleOptions ?? []).map(role => <option key={role.id} value={role.id}>{role.name}</option>)}</Select>
            <Button size="sm" onClick={() => levelRoleSave.mutate()} disabled={!level || !levelRoleId}>Level-Rolle setzen</Button>
            <Button size="sm" variant="danger" onClick={() => levelRoleDelete.mutate()} disabled={!level}>Entfernen</Button>
          </div>
        </>}
      </>}
    </Card>
    {guildId && <Card><JsonBlock value={xp.data ?? {}}/></Card>}
  </div>;
}

function CommandReload() {
  const toast = useToast(); const [scope, setScope] = useState('deploy'); const [reason, setReason] = useState('Command Registry aktualisieren'); const [reAuth, setReAuth] = useState('');
  const run = useMutation({ mutationFn: () => api.post(`${base}/commands/reload`, { scope, reason, reAuth }), onSuccess: data => toast.success('Command Registry aktualisiert', JSON.stringify(data)), onError: e => toast.error('Reload fehlgeschlagen', errorText(e)) });
  return <Card glow><h2 className="font-semibold mb-3">Command Hot-Reload / Discord Deploy</h2><p className="text-xs text-muted mb-3">Der Discord-Deploy ersetzt die Registries vollständig und entfernt damit die migrierten Slash-Commands. Der Vorgang verlangt eine echte Step-Up-Re-Authentisierung.</p><StepUp reason={reason} setReason={setReason} reAuth={reAuth} setReAuth={setReAuth}/><div className="flex flex-wrap gap-2"><Select value={scope} onChange={e => setScope(e.target.value)} className="!w-auto"><option value="deploy">Nur Deploy</option><option value="all">Neu laden + Deploy</option></Select><Button size="sm" variant="danger" onClick={() => run.mutate()} loading={run.isPending}>Ausführen</Button></div></Card>;
}
