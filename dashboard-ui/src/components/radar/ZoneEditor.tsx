import { lazy, Suspense, useEffect, useState } from 'react';
import { Plus, Save, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Switch } from '@/components/ui/Switch';

const DayzRadarMap = lazy(async () => ({ default: (await import('./DayzRadarMap')).DayzRadarMap }));

export type RadarMap = 'CHERNARUS' | 'LIVONIA' | 'SAKHAL';

export interface RadarFunctionDefinition {
  key: string;
  label: string;
  defaultEnabled: boolean;
}

export interface EditableRadarZone {
  id: string;
  version: number;
  name: string;
  map: RadarMap;
  isActive: boolean;
  channelId: string;
  rolePingEnabled: boolean;
  roleIds: string[];
  embedColor: string;
  enabledFunctions: string[];
  allowlist: Array<{ source: 'SERVER_WHITELIST' | 'MANUAL'; gameId: string; playerName: string | null }>;
  geometry: { type: 'CIRCLE'; x: number; y: number; radiusMeters: number } | { type: 'POLYGON'; points: Array<{ x: number; y: number }> };
}

const MAP_LABELS: Record<RadarMap, string> = {
  CHERNARUS: 'Chernarus',
  LIVONIA: 'Livonia',
  SAKHAL: 'Sakhal',
};

interface ChannelOption { id: string; name: string; type: number }
interface RoleOption { id: string; name: string; managed: boolean }

interface ZoneEditorProps {
  activeMap: RadarMap;
  functions: RadarFunctionDefinition[];
  channels: ChannelOption[];
  roles: RoleOption[];
  zone: EditableRadarZone | null;
  onSave: (zone: Omit<EditableRadarZone, 'id' | 'version'> & { version?: number }) => void;
  onDelete: (zone: EditableRadarZone) => void;
  saving: boolean;
  deleting: boolean;
}

function freshZone(activeMap: RadarMap, functions: RadarFunctionDefinition[]): Omit<EditableRadarZone, 'id' | 'version'> {
  return {
    name: '', map: activeMap, isActive: true, channelId: '', rolePingEnabled: true, roleIds: [], embedColor: '#dc2626',
    enabledFunctions: functions.filter(item => item.defaultEnabled).map(item => item.key), allowlist: [],
    geometry: { type: 'CIRCLE', x: 0, y: 0, radiusMeters: 100 },
  };
}

