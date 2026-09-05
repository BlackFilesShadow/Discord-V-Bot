import { lazy, Suspense, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MapPinned, Pencil, Plus } from 'lucide-react';
import { api, describeApiError } from '@/lib/api';
import { getGuildSocket, joinRadarRoom } from '@/lib/socket';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ZoneEditor, type EditableRadarZone, type RadarFunctionDefinition } from './ZoneEditor';

const DayzRadarMap = lazy(async () => ({ default: (await import('./DayzRadarMap')).DayzRadarMap }));

type RadarMap = 'CHERNARUS' | 'LIVONIA' | 'SAKHAL';

interface RadarFunction {
  key: string;
  label: string;
  order: number;
  defaultEnabled: boolean;
  sourceEvents: string[];
}

interface RadarZone {
  id: string;
  name: string;
  map: RadarMap;
  isActive: boolean;
  rolePingEnabled: boolean;
  roleIds: string[];
  enabledFunctions: string[];
  allowlist: unknown[];
  geometry: { type: 'CIRCLE'; x: number; y: number; radiusMeters: number } | { type: 'POLYGON'; points: Array<{ x: number; y: number }> };
}

interface ChannelOption { id: string; name: string; type: number }
interface RoleOption { id: string; name: string; managed: boolean }
interface RadarPlayerOption { gameId: string; playerName: string }

const MAP_LABELS: Record<RadarMap, string> = {
  CHERNARUS: 'Chernarus',
  LIVONIA: 'Livonia',
  SAKHAL: 'Sakhal',
};

export function ZoneRadarTab({ guildId, slot, canManage }: { guildId: string; slot: string; canManage: boolean }) {
  const queryClient = useQueryClient();
  const [editorId, setEditorId] = useState<string | 'new' | null>(null);
  const query = `?slot=${encodeURIComponent(slot)}`;
  const config = useQuery({ queryKey: ['radar-config', guildId, slot], queryFn: () => api.get<{ activeMap: RadarMap; nitradoConnId: string }>(`/api/v2/guilds/${guildId}/radar/config${query}`), retry: false });

  useEffect(() => {
    const nitradoConnId = config.data?.nitradoConnId;
    if (!nitradoConnId) return;
    const socket = getGuildSocket();
    const join = () => joinRadarRoom(guildId, nitradoConnId);
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: ['radar-zones', guildId, slot] });
    };
    join();
    socket.on('connect', join);
    socket.on('radar.player.detected', refresh);
    socket.on('radar.zone.event', refresh);
    return () => {
      socket.off('connect', join);
      socket.off('radar.player.detected', refresh);
      socket.off('radar.zone.event', refresh);
      socket.emit('leave.radar', { guildId, nitradoConnId });
    };
  }, [guildId, slot, config.data?.nitradoConnId, queryClient]);

  const functions = useQuery({ queryKey: ['radar-functions', guildId], queryFn: () => api.get<{ functions: RadarFunction[] }>(`/api/v2/guilds/${guildId}/radar/functions`), retry: false });
  const zones = useQuery({ queryKey: ['radar-zones', guildId, slot], queryFn: () => api.get<{ zones: RadarZone[] }>(`/api/v2/guilds/${guildId}/radar/zones${query}`), retry: false });
  const updateConfig = useMutation({
    mutationFn: (activeMap: RadarMap) => api.put(`/api/v2/guilds/${guildId}/radar/config${query}`, { activeMap }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['radar-config', guildId, slot] }),
  });
  const detail = useQuery({ queryKey: ['radar-zone', guildId, slot, editorId], queryFn: () => api.get<{ zone: EditableRadarZone }>(`/api/v2/guilds/${guildId}/radar/zones/${editorId}${query}`), enabled: editorId !== null && editorId !== 'new', retry: false });
  const channels = useQuery({ queryKey: ['guild-channels', guildId], queryFn: () => api.get<{ channels: ChannelOption[] }>(`/api/v2/guilds/${guildId}/channels`), enabled: canManage && editorId !== null, retry: false });
  const roles = useQuery({ queryKey: ['guild-roles', guildId], queryFn: () => api.get<{ roles: RoleOption[] }>(`/api/v2/guilds/${guildId}/roles`), enabled: canManage && editorId !== null, retry: false });
  const players = useQuery({ queryKey: ['radar-players', guildId, slot], queryFn: () => api.get<{ players: RadarPlayerOption[] }>(`/api/v2/guilds/${guildId}/radar/players${query}`), enabled: canManage && editorId !== null, retry: false });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['radar-zones', guildId, slot] });
  const saveZone = useMutation({
    mutationFn: (payload: Omit<EditableRadarZone, 'id' | 'version'> & { version?: number }) => editorId && editorId !== 'new'
      ? api.put(`/api/v2/guilds/${guildId}/radar/zones/${editorId}${query}`, payload)
      : api.post(`/api/v2/guilds/${guildId}/radar/zones${query}`, payload),
    onSuccess: () => { refresh(); setEditorId(null); },
  });
  const deleteZone = useMutation({ mutationFn: (zone: EditableRadarZone) => api.del(`/api/v2/guilds/${guildId}/radar/zones/${zone.id}${query}`), onSuccess: () => { refresh(); setEditorId(null); } });
  const openNewEditor = () => {
    saveZone.reset();
    deleteZone.reset();
    setEditorId('new');
  };

  if (config.isError || functions.isError || zones.isError) {
    const error = config.error ?? functions.error ?? zones.error;
    return <Card><p role="alert" className="text-sm text-danger">{describeApiError(error).desc}</p></Card>;
  }

  const activeMap = config.data?.activeMap ?? 'CHERNARUS';
  const editing = editorId === 'new' || typeof editorId === 'string';
  const editorLoadError = detail.error ?? channels.error ?? roles.error ?? players.error;
  const mutationError = saveZone.error ?? deleteZone.error;
  const editorLoading = detail.isLoading || channels.isLoading || roles.isLoading || players.isLoading;

  return (
    <div className="space-y-7">
      <Card>
        <CardHeader><CardTitle>Radar-Karte</CardTitle></CardHeader>
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <label className="space-y-2 text-sm text-muted">
            <span>Aktive Karte dieses Slots</span>
            <Select
              aria-label="Aktive Radar-Karte"
              value={activeMap}
              disabled={!canManage || updateConfig.isPending || config.isLoading}
              onChange={event => updateConfig.mutate(event.target.value as RadarMap)}
            >
              {Object.entries(MAP_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </Select>
          </label>
          <Badge variant="info">2.5D vorbereitet</Badge>
        </div>
        <p className="mt-4 text-xs leading-relaxed text-muted">Zonen anderer Karten bleiben gespeichert und werden erst mit ihrer aktiven Karte ausgewertet.</p>
        {updateConfig.isError && <p role="alert" className="mt-4 rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">{describeApiError(updateConfig.error).desc}</p>}
        <div className="mt-5">
          <Suspense fallback={<div className="h-[28rem] rounded-lg border border-border/70" aria-label="Radar-Karte wird geladen" />}>
            <DayzRadarMap activeMap={activeMap} zones={(zones.data?.zones ?? [])
              .filter(zone => zone.map === activeMap)
              .map(zone => ({ id: zone.id, name: zone.name, isActive: zone.isActive, geometry: zone.geometry }))} />
          </Suspense>
        </div>
      </Card>

      {editing && canManage && <Card className="p-5 sm:p-6">
        <CardHeader><CardTitle>{editorId === 'new' ? 'Neue Radar-Zone' : 'Radar-Zone bearbeiten'}</CardTitle></CardHeader>
        {editorLoading ? <p className="text-sm text-muted">Lade Editor...</p> : editorLoadError ? <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">{describeApiError(editorLoadError).desc}</p> : <>
          {mutationError && <p role="alert" className="mb-5 rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">{describeApiError(mutationError).desc}</p>}
          <ZoneEditor activeMap={activeMap} functions={(functions.data?.functions ?? []) as RadarFunctionDefinition[]} channels={channels.data?.channels ?? []} roles={roles.data?.roles ?? []} players={players.data?.players ?? []} zone={detail.data?.zone ?? null} saving={saveZone.isPending} deleting={deleteZone.isPending} onSave={payload => saveZone.mutate(payload)} onDelete={zone => deleteZone.mutate(zone)} />
        </>}
      </Card>}

      <Card>
        <CardHeader><CardTitle>Radar-Funktionen</CardTitle></CardHeader>
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(11rem,1fr))]" aria-label="Radar-Funktionen">
          {(functions.data?.functions ?? []).map(definition => (
            <div key={definition.key} className="min-w-0 rounded-lg border border-border/70 bg-bg-elev/40 p-4 text-center text-xs text-white">
              <MapPinned className="mx-auto mb-2 h-4 w-4 text-accent" aria-hidden="true" />
              <p className="break-words font-medium">{definition.label}</p>
              <p className="mt-1.5 text-[10px] text-muted">{definition.defaultEnabled ? 'Standard: AN' : 'Standard: AUS'}</p>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader className="justify-between gap-4"><CardTitle>Gespeicherte Zonen</CardTitle>{canManage && <Button size="sm" onClick={openNewEditor}><Plus className="h-4 w-4" />Zone</Button>}</CardHeader>
        {zones.isLoading ? <p className="text-sm text-muted">Lade Zonen...</p> : (zones.data?.zones.length ?? 0) === 0 ? <p className="text-sm text-muted">Noch keine Radar-Zone für diesen Slot gespeichert.</p> : (
          <div className="space-y-3">
            {zones.data?.zones.map(zone => (
              <div key={zone.id} className="rounded-lg border border-border/70 bg-bg-elev/40 p-4 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-3"><strong className="text-white">{zone.name}</strong><div className="flex items-center gap-2"><Badge variant={zone.isActive ? 'ok' : 'neutral'}>{zone.isActive ? 'Aktiv' : 'Inaktiv'}</Badge>{canManage && <Button variant="ghost" size="sm" aria-label={`${zone.name} bearbeiten`} onClick={() => setEditorId(zone.id)}><Pencil className="h-4 w-4" /></Button>}</div></div>
                <p className="mt-2 text-muted">{MAP_LABELS[zone.map]} · {zone.geometry.type === 'CIRCLE' ? `Kreis · ${zone.geometry.radiusMeters} m` : `Polygon · ${zone.geometry.points.length} Punkte`}</p>
                <p className="mt-1.5 text-muted">Funktionen: {zone.enabledFunctions.length} · Rollen-Ping: {zone.rolePingEnabled ? `AN · ${zone.roleIds.length} Rollen` : 'AUS'} · Allowlist: {zone.allowlist.length}</p>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
