import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Brain, FileSearch, MessageSquare, ShieldAlert, Trash2, Upload, Wrench } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { useToast } from '@/components/ui/Toast';

type Tab = 'system' | 'audit' | 'providers' | 'triggers' | 'feedback' | 'maintenance';
interface Guild { id: string; name: string; memberCount: number }

function msg(e: unknown): string {
  return e instanceof ApiError ? e.message : (e as Error)?.message ?? 'Unbekannter Fehler';
}

function Json({ value }: { value: unknown }) {
  return <pre className="text-[11px] whitespace-pre-wrap break-all bg-bg-elev rounded-md p-3 max-h-80 overflow-auto">{JSON.stringify(value, null, 2)}</pre>;
}

export function BotAdminCommandCenter({ base = '/api/v2/bot-admin' }: { base?: string }) {
  const center = `${base}/command-center`;
  const [tab, setTab] = useState<Tab>('system');
  const guildsQ = useQuery({ queryKey: [base, 'guilds'], queryFn: () => api.get<{ items: Guild[] }>(`${base}/guilds`) });
  const [guildId, setGuildId] = useState('');
  const tabs: Array<{ key: Tab; label: string; icon: typeof Activity }> = [
    { key: 'system', label: 'System & Fehler', icon: Activity },
    { key: 'audit', label: 'Audit & Logs', icon: FileSearch },
    { key: 'providers', label: 'AI Provider', icon: Brain },
    { key: 'triggers', label: 'AI Trigger', icon: Wrench },
    { key: 'feedback', label: 'Feedback', icon: MessageSquare },
    { key: 'maintenance', label: 'Validierung & Löschen', icon: ShieldAlert },
  ];

  return <div className="space-y-4">
    <div className="flex flex-wrap gap-2">
      {tabs.map(t => <Button key={t.key} size="sm" variant={tab === t.key ? 'primary' : 'ghost'} onClick={() => setTab(t.key)}><t.icon className="h-4 w-4" />{t.label}</Button>)}
    </div>
    {(tab === 'triggers' || tab === 'feedback') && <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
      <span className="text-xs text-muted">Server:</span>
      <Select value={guildId} onChange={e => setGuildId(e.target.value)} className="sm:!w-auto">
        <option value="">— Server wählen —</option>
        {(guildsQ.data?.items ?? []).map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
      </Select>
    </div>}
    {tab === 'system' && <System center={center} />}
    {tab === 'audit' && <Audit center={center} />}
    {tab === 'providers' && <Providers center={center} />}
    {tab === 'triggers' && <Triggers center={center} guildId={guildId} />}
    {tab === 'feedback' && <Feedback center={center} guildId={guildId} />}
    {tab === 'maintenance' && <Maintenance center={center} />}
  </div>;
}

function System({ center }: { center: string }) {
  const overview = useQuery({ queryKey: [center, 'overview'], queryFn: () => api.get<Record<string, unknown>>(`${center}/overview`) });
  const errors = useQuery({ queryKey: [center, 'errors'], queryFn: () => api.get<Record<string, unknown>>(`${center}/errors?unresolved=true&limit=50`) });
  return <div className="grid gap-4 xl:grid-cols-2">
    <Card glow><h2 className="font-semibold mb-3">Admin-Stats & Monitor</h2>{overview.isLoading ? <p className="text-muted">Lädt…</p> : overview.isError ? <p className="text-danger">{msg(overview.error)}</p> : <Json value={overview.data} />}</Card>
    <Card glow><h2 className="font-semibold mb-3">Error Report</h2>{errors.isLoading ? <p className="text-muted">Lädt…</p> : errors.isError ? <p className="text-danger">{msg(errors.error)}</p> : <Json value={errors.data} />}</Card>
  </div>;
}

function Audit({ center }: { center: string }) {
  const [action, setAction] = useState('');
  const [category, setCategory] = useState('');
  const [user, setUser] = useState('');
  const [q, setQ] = useState('');
  const [days, setDays] = useState('30');
  const params = useMemo(() => new URLSearchParams({ ...(action && { action }), ...(category && { category }), ...(user && { user }), ...(q && { q }), days, limit: '50' }).toString(), [action, category, user, q, days]);
  const logs = useQuery({ queryKey: [center, 'audit', params], queryFn: () => api.get<Record<string, unknown>>(`${center}/audit?${params}`) });
  const compliance = useQuery({ queryKey: [center, 'compliance'], queryFn: () => api.get<Record<string, unknown>>(`${center}/audit/compliance`) });
  return <div className="space-y-4">
    <Card glow>
      <h2 className="font-semibold mb-3">Audit-Suche / Volltext</h2>
      <div className="grid gap-2 md:grid-cols-5">
        <Input value={action} onChange={e => setAction(e.target.value)} placeholder="Aktion"/>
        <Select value={category} onChange={e => setCategory(e.target.value)}><option value="">Alle Kategorien</option>{['AUTH','REGISTRATION','UPLOAD','DOWNLOAD','MODERATION','SECURITY','ADMIN','GDPR'].map(x => <option key={x}>{x}</option>)}</Select>
        <Input value={user} onChange={e => setUser(e.target.value)} placeholder="Discord-ID"/>
        <Input value={q} onChange={e => setQ(e.target.value)} placeholder="Volltext"/>
        <Input value={days} onChange={e => setDays(e.target.value)} type="number" min={1} max={365}/>
      </div>
      <div className="mt-3 flex flex-wrap gap-2"><Button size="sm" onClick={() => logs.refetch()}>Suchen</Button><Button size="sm" variant="ghost" onClick={() => { window.location.href = `${center}/audit/export?days=${encodeURIComponent(days)}`; }}>JSON exportieren</Button></div>
      <div className="mt-3">{logs.isError ? <p className="text-danger">{msg(logs.error)}</p> : <Json value={logs.data ?? {}} />}</div>
    </Card>
    <Card><h2 className="font-semibold mb-3">Compliance</h2>{compliance.isError ? <p className="text-danger">{msg(compliance.error)}</p> : <Json value={compliance.data ?? {}} />}</Card>
  </div>;
}

function Providers({ center }: { center: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [provider, setProvider] = useState('all');
  const q = useQuery({ queryKey: [center, 'providers'], queryFn: () => api.get<Record<string, unknown>>(`${center}/providers`) });
  const probe = useMutation({ mutationFn: () => api.post(`${center}/providers/probe`, { provider }), onSuccess: d => toast.success('Probe abgeschlossen', JSON.stringify(d)), onError: e => toast.error('Probe fehlgeschlagen', msg(e)) });
  const reset = useMutation({ mutationFn: () => api.post(`${center}/providers/reset`, { provider, confirm: 'RESET' }), onSuccess: () => { toast.success('Provider zurückgesetzt'); qc.invalidateQueries({ queryKey: [center, 'providers'] }); }, onError: e => toast.error('Reset fehlgeschlagen', msg(e)) });
  return <Card glow>
    <h2 className="font-semibold mb-3">AI Provider Health / Reihenfolge / Probe</h2>
    <div className="flex flex-wrap gap-2 mb-3"><Select value={provider} onChange={e => setProvider(e.target.value)} className="sm:!w-auto">{['all','groq','cerebras','openrouter','gemini','openai'].map(x => <option key={x} value={x}>{x}</option>)}</Select><Button size="sm" onClick={() => probe.mutate()} loading={probe.isPending}>Probe</Button><Button size="sm" variant="danger" onClick={() => reset.mutate()} loading={reset.isPending}>Stats + Cooldown resetten</Button></div>
    {q.isError ? <p className="text-danger">{msg(q.error)}</p> : <Json value={q.data ?? {}} />}
  </Card>;
}

interface Trigger {
  id: string;
  trigger: string;
  triggerType: string;
  responseMode: string;
  responseText?: string;
  aiPrompt?: string;
  mediaUrl?: string;
  channelId?: string;
  cooldownSeconds?: number;
}
interface TriggerListResponse {
  items: Trigger[];
  max: number;
  channelOptions: Array<{ id: string; name: string; type: number }>;
}

function Triggers({ center, guildId }: { center: string; guildId: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [id, setId] = useState('');
  const [triggerType, setTriggerType] = useState('keyword');
  const [pattern, setPattern] = useState('');
  const [responseMode, setResponseMode] = useState('text');
  const [response, setResponse] = useState('');
  const [channelId, setChannelId] = useState('');
  const [cooldown, setCooldown] = useState('10');
  const [mediaUrl, setMediaUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [clearConfirm, setClearConfirm] = useState('');
  const list = useQuery({ queryKey: [center, 'triggers', guildId], queryFn: () => api.get<TriggerListResponse>(`${center}/triggers?guildId=${guildId}`), enabled: !!guildId });

  useEffect(() => {
    setChannelId('');
    setClearConfirm('');
  }, [guildId]);

  const save = useMutation({
    mutationFn: async () => {
      if (file && mediaUrl.trim()) throw new Error('Bitte entweder eine Datei oder eine Remote-URL verwenden, nicht beides.');
      const common = { guildId, id, triggerType, pattern, responseMode, response, channelId: channelId || undefined, cooldownSeconds: Number(cooldown) };
      if (file) {
        const fd = new FormData();
        Object.entries(common).forEach(([key, value]) => value !== undefined && fd.append(key, String(value)));
        fd.append('file', file);
        return api.uploadForm(`${center}/triggers/upload`, fd);
      }
      return api.post(`${center}/triggers`, { ...common, mediaUrl: mediaUrl.trim() || undefined });
    },
    onSuccess: () => { toast.success('Trigger gespeichert'); qc.invalidateQueries({ queryKey: [center, 'triggers', guildId] }); },
    onError: e => toast.error('Trigger fehlgeschlagen', msg(e)),
  });
  const del = useMutation({ mutationFn: (triggerId: string) => api.del(`${center}/triggers/${encodeURIComponent(triggerId)}?guildId=${guildId}`), onSuccess: () => qc.invalidateQueries({ queryKey: [center, 'triggers', guildId] }) });
  const clear = useMutation({
    mutationFn: () => api.post(`${center}/triggers/clear`, { guildId, confirm: clearConfirm }),
    onSuccess: () => { setClearConfirm(''); toast.success('Alle Guild-Trigger gelöscht'); qc.invalidateQueries({ queryKey: [center, 'triggers', guildId] }); },
    onError: e => toast.error('Trigger konnten nicht gelöscht werden', msg(e)),
  });

  if (!guildId) return <Card><p className="text-muted">Bitte einen Server auswählen.</p></Card>;
  return <div className="space-y-4">
    <Card glow>
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="font-semibold">AI-Trigger hinzufügen</h2>
        <span className="text-xs text-muted">{list.data?.items.length ?? 0} / {list.data?.max ?? '–'} Trigger</span>
      </div>
      <div className="grid gap-2 mt-3 md:grid-cols-3">
        <Input value={id} onChange={e => setId(e.target.value)} placeholder="ID"/>
        <Select value={triggerType} onChange={e => setTriggerType(e.target.value)}><option value="keyword">Keyword</option><option value="regex">Regex</option><option value="mention">Mention</option></Select>
        <Select value={responseMode} onChange={e => setResponseMode(e.target.value)}><option value="text">Text</option><option value="ai">AI</option></Select>
        <Input value={pattern} onChange={e => setPattern(e.target.value)} placeholder="Trigger / Regex"/>
        <Select value={channelId} onChange={e => setChannelId(e.target.value)} disabled={list.isLoading || list.isError}>
          <option value="">Alle erlaubten Channels</option>
          {(list.data?.channelOptions ?? []).map(channel => <option key={channel.id} value={channel.id}>{channel.name}</option>)}
        </Select>
        <Input value={cooldown} onChange={e => setCooldown(e.target.value)} type="number" min={0} max={3600} placeholder="Cooldown Sekunden"/>
        <Input value={mediaUrl} onChange={e => setMediaUrl(e.target.value)} placeholder="Remote Media URL optional" disabled={!!file}/>
        <input type="file" accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/webm,video/quicktime" disabled={mediaUrl.trim().length > 0} onChange={e => setFile(e.target.files?.[0] ?? null)} className="min-w-0 w-full text-xs text-muted disabled:opacity-50"/>
      </div>
      {list.isError && <p className="text-xs text-danger mt-2">Channel-Liste konnte nicht geladen werden: {msg(list.error)}</p>}
      <p className="text-[11px] text-muted mt-2">Media: entweder Browser-Datei oder Remote-URL. Beide gleichzeitig sind nicht erlaubt.</p>
      <textarea value={response} onChange={e => setResponse(e.target.value)} placeholder="Antwort / AI-Anweisung" className="input-premium w-full mt-2 rounded-md min-h-24 p-2 text-sm"/>
      <Button size="sm" className="mt-2" onClick={() => save.mutate()} loading={save.isPending} disabled={list.isError}><Upload className="h-4 w-4"/>Speichern</Button>
    </Card>
    <Card>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="font-semibold">Vorhandene Trigger</h2>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input value={clearConfirm} onChange={e => setClearConfirm(e.target.value)} placeholder="CLEAR eingeben" className="sm:!w-36"/>
          <Button size="sm" variant="danger" onClick={() => clear.mutate()} loading={clear.isPending} disabled={clearConfirm !== 'CLEAR'}>Alle löschen</Button>
        </div>
      </div>
      <div className="space-y-2 mt-3">{(list.data?.items ?? []).map(trigger => <div key={trigger.id} className="border border-border rounded-md p-3"><div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0"><b>{trigger.id}</b> <Badge>{trigger.triggerType}</Badge> <Badge>{trigger.responseMode}</Badge><div className="text-xs text-muted mt-1 break-words">{trigger.trigger} · CD {trigger.cooldownSeconds ?? 10}s{trigger.mediaUrl ? ' · Media' : ''}</div></div><Button size="sm" variant="danger" onClick={() => del.mutate(trigger.id)} loading={del.isPending}><Trash2 className="h-4 w-4"/></Button></div></div>)}</div>
    </Card>
  </div>;
}

interface FeedbackChannelResponse {
  globalChannelId: string | null;
  guildChannelId: string | null;
  channelOptions: Array<{ id: string; name: string; type: number }>;
}

function Feedback({ center, guildId }: { center: string; guildId: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [guildChannel, setGuildChannel] = useState('');
  const [globalChannel, setGlobalChannel] = useState('');
  const [feedbackId, setFeedbackId] = useState('');
  const [status, setStatus] = useState('OPEN');
  const [note, setNote] = useState('');
  const cfg = useQuery({ queryKey: [center, 'feedback-channel', guildId], queryFn: () => api.get<FeedbackChannelResponse>(`${center}/feedback-channel${guildId ? `?guildId=${guildId}` : ''}`) });

  useEffect(() => {
    setGuildChannel('');
  }, [guildId]);

  useEffect(() => {
    if (!cfg.data) return;
    setGlobalChannel(cfg.data.globalChannelId ?? '');
    setGuildChannel(cfg.data.guildChannelId ?? '');
  }, [cfg.data]);

  const save = useMutation({
    mutationFn: (scope: 'guild'|'global') => api.put(`${center}/feedback-channel`, scope === 'global'
      ? { scope, channelId: globalChannel || null }
      : { scope, guildId, channelId: guildChannel || null }),
    onSuccess: () => { toast.success('Feedback-Kanal aktualisiert'); qc.invalidateQueries({ queryKey: [center, 'feedback-channel'] }); },
    onError: e => toast.error('Fehler', msg(e)),
  });
  const patch = useMutation({ mutationFn: () => api.patch(`${center}/feedback/${feedbackId}`, { status, adminNote: note }), onSuccess: () => toast.success('Feedback aktualisiert inkl. Notify-Embed'), onError: e => toast.error('Fehler', msg(e)) });
  const options = cfg.data?.channelOptions ?? [];
  const currentGuildChannelMissing = Boolean(guildChannel) && !options.some(channel => channel.id === guildChannel);

  return <div className="space-y-4">
    <Card glow>
      <h2 className="font-semibold mb-3">Feedback-Channel-Konfiguration</h2>
      <p className="text-xs text-muted mb-2 break-all">Aktuell global: {cfg.data?.globalChannelId ?? '–'} · Guild: {cfg.data?.guildChannelId ?? '–'}</p>
      <div className="grid gap-2 md:grid-cols-2">
        <div className="flex flex-col gap-2 sm:flex-row"><Input value={globalChannel} onChange={e => setGlobalChannel(e.target.value)} placeholder="Global Channel-ID / leer deaktiviert"/><Button size="sm" onClick={() => save.mutate('global')}>Global setzen</Button></div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Select value={guildChannel} onChange={e => setGuildChannel(e.target.value)} disabled={!guildId || cfg.isLoading || cfg.isError}>
            <option value="">Guild-Feedback deaktivieren</option>
            {currentGuildChannelMissing && <option value={guildChannel}>Aktuell gespeichert: {guildChannel} (nicht erreichbar)</option>}
            {options.map(channel => <option key={channel.id} value={channel.id}>{channel.name}</option>)}
          </Select>
          <Button size="sm" onClick={() => save.mutate('guild')} disabled={!guildId || cfg.isLoading || cfg.isError}>Guild setzen</Button>
        </div>
      </div>
      <p className="text-[11px] text-muted mt-2">Der globale Fallback ist Bot-Owner-only. Für die ausgewählte Guild werden nur erreichbare Text-/Ankündigungskanäle angeboten.</p>
    </Card>
    <Card>
      <h2 className="font-semibold mb-3">Feedback-Status / Admin-Notiz</h2>
      <div className="grid gap-2 md:grid-cols-3"><Input value={feedbackId} onChange={e => setFeedbackId(e.target.value)} placeholder="Feedback-ID"/><Select value={status} onChange={e => setStatus(e.target.value)}>{['OPEN','IN_REVIEW','RESOLVED','WONTFIX'].map(x => <option key={x}>{x}</option>)}</Select><Input value={note} onChange={e => setNote(e.target.value)} placeholder="Admin-Notiz"/></div>
      <Button size="sm" className="mt-2" onClick={() => patch.mutate()} disabled={!feedbackId}>Speichern + Notify aktualisieren</Button>
    </Card>
  </div>;
}

function Maintenance({ center }: { center: string }) {
  const toast = useToast();
  const [packageId, setPackageId] = useState('');
  const [uploadId, setUploadId] = useState('');
  const [userId, setUserId] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const run = async (promise: Promise<unknown>, label: string): Promise<boolean> => {
    try {
      const data = await promise;
      toast.success(label, JSON.stringify(data));
      return true;
    } catch (error) {
      toast.error(`${label} fehlgeschlagen`, msg(error));
      return false;
    }
  };
  const runDestructive = async (promise: Promise<unknown>, label: string) => {
    if (deleteConfirm !== 'DELETE') return;
    if (await run(promise, label)) setDeleteConfirm('');
  };

  return <Card glow>
    <h2 className="font-semibold mb-3">Validierung & sichere Löschung</h2>
    <div className="mb-4 rounded-lg border border-danger/30 p-3">
      <p className="text-xs text-muted mb-2">Für jede physische/irreversible Löschung exakt <b>DELETE</b> eingeben. Nach erfolgreicher Löschung wird die Bestätigung zurückgesetzt.</p>
      <Input value={deleteConfirm} onChange={e => setDeleteConfirm(e.target.value)} placeholder="DELETE eingeben" autoComplete="off"/>
    </div>
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
        <Input value={packageId} onChange={e => setPackageId(e.target.value)} placeholder="Package-ID"/>
        <Button size="sm" onClick={() => run(api.post(`${center}/validate/package/${packageId}`), 'Paket validiert')} disabled={!packageId}>Paket validieren</Button>
        <Button size="sm" variant="danger" onClick={() => runDestructive(api.del(`${center}/packages/${packageId}/hard`, { confirm: deleteConfirm }), 'Paket physisch gelöscht')} disabled={!packageId || deleteConfirm !== 'DELETE'}>Hard Delete</Button>
      </div>
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
        <Input value={uploadId} onChange={e => setUploadId(e.target.value)} placeholder="Upload/File-ID"/>
        <Button size="sm" onClick={() => run(api.post(`${center}/validate/upload/${uploadId}`), 'Datei validiert')} disabled={!uploadId}>Datei validieren</Button>
        <Button size="sm" variant="danger" onClick={() => runDestructive(api.del(`${center}/uploads/${uploadId}`, { confirm: deleteConfirm }), 'Datei gelöscht')} disabled={!uploadId || deleteConfirm !== 'DELETE'}>Datei löschen</Button>
      </div>
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
        <Input value={userId} onChange={e => setUserId(e.target.value)} placeholder="Interne User-ID"/>
        <Button size="sm" variant="danger" onClick={() => run(api.post(`${center}/users/${userId}/packages/delete`, { hard: false }), 'Pakete soft gelöscht')} disabled={!userId}>Alle Pakete Soft Delete</Button>
        <Button size="sm" variant="danger" onClick={() => runDestructive(api.post(`${center}/users/${userId}/packages/delete`, { hard: true, confirm: deleteConfirm }), 'Pakete physisch gelöscht')} disabled={!userId || deleteConfirm !== 'DELETE'}>Alle Pakete Hard Delete</Button>
      </div>
    </div>
  </Card>;
}
