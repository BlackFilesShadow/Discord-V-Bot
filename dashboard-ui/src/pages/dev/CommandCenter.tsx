import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Database, Download, RefreshCw, Settings, ShieldCheck, UserCog, Zap } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { useToast } from '@/components/ui/Toast';

type Tab = 'diagnostics' | 'admins' | 'database' | 'config' | 'security' | 'exports' | 'xp' | 'commands';
const base = '/api/v2/dev/command-center';
function msg(e: unknown): string { return e instanceof ApiError ? e.message : (e as Error)?.message ?? 'Unbekannter Fehler'; }
function Json({ value }: { value: unknown }) { return <pre className="text-[11px] whitespace-pre-wrap break-all bg-bg-elev rounded-md p-3 max-h-96 overflow-auto">{JSON.stringify(value, null, 2)}</pre>; }

function StepUp({ reason, setReason, reAuth, setReAuth }: { reason: string; setReason: (x: string) => void; reAuth: string; setReAuth: (x: string) => void }) {
  return <div className="grid gap-2 md:grid-cols-2 mb-3"><Input value={reason} onChange={e => setReason(e.target.value)} placeholder="Begründung (mind. 6 Zeichen)"/><Input value={reAuth} onChange={e => setReAuth(e.target.value)} placeholder="Re-Auth / TOTP" type="password"/></div>;
}

export default function CommandCenter() {
  const [tab, setTab] = useState<Tab>('diagnostics');
  const tabs: Array<{ key: Tab; label: string; icon: typeof Activity }> = [
    { key: 'diagnostics', label: 'Diagnostik', icon: Activity }, { key: 'admins', label: 'Admins', icon: UserCog },
    { key: 'database', label: 'Datenbank', icon: Database }, { key: 'config', label: 'Konfiguration', icon: Settings },
    { key: 'security', label: 'Security', icon: ShieldCheck }, { key: 'exports', label: 'Exporte', icon: Download },
    { key: 'xp', label: 'XP-Konfiguration', icon: Zap }, { key: 'commands', label: 'Command Registry', icon: RefreshCw },
  ];
  return <div className="space-y-4"><Card glow><h1 className="text-lg font-semibold">DEV Command Center</h1><p className="text-sm text-muted mt-1">Dashboard-Ersatz für die ehemaligen DEV-Slash-Commands. Hersteller-Funktionen bleiben bewusst in Discord.</p><div className="flex flex-wrap gap-2 mt-4">{tabs.map(t => <Button key={t.key} size="sm" variant={tab === t.key ? 'primary' : 'ghost'} onClick={() => setTab(t.key)}><t.icon className="h-4 w-4"/>{t.label}</Button>)}</div></Card>
    {tab === 'diagnostics' && <Diagnostics/>}{tab === 'admins' && <Admins/>}{tab === 'database' && <DatabaseTools/>}{tab === 'config' && <ConfigTools/>}{tab === 'security' && <SecurityTools/>}{tab === 'exports' && <Exports/>}{tab === 'xp' && <XpTools/>}{tab === 'commands' && <CommandReload/>}
  </div>;
}

function Diagnostics() {
  const q = useQuery({ queryKey: [base, 'diagnostics'], queryFn: () => api.get<Record<string, unknown>>(`${base}/diagnostics`), refetchInterval: 15_000 });
  return <Card glow><div className="flex justify-between"><div><h2 className="font-semibold">Ping / Status / Dev-Eval</h2><p className="text-xs text-muted">WebSocket-Latenz, Uptime, DB-Roundtrip, Cache, CPU/RAM und Prozessspeicher.</p></div><Button size="sm" variant="ghost" onClick={() => q.refetch()}><RefreshCw className="h-4 w-4"/></Button></div>{q.isError ? <p className="text-danger mt-3">{msg(q.error)}</p> : <div className="mt-3"><Json value={q.data ?? {}}/></div>}</Card>;
}

function Admins() {
  const qc = useQueryClient(); const toast = useToast(); const [discordId, setDiscordId] = useState(''); const [reason, setReason] = useState('Adminverwaltung'); const [reAuth, setReAuth] = useState('');
  const q = useQuery({ queryKey: [base, 'admins'], queryFn: () => api.get<{ items: Array<{ id: string; discordId: string; username: string; role: string }> }>(`${base}/admins`) });
  const add = useMutation({ mutationFn: () => api.post(`${base}/admins`, { discordId, reason, reAuth }), onSuccess: () => { toast.success('Admin hinzugefügt'); qc.invalidateQueries({ queryKey: [base, 'admins'] }); }, onError: e => toast.error('Fehler', msg(e)) });
  const remove = useMutation({ mutationFn: (id: string) => api.del(`${base}/admins/${id}`, { reason, reAuth }), onSuccess: () => { toast.success('Admin entfernt'); qc.invalidateQueries({ queryKey: [base, 'admins'] }); }, onError: e => toast.error('Fehler', msg(e)) });
  return <Card glow><h2 className="font-semibold mb-3">Admin-Rollen verwalten</h2><StepUp reason={reason} setReason={setReason} reAuth={reAuth} setReAuth={setReAuth}/><div className="flex gap-2"><Input value={discordId} onChange={e => setDiscordId(e.target.value)} placeholder="Discord-ID"/><Button size="sm" onClick={() => add.mutate()}>ADMIN hinzufügen</Button></div><div className="space-y-2 mt-4">{(q.data?.items ?? []).map(a => <div key={a.id} className="flex items-center justify-between border border-border rounded-md p-2"><span><b>{a.username}</b> <span className="text-muted text-xs">{a.discordId} · {a.role}</span></span>{a.role === 'ADMIN' && <Button size="sm" variant="danger" onClick={() => remove.mutate(a.discordId)}>Entfernen</Button>}</div>)}</div></Card>;
}

function DatabaseTools() {
  const toast = useToast(); const [userQ, setUserQ] = useState(''); const [pkgQ, setPkgQ] = useState(''); const [reason, setReason] = useState('Datenbank Cleanup'); const [reAuth, setReAuth] = useState('');
  const stats = useQuery({ queryKey: [base, 'database'], queryFn: () => api.get<Record<string, unknown>>(`${base}/database`) });
  const users = useQuery({ queryKey: [base, 'db-users', userQ], queryFn: () => api.get(`${base}/database/users?q=${encodeURIComponent(userQ)}`), enabled: userQ.length > 0 });
  const pkgs = useQuery({ queryKey: [base, 'db-pkgs', pkgQ], queryFn: () => api.get(`${base}/database/packages?q=${encodeURIComponent(pkgQ)}`), enabled: pkgQ.length > 0 });
  const cleanup = useMutation({ mutationFn: () => api.post(`${base}/database/cleanup`, { reason, reAuth }), onSuccess: d => { toast.success('Cleanup abgeschlossen', JSON.stringify(d)); stats.refetch(); }, onError: e => toast.error('Cleanup fehlgeschlagen', msg(e)) });
  return <div className="space-y-4"><Card><h2 className="font-semibold mb-3">Tabellenübersicht</h2><Json value={stats.data ?? {}}/></Card><Card><h2 className="font-semibold mb-3">User-/Paket-Suche</h2><div className="grid gap-2 md:grid-cols-2"><Input value={userQ} onChange={e => setUserQ(e.target.value)} placeholder="Username / Discord-ID / E-Mail"/><Input value={pkgQ} onChange={e => setPkgQ(e.target.value)} placeholder="Paketname"/></div><div className="grid gap-3 md:grid-cols-2 mt-3"><Json value={users.data ?? {}}/><Json value={pkgs.data ?? {}}/></div></Card><Card glow><h2 className="font-semibold mb-3">Cleanup abgelaufener Sessions / OTPs</h2><StepUp reason={reason} setReason={setReason} reAuth={reAuth} setReAuth={setReAuth}/><Button size="sm" variant="danger" onClick={() => cleanup.mutate()} loading={cleanup.isPending}>Cleanup ausführen</Button></Card></div>;
}

interface ConfigRow { key: string; value: unknown; category: string; description?: string }
function ConfigTools() {
  const qc = useQueryClient(); const toast = useToast(); const [key, setKey] = useState(''); const [value, setValue] = useState(''); const [description, setDescription] = useState(''); const [reason, setReason] = useState('Konfiguration ändern'); const [reAuth, setReAuth] = useState('');
  const q = useQuery({ queryKey: [base, 'config'], queryFn: () => api.get<{ allowedKeys: string[]; items: ConfigRow[] }>(`${base}/config`) });
  const put = useMutation({ mutationFn: () => api.put(`${base}/config/${encodeURIComponent(key)}`, { value, description, reason, reAuth }), onSuccess: () => { toast.success('Konfiguration gespeichert'); qc.invalidateQueries({ queryKey: [base, 'config'] }); }, onError: e => toast.error('Fehler', msg(e)) });
  const del = useMutation({ mutationFn: () => api.del(`${base}/config/${encodeURIComponent(key)}`, { reason, reAuth }), onSuccess: () => { toast.success('Konfiguration gelöscht'); qc.invalidateQueries({ queryKey: [base, 'config'] }); }, onError: e => toast.error('Fehler', msg(e)) });
  return <Card glow><h2 className="font-semibold mb-3">Live-Konfiguration</h2><StepUp reason={reason} setReason={setReason} reAuth={reAuth} setReAuth={setReAuth}/><div className="grid gap-2 md:grid-cols-3"><Select value={key} onChange={e => setKey(e.target.value)}><option value="">— Schlüssel —</option>{(q.data?.allowedKeys ?? []).map(k => <option key={k}>{k}</option>)}</Select><Input value={value} onChange={e => setValue(e.target.value)} placeholder="Wert (JSON oder Text)"/><Input value={description} onChange={e => setDescription(e.target.value)} placeholder="Beschreibung optional"/></div><div className="flex gap-2 mt-2"><Button size="sm" onClick={() => put.mutate()} disabled={!key}>Setzen</Button><Button size="sm" variant="danger" onClick={() => del.mutate()} disabled={!key}>Löschen</Button></div><div className="mt-4"><Json value={q.data?.items ?? []}/></div></Card>;
}

function SecurityTools() {
  const qc = useQueryClient(); const toast = useToast(); const [ip, setIp] = useState(''); const [listType, setListType] = useState('BLACKLIST'); const [listReason, setListReason] = useState(''); const [hours, setHours] = useState('0'); const [eventId, setEventId] = useState(''); const [reason, setReason] = useState('Security Änderung'); const [reAuth, setReAuth] = useState('');
  const q = useQuery({ queryKey: [base, 'security'], queryFn: () => api.get<Record<string, unknown>>(`${base}/security`) });
  const addIp = useMutation({ mutationFn: () => api.put(`${base}/security/ip/${encodeURIComponent(ip)}`, { listType, listReason, durationHours: Number(hours), reason, reAuth }), onSuccess: () => { toast.success('IP-Liste aktualisiert'); qc.invalidateQueries({ queryKey: [base, 'security'] }); }, onError: e => toast.error('Fehler', msg(e)) });
  const delIp = useMutation({ mutationFn: () => api.del(`${base}/security/ip/${encodeURIComponent(ip)}`, { reason, reAuth }), onSuccess: () => { toast.success('IP entfernt'); qc.invalidateQueries({ queryKey: [base, 'security'] }); }, onError: e => toast.error('Fehler', msg(e)) });
  const resolve = useMutation({ mutationFn: () => api.post(`${base}/security/events/${eventId}/resolve`, { reason, reAuth }), onSuccess: () => { toast.success('Event gelöst'); qc.invalidateQueries({ queryKey: [base, 'security'] }); }, onError: e => toast.error('Fehler', msg(e)) });
  return <div className="space-y-4"><Card glow><h2 className="font-semibold mb-3">IP Black-/Whitelist & Event-Auflösung</h2><StepUp reason={reason} setReason={setReason} reAuth={reAuth} setReAuth={setReAuth}/><div className="grid gap-2 md:grid-cols-4"><Input value={ip} onChange={e => setIp(e.target.value)} placeholder="IPv4 / IPv6"/><Select value={listType} onChange={e => setListType(e.target.value)}><option>BLACKLIST</option><option>WHITELIST</option></Select><Input value={listReason} onChange={e => setListReason(e.target.value)} placeholder="Listen-Begründung"/><Input value={hours} onChange={e => setHours(e.target.value)} type="number" placeholder="Stunden (0=permanent)"/></div><div className="flex gap-2 mt-2"><Button size="sm" onClick={() => addIp.mutate()}>IP setzen</Button><Button size="sm" variant="danger" onClick={() => delIp.mutate()}>IP entfernen</Button></div><div className="flex gap-2 mt-4"><Input value={eventId} onChange={e => setEventId(e.target.value)} placeholder="SecurityEvent-ID"/><Button size="sm" onClick={() => resolve.mutate()}>Event als gelöst markieren</Button></div></Card><Card><Json value={q.data ?? {}}/></Card></div>;
}

function Exports() {
  const [discordId, setDiscordId] = useState(''); const [category, setCategory] = useState('ALL'); const [days, setDays] = useState('30');
  const go = (url: string) => { window.location.href = url; };
  return <Card glow><h2 className="font-semibold mb-3">Sensible Exporte</h2><p className="text-xs text-muted mb-3">Downloads laufen direkt über die geschützte DEV-Session und werden auditiert.</p><div className="flex gap-2"><Input value={discordId} onChange={e => setDiscordId(e.target.value)} placeholder="Discord-ID"/><Button size="sm" onClick={() => go(`${base}/export/packages/${discordId}`)}>Pakete</Button><Button size="sm" onClick={() => go(`${base}/export/user/${discordId}`)}>GDPR User</Button></div><div className="flex gap-2 mt-3"><Select value={category} onChange={e => setCategory(e.target.value)} className="!w-auto">{['ALL','SECURITY','MODERATION','GDPR'].map(x => <option key={x}>{x}</option>)}</Select><Input value={days} onChange={e => setDays(e.target.value)} type="number" min={1} max={365}/><Button size="sm" onClick={() => go(`${base}/export/logs?category=${category}&days=${days}`)}>Audit-Logs</Button></div></Card>;
}

interface GuildRow { id: string; name: string }
interface XpData { config: Record<string, unknown> & { messageXpMin?: number; messageXpMax?: number; voiceXpPerMinute?: number; levelMultiplier?: number; maxLevel?: number; maxLevelRoleId?: string | null; allowedRoleIds?: string[]; allowedChannelIds?: string[] }; levelRoles: Array<{ id: string; level: number; roleId: string }>; roleOptions: Array<{ id: string; name: string }>; channelOptions: Array<{ id: string; name: string }> }
function XpTools() {
  const toast = useToast(); const qc = useQueryClient(); const [guildId, setGuildId] = useState(''); const [reason, setReason] = useState('XP Konfiguration'); const [reAuth, setReAuth] = useState(''); const [min, setMin] = useState(''); const [max, setMax] = useState(''); const [voice, setVoice] = useState(''); const [mult, setMult] = useState(''); const [maxLevel, setMaxLevel] = useState(''); const [maxRole, setMaxRole] = useState(''); const [allowedRoles, setAllowedRoles] = useState(''); const [allowedChannels, setAllowedChannels] = useState(''); const [level, setLevel] = useState(''); const [levelRole, setLevelRole] = useState('');
  const guilds = useQuery({ queryKey: ['guilds-xp'], queryFn: () => api.get<{ items?: GuildRow[] } | GuildRow[]>('/api/v2/guilds') });
  const guildRows: GuildRow[] = Array.isArray(guilds.data) ? guilds.data : guilds.data?.items ?? [];
  const q = useQuery({ queryKey: [base, 'xp', guildId], queryFn: () => api.get<XpData>(`${base}/xp/${guildId}`), enabled: !!guildId });
  const patch = useMutation({ mutationFn: () => api.patch(`${base}/xp/${guildId}`, { ...(min && { messageXpMin: Number(min) }), ...(max && { messageXpMax: Number(max) }), ...(voice && { voiceXpPerMinute: Number(voice) }), ...(mult && { levelMultiplier: Number(mult) }), ...(maxLevel && { maxLevel: Number(maxLevel) }), maxLevelRoleId: maxRole || null, allowedRoleIds: allowedRoles.split(',').map(x => x.trim()).filter(Boolean), allowedChannelIds: allowedChannels.split(',').map(x => x.trim()).filter(Boolean), reason, reAuth }), onSuccess: () => { toast.success('XP gespeichert'); qc.invalidateQueries({ queryKey: [base, 'xp', guildId] }); }, onError: e => toast.error('Fehler', msg(e)) });
  const setLevelRole = useMutation({ mutationFn: () => api.put(`${base}/xp/${guildId}/level-role/${level}`, { roleId: levelRole, reason, reAuth }), onSuccess: () => qc.invalidateQueries({ queryKey: [base, 'xp', guildId] }), onError: e => toast.error('Fehler', msg(e)) });
  const delLevelRole = useMutation({ mutationFn: () => api.del(`${base}/xp/${guildId}/level-role/${level}`, { reason, reAuth }), onSuccess: () => qc.invalidateQueries({ queryKey: [base, 'xp', guildId] }), onError: e => toast.error('Fehler', msg(e)) });
  return <div className="space-y-4"><Card glow><h2 className="font-semibold mb-3">Guild-spezifische XP-Konfiguration</h2><Select value={guildId} onChange={e => setGuildId(e.target.value)}><option value="">— Guild wählen —</option>{guildRows.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</Select>{guildId && <><div className="mt-3"><StepUp reason={reason} setReason={setReason} reAuth={reAuth} setReAuth={setReAuth}/></div><div className="grid gap-2 md:grid-cols-4"><Input value={min} onChange={e => setMin(e.target.value)} placeholder="Message XP min"/><Input value={max} onChange={e => setMax(e.target.value)} placeholder="Message XP max"/><Input value={voice} onChange={e => setVoice(e.target.value)} placeholder="Voice XP/min"/><Input value={mult} onChange={e => setMult(e.target.value)} placeholder="Level Multiplier"/><Input value={maxLevel} onChange={e => setMaxLevel(e.target.value)} placeholder="Max Level"/><Input value={maxRole} onChange={e => setMaxRole(e.target.value)} placeholder="Max-Level Role-ID"/><Input value={allowedRoles} onChange={e => setAllowedRoles(e.target.value)} placeholder="Allowed Role IDs, kommasepariert"/><Input value={allowedChannels} onChange={e => setAllowedChannels(e.target.value)} placeholder="Allowed Channel IDs, kommasepariert"/></div><Button size="sm" className="mt-2" onClick={() => patch.mutate()}>XP-Konfiguration speichern</Button><div className="flex gap-2 mt-4"><Input value={level} onChange={e => setLevel(e.target.value)} placeholder="Level"/><Input value={levelRole} onChange={e => setLevelRole(e.target.value)} placeholder="Role-ID"/><Button size="sm" onClick={() => setLevelRole.mutate()}>Level-Rolle setzen</Button><Button size="sm" variant="danger" onClick={() => delLevelRole.mutate()}>Level-Rolle entfernen</Button></div></>}</Card>{guildId && <Card><Json value={q.data ?? {}}/></Card>}</div>;
}

function CommandReload() {
  const toast = useToast(); const [scope, setScope] = useState('deploy'); const [reason, setReason] = useState('Command Registry aktualisieren'); const [reAuth, setReAuth] = useState('');
  const run = useMutation({ mutationFn: () => api.post(`${base}/commands/reload`, { scope, reason, reAuth }), onSuccess: d => toast.success('Command Registry aktualisiert', JSON.stringify(d)), onError: e => toast.error('Reload fehlgeschlagen', msg(e)) });
  return <Card glow><h2 className="font-semibold mb-3">Command Hot-Reload / Discord Deploy</h2><p className="text-xs text-muted mb-3">Nach der Migration werden damit auch alte globale Slash-Commands bei Discord entfernt, weil der Scope vollständig ersetzt wird.</p><StepUp reason={reason} setReason={setReason} reAuth={reAuth} setReAuth={setReAuth}/><div className="flex gap-2"><Select value={scope} onChange={e => setScope(e.target.value)} className="!w-auto"><option value="deploy">Nur registrieren / Deploy</option><option value="all">Commands neu laden + Deploy</option></Select><Button size="sm" variant="danger" onClick={() => run.mutate()} loading={run.isPending}>Ausführen</Button></div></Card>;
}