export function ZoneEditor({ activeMap, functions, channels, roles, zone, onSave, onDelete, saving, deleting }: ZoneEditorProps) {
  const [draft, setDraft] = useState<Omit<EditableRadarZone, 'id' | 'version'>>(() => freshZone(activeMap, functions));
  const [guid, setGuid] = useState('');
  const [pointX, setPointX] = useState('');
  const [pointY, setPointY] = useState('');

  useEffect(() => {
    setDraft(zone ? {
      name: zone.name, map: zone.map, isActive: zone.isActive, channelId: zone.channelId, rolePingEnabled: zone.rolePingEnabled,
      roleIds: zone.roleIds, embedColor: zone.embedColor, enabledFunctions: zone.enabledFunctions, allowlist: zone.allowlist, geometry: zone.geometry,
    } : freshZone(activeMap, functions));
  }, [zone, activeMap, functions]);

  const update = (patch: Partial<typeof draft>) => setDraft(current => ({ ...current, ...patch }));
  const toggleFunction = (key: string) => update({ enabledFunctions: draft.enabledFunctions.includes(key) ? draft.enabledFunctions.filter(value => value !== key) : [...draft.enabledFunctions, key] });
  const toggleRole = (roleId: string) => {
    const selected = draft.roleIds.includes(roleId);
    if (!selected && draft.roleIds.length >= 8) return;
    update({ roleIds: selected ? draft.roleIds.filter(value => value !== roleId) : [...draft.roleIds, roleId] });
  };
  const addAllowlist = () => {
    const gameId = guid.trim();
    if (!gameId || draft.allowlist.some(entry => entry.gameId === gameId)) return;
    update({ allowlist: [...draft.allowlist, { source: 'MANUAL', gameId, playerName: null }] });
    setGuid('');
  };
  const addPoint = () => {
    const x = Number(pointX); const y = Number(pointY);
    if (!Number.isFinite(x) || !Number.isFinite(y) || draft.geometry.type !== 'POLYGON') return;
    update({ geometry: { type: 'POLYGON', points: [...draft.geometry.points, { x, y }] } });
    setPointX(''); setPointY('');
  };
  const changeMap = (map: RadarMap) => {
    if (map === draft.map) return;
    if (!window.confirm('Beim Kartenwechsel wird nur die Zonengeometrie gelöscht. Alle übrigen Einstellungen bleiben erhalten. Fortfahren?')) return;
    update({ map, geometry: { type: 'CIRCLE', x: 0, y: 0, radiusMeters: 100 } });
  };
  const setGeometryPoint = (point: { x: number; y: number }) => {
    if (draft.geometry.type === 'CIRCLE') {
      update({ geometry: { ...draft.geometry, x: point.x, y: point.y } });
      return;
    }
    update({ geometry: { type: 'POLYGON', points: [...draft.geometry.points, point] } });
  };
  const submit = () => onSave({ ...draft, ...(zone ? { version: zone.version } : {}) });
  const circle = draft.geometry.type === 'CIRCLE' ? draft.geometry : null;
  const polygon = draft.geometry.type === 'POLYGON' ? draft.geometry : null;

  return (
    <div className="space-y-5" aria-label="Radar-Zoneneditor">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-1.5 text-sm text-muted"><span>Zonenname</span><Input value={draft.name} onChange={event => update({ name: event.target.value })} maxLength={120} /></label>
        <label className="space-y-1.5 text-sm text-muted"><span>Karte</span><Select value={draft.map} onChange={event => changeMap(event.target.value as RadarMap)}>{Object.entries(MAP_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></label>
      </div>
      <Switch checked={draft.isActive} onChange={isActive => update({ isActive })} label="Zone aktiv" />

      <fieldset className="space-y-3 border border-border/70 p-3"><legend className="px-1 text-sm font-medium text-white">Geometrie</legend>
        <div className="flex gap-4 text-sm text-muted"><label><input className="mr-2" type="radio" checked={draft.geometry.type === 'CIRCLE'} onChange={() => update({ geometry: { type: 'CIRCLE', x: 0, y: 0, radiusMeters: 100 } })} />Kreis</label><label><input className="mr-2" type="radio" checked={draft.geometry.type === 'POLYGON'} onChange={() => update({ geometry: { type: 'POLYGON', points: [] } })} />Polygon</label></div>
        <Suspense fallback={<div className="h-[28rem] border border-border/70" aria-label="Zonenkarte wird geladen" />}>
          <DayzRadarMap activeMap={draft.map} zones={[{ id: 'draft', name: draft.name || 'Aktuelle Zone', isActive: draft.isActive, geometry: draft.geometry }]} onMapClick={setGeometryPoint} />
        </Suspense>
        <p className="text-xs text-muted">{draft.geometry.type === 'CIRCLE' ? 'Klick setzt den Kreismittelpunkt.' : 'Jeder Klick fügt einen Polygonpunkt hinzu.'}</p>
        {circle ? <div className="grid gap-3 sm:grid-cols-3">{(['x', 'y', 'radiusMeters'] as const).map(key => <label key={key} className="space-y-1 text-sm text-muted"><span>{key === 'radiusMeters' ? 'Radius in Metern' : key.toUpperCase()}</span><Input type="number" value={circle[key]} onChange={event => update({ geometry: { ...circle, [key]: Number(event.target.value) } })} /></label>)}</div> : <div className="space-y-3"><div className="grid grid-cols-[1fr_1fr_auto] gap-2"><Input aria-label="Polygon X" type="number" value={pointX} onChange={event => setPointX(event.target.value)} /><Input aria-label="Polygon Y" type="number" value={pointY} onChange={event => setPointY(event.target.value)} /><Button variant="outline" aria-label="Polygonpunkt hinzufügen" onClick={addPoint}><Plus className="h-4 w-4" /></Button></div><ol className="space-y-1 text-xs text-muted">{polygon?.points.map((point, index) => <li key={`${point.x}-${point.y}-${index}`} className="flex items-center justify-between"><span>{point.x} / {point.y}</span><Button variant="ghost" size="sm" aria-label={`Polygonpunkt ${index + 1} entfernen`} onClick={() => update({ geometry: { type: 'POLYGON', points: (polygon?.points ?? []).filter((_, pointIndex) => pointIndex !== index) } })}><Trash2 className="h-3.5 w-3.5" /></Button></li>)}</ol></div>}
      </fieldset>

      <fieldset className="space-y-3 border border-border/70 p-3"><legend className="px-1 text-sm font-medium text-white">Funktionen</legend><div className="grid grid-cols-6 gap-2 overflow-x-auto">{functions.map(definition => <div key={definition.key} className="min-w-28 text-xs"><Switch checked={draft.enabledFunctions.includes(definition.key)} onChange={() => toggleFunction(definition.key)} label={definition.label} /></div>)}</div></fieldset>

      <fieldset className="space-y-3 border border-border/70 p-3"><legend className="px-1 text-sm font-medium text-white">Discord</legend><label className="space-y-1.5 text-sm text-muted"><span>Kanal</span><Select value={draft.channelId} onChange={event => update({ channelId: event.target.value })}><option value="">Kanal wählen</option>{channels.filter(channel => channel.type === 0 || channel.type === 5).map(channel => <option key={channel.id} value={channel.id}>#{channel.name}</option>)}</Select></label><Switch checked={draft.rolePingEnabled} onChange={rolePingEnabled => update({ rolePingEnabled })} label="Rollen-Ping" /><div className="grid gap-2 sm:grid-cols-2">{roles.filter(role => !role.managed).map(role => <label key={role.id} className="flex items-center gap-2 text-sm text-muted"><input type="checkbox" checked={draft.roleIds.includes(role.id)} disabled={!draft.rolePingEnabled || (!draft.roleIds.includes(role.id) && draft.roleIds.length >= 8)} onChange={() => toggleRole(role.id)} />@{role.name}</label>)}</div><label className="space-y-1.5 text-sm text-muted"><span>Embed-Farbe</span><Input value={draft.embedColor} onChange={event => update({ embedColor: event.target.value })} pattern="^#[0-9a-fA-F]{6}$" /></label></fieldset>

      <fieldset className="space-y-3 border border-border/70 p-3"><legend className="px-1 text-sm font-medium text-white">Allowlist</legend><div className="flex gap-2"><Input aria-label="BattlEye GUID" value={guid} onChange={event => setGuid(event.target.value)} placeholder="BattlEye GUID" /><Button variant="outline" aria-label="GUID zur Allowlist hinzufügen" onClick={addAllowlist}><Plus className="h-4 w-4" /></Button></div><div className="space-y-1 text-xs text-muted">{draft.allowlist.map(entry => <div key={entry.gameId} className="flex items-center justify-between"><span>{entry.gameId}</span><Button variant="ghost" size="sm" aria-label={`GUID ${entry.gameId} entfernen`} onClick={() => update({ allowlist: draft.allowlist.filter(value => value.gameId !== entry.gameId) })}><Trash2 className="h-3.5 w-3.5" /></Button></div>)}</div></fieldset>

      <div className="flex flex-wrap gap-2"><Button loading={saving} onClick={submit}><Save className="h-4 w-4" />Speichern</Button>{zone && <Button variant="danger" loading={deleting} onClick={() => onDelete(zone)}><Trash2 className="h-4 w-4" />Löschen</Button>}</div>
    </div>
  );
}