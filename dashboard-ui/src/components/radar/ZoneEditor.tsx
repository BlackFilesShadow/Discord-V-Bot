import { lazy, Suspense, useEffect, useState } from 'react';
import { CircleDotDashed, MapPin, Plus, Save, Target, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Switch } from '@/components/ui/Switch';

const DayzRadarMap = lazy(async () => ({ default: (await import('./DayzRadarMap')).DayzRadarMap }));

export type RadarMap = 'CHERNARUS' | 'LIVONIA' | 'SAKHAL';
type GeometryInteractionMode = 'CIRCLE_CREATE' | 'CIRCLE_EDIT' | 'POLYGON_DRAW' | 'POLYGON_EDIT';

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
interface RadarPlayerOption { gameId: string; playerName: string }

interface ZoneEditorProps {
  activeMap: RadarMap;
  functions: RadarFunctionDefinition[];
  channels: ChannelOption[];
  roles: RoleOption[];
  players: RadarPlayerOption[];
  zone: EditableRadarZone | null;
  onSave: (zone: Omit<EditableRadarZone, 'id' | 'version'> & { version?: number }) => void;
  onDelete: (zone: EditableRadarZone) => void;
  saving: boolean;
  deleting: boolean;
}

function freshZone(activeMap: RadarMap, functions: RadarFunctionDefinition[]): Omit<EditableRadarZone, 'id' | 'version'> {
  return {
    name: '', map: activeMap, isActive: true, channelId: '', rolePingEnabled: false, roleIds: [], embedColor: '#dc2626',
    enabledFunctions: functions.filter(item => item.defaultEnabled).map(item => item.key), allowlist: [],
    geometry: { type: 'CIRCLE', x: 0, y: 0, radiusMeters: 100 },
  };
}

function initialMode(zone: EditableRadarZone | null): GeometryInteractionMode {
  if (!zone) return 'CIRCLE_CREATE';
  return zone.geometry.type === 'CIRCLE' ? 'CIRCLE_EDIT' : 'POLYGON_EDIT';
}

export function ZoneEditor({ activeMap, functions, channels, roles, players, zone, onSave, onDelete, saving, deleting }: ZoneEditorProps) {
  const [draft, setDraft] = useState<Omit<EditableRadarZone, 'id' | 'version'>>(() => freshZone(activeMap, functions));
  const [interactionMode, setInteractionMode] = useState<GeometryInteractionMode>(() => initialMode(zone));
  const [guid, setGuid] = useState('');
  const [selectedPlayerGameId, setSelectedPlayerGameId] = useState('');
  const [pointX, setPointX] = useState('');
  const [pointY, setPointY] = useState('');

  useEffect(() => {
    setDraft(zone ? {
      name: zone.name, map: zone.map, isActive: zone.isActive, channelId: zone.channelId, rolePingEnabled: zone.rolePingEnabled,
      roleIds: zone.roleIds, embedColor: zone.embedColor, enabledFunctions: zone.enabledFunctions, allowlist: zone.allowlist, geometry: zone.geometry,
    } : freshZone(activeMap, functions));
    setInteractionMode(initialMode(zone));
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
  const addSelectedPlayer = () => {
    const player = players.find(item => item.gameId === selectedPlayerGameId);
    if (!player || draft.allowlist.some(entry => entry.gameId === player.gameId)) return;
    update({ allowlist: [...draft.allowlist, { source: 'MANUAL', gameId: player.gameId, playerName: player.playerName }] });
    setSelectedPlayerGameId('');
  };
  const addPoint = () => {
    const x = Number(pointX); const y = Number(pointY);
    if (!Number.isFinite(x) || !Number.isFinite(y) || draft.geometry.type !== 'POLYGON' || interactionMode !== 'POLYGON_DRAW') return;
    update({ geometry: { type: 'POLYGON', points: [...draft.geometry.points, { x, y }] } });
    setPointX(''); setPointY('');
  };
  const changeMap = (map: RadarMap) => {
    if (map === draft.map) return;
    if (!window.confirm('Beim Kartenwechsel wird nur die Zonengeometrie gelöscht. Alle übrigen Einstellungen bleiben erhalten. Fortfahren?')) return;
    update({ map, geometry: { type: 'CIRCLE', x: 0, y: 0, radiusMeters: 100 } });
    setInteractionMode('CIRCLE_CREATE');
  };
  const appendPolygonPoint = (point: { x: number; y: number }) => {
    if (draft.geometry.type !== 'POLYGON' || interactionMode !== 'POLYGON_DRAW') return;
    update({ geometry: { type: 'POLYGON', points: [...draft.geometry.points, point] } });
  };
  const submit = () => {
    if (draft.geometry.type === 'POLYGON' && interactionMode === 'POLYGON_DRAW') return;
    onSave({ ...draft, ...(zone ? { version: zone.version } : {}) });
  };
  const circle = draft.geometry.type === 'CIRCLE' ? draft.geometry : null;
  const polygon = draft.geometry.type === 'POLYGON' ? draft.geometry : null;
  const polygonOpen = draft.geometry.type === 'POLYGON' && interactionMode === 'POLYGON_DRAW';

  return (
    <div className="space-y-5" aria-label="Radar-Zoneneditor">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-1.5 text-sm text-muted"><span>Zonenname</span><Input value={draft.name} onChange={event => update({ name: event.target.value })} maxLength={120} /></label>
        <label className="space-y-1.5 text-sm text-muted"><span>Karte</span><Select value={draft.map} onChange={event => changeMap(event.target.value as RadarMap)}>{Object.entries(MAP_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></label>
      </div>
      <Switch checked={draft.isActive} onChange={isActive => update({ isActive })} label="Zone aktiv" />

      <fieldset className="space-y-3 border border-border/70 p-3"><legend className="px-1 text-sm font-medium text-white">Geometrie</legend>
        <div className="grid gap-2 sm:grid-cols-2" role="group" aria-label="Zonenform auswählen">
          <button type="button" aria-pressed={draft.geometry.type === 'CIRCLE'} onClick={() => { update({ geometry: { type: 'CIRCLE', x: 0, y: 0, radiusMeters: 100 } }); setInteractionMode('CIRCLE_CREATE'); }} className={`flex min-h-12 items-center gap-3 border p-3 text-left text-sm ${draft.geometry.type === 'CIRCLE' ? 'border-danger bg-danger/15 text-white' : 'border-border/70 bg-bg-elev/40 text-muted'}`}><CircleDotDashed className="h-5 w-5 shrink-0" aria-hidden="true" /><span><strong className="block text-white">Kreis</strong><span className="text-xs">Drücken, ziehen, loslassen</span></span></button>
          <button type="button" aria-pressed={draft.geometry.type === 'POLYGON'} onClick={() => { update({ geometry: { type: 'POLYGON', points: [] } }); setInteractionMode('POLYGON_DRAW'); }} className={`flex min-h-12 items-center gap-3 border p-3 text-left text-sm ${draft.geometry.type === 'POLYGON' ? 'border-danger bg-danger/15 text-white' : 'border-border/70 bg-bg-elev/40 text-muted'}`}><MapPin className="h-5 w-5 shrink-0" aria-hidden="true" /><span><strong className="block text-white">Polygon</strong><span className="text-xs">Eckpunkte setzen und am ersten schließen</span></span></button>
        </div>
        <Suspense fallback={<div className="h-[28rem] border border-border/70" aria-label="Zonenkarte wird geladen" />}>
          <DayzRadarMap
            activeMap={draft.map}
            interactionMode={interactionMode}
            zones={[{ id: 'draft', name: draft.name || 'Aktuelle Zone', isActive: draft.isActive, isDraft: true, geometry: draft.geometry }]}
            onMapClick={appendPolygonPoint}
            focusPoint={interactionMode === 'CIRCLE_EDIT' && circle ? circle : undefined}
            onCircleCreate={(center, radiusMeters) => {
              update({ geometry: { type: 'CIRCLE', x: center.x, y: center.y, radiusMeters } });
              setInteractionMode('CIRCLE_EDIT');
            }}
            onCircleCenterChange={point => circle && update({ geometry: { ...circle, x: point.x, y: point.y } })}
            onCircleRadiusChange={radiusMeters => circle && update({ geometry: { ...circle, radiusMeters } })}
            onPolygonClose={() => setInteractionMode('POLYGON_EDIT')}
            onPolygonVertexChange={(index, point) => polygon && update({ geometry: { type: 'POLYGON', points: polygon.points.map((current, currentIndex) => currentIndex === index ? point : current) } })}
            onPolygonInsert={(index, point) => polygon && update({ geometry: { type: 'POLYGON', points: [...polygon.points.slice(0, index), point, ...polygon.points.slice(index)] } })}
            onPolygonMove={points => polygon && update({ geometry: { type: 'POLYGON', points } })}
          />
        </Suspense>
        <p className="text-xs text-muted">{interactionMode === 'CIRCLE_CREATE' ? 'Halte die linke Maustaste gedrückt, ziehe den Kreis auf und lasse los.' : interactionMode === 'CIRCLE_EDIT' ? 'Ziehe den roten Mittelpunkt zum Verschieben oder den weißen Griff am Rand, um den Radius zu ändern.' : interactionMode === 'POLYGON_DRAW' ? 'Setze Eckpunkte. Die rote Vorschau-Linie folgt der Maus; ab drei Punkten schließt ein Klick auf den ersten roten Punkt die Zone.' : 'Ziehe rote Eckpunkte zum Bearbeiten. Die weißen Zwischenpunkte fügen neue Eckpunkte ein; die Fläche selbst verschiebt die gesamte Zone.'}</p>
        {circle ? <div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-sm text-muted"><span>Mittelpunkt X</span><Input type="number" value={circle.x} onChange={event => update({ geometry: { ...circle, x: Number(event.target.value) } })} /></label><label className="space-y-1 text-sm text-muted"><span>Mittelpunkt Y</span><Input type="number" value={circle.y} onChange={event => update({ geometry: { ...circle, y: Number(event.target.value) } })} /></label><label className="space-y-1 text-sm text-muted sm:col-span-2"><span>Kreisradius in Metern</span><Input aria-label="Kreisradius in Metern" type="number" min="1" value={circle.radiusMeters} onChange={event => update({ geometry: { ...circle, radiusMeters: Math.max(1, Number(event.target.value)) } })} /></label><div className="flex items-center justify-between border border-border/70 p-3 sm:col-span-2"><span className="text-sm text-muted">Kreisradius <strong className="text-white">{circle.radiusMeters} m</strong></span><Button variant="outline" size="sm" onClick={() => setInteractionMode('CIRCLE_CREATE')}><Target className="h-4 w-4" />Mittelpunkt neu setzen</Button></div></div> : <div className="space-y-3"><div className="grid grid-cols-[1fr_1fr_auto] gap-2"><Input aria-label="Polygon X" type="number" value={pointX} disabled={!polygonOpen} onChange={event => setPointX(event.target.value)} /><Input aria-label="Polygon Y" type="number" value={pointY} disabled={!polygonOpen} onChange={event => setPointY(event.target.value)} /><Button variant="outline" aria-label="Polygonpunkt hinzufügen" disabled={!polygonOpen} onClick={addPoint}><Plus className="h-4 w-4" /></Button></div><div className="flex items-center justify-between gap-3"><p className="text-xs text-muted">{polygon?.points.length ?? 0} Punkte gesetzt</p><Button variant="outline" size="sm" disabled={(polygon?.points.length ?? 0) === 0} onClick={() => { update({ geometry: { type: 'POLYGON', points: [] } }); setInteractionMode('POLYGON_DRAW'); }}>Polygon leeren</Button></div><ol className="space-y-1 text-xs text-muted">{polygon?.points.map((point, index) => <li key={`${point.x}-${point.y}-${index}`} className="flex items-center justify-between border-b border-border/50 py-1"><span>{index + 1}. {point.x.toFixed(1)} / {point.y.toFixed(1)}</span><Button variant="ghost" size="sm" aria-label={`Polygonpunkt ${index + 1} entfernen`} disabled={polygon.points.length <= 3 || polygonOpen} onClick={() => update({ geometry: { type: 'POLYGON', points: (polygon?.points ?? []).filter((_, pointIndex) => pointIndex !== index) } })}><Trash2 className="h-3.5 w-3.5" /></Button></li>)}</ol></div>}
      </fieldset>

      <fieldset className="space-y-3 border border-border/70 p-3"><legend className="px-1 text-sm font-medium text-white">Funktionen</legend><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">{functions.map(definition => <div key={definition.key} className="min-w-0 border border-border/70 bg-bg-elev/40 p-3"><Switch checked={draft.enabledFunctions.includes(definition.key)} onChange={() => toggleFunction(definition.key)} label={definition.label} /></div>)}</div></fieldset>

      <fieldset className="space-y-3 border border-border/70 p-3"><legend className="px-1 text-sm font-medium text-white">Discord</legend><label className="space-y-1.5 text-sm text-muted"><span>Kanal</span><Select value={draft.channelId} onChange={event => update({ channelId: event.target.value })}><option value="">Kanal wählen</option>{channels.filter(channel => channel.type === 0 || channel.type === 5).map(channel => <option key={channel.id} value={channel.id}>#{channel.name}</option>)}</Select></label><Switch checked={draft.rolePingEnabled} onChange={rolePingEnabled => update({ rolePingEnabled })} label="Rollen-Ping" /><div className="grid gap-2 sm:grid-cols-2">{roles.filter(role => !role.managed).map(role => <label key={role.id} className="flex items-center gap-2 text-sm text-muted"><input type="checkbox" checked={draft.roleIds.includes(role.id)} disabled={!draft.rolePingEnabled || (!draft.roleIds.includes(role.id) && draft.roleIds.length >= 8)} onChange={() => toggleRole(role.id)} />@{role.name}</label>)}</div><label className="space-y-1.5 text-sm text-muted"><span>Embed-Farbe</span><Input value={draft.embedColor} onChange={event => update({ embedColor: event.target.value })} pattern="^#[0-9a-fA-F]{6}$" /></label></fieldset>

      <fieldset className="space-y-3 border border-border/70 p-3"><legend className="px-1 text-sm font-medium text-white">Allowlist</legend><label className="space-y-1.5 text-sm text-muted"><span>Bekannten PSN-/Xbox-Spieler auswählen</span><div className="flex gap-2"><Select aria-label="Bekannten Spieler auswählen" value={selectedPlayerGameId} onChange={event => setSelectedPlayerGameId(event.target.value)}><option value="">Spieler auswählen</option>{players.map(player => <option key={player.gameId} value={player.gameId}>{player.playerName}</option>)}</Select><Button variant="outline" aria-label="Ausgewählten Spieler zur Allowlist hinzufügen" disabled={!selectedPlayerGameId} onClick={addSelectedPlayer}><Plus className="h-4 w-4" /></Button></div></label><label className="space-y-1.5 text-sm text-muted"><span>Oder BattlEye GUID manuell eintragen</span><div className="flex gap-2"><Input aria-label="BattlEye GUID" value={guid} onChange={event => setGuid(event.target.value)} placeholder="BattlEye GUID" /><Button variant="outline" aria-label="GUID zur Allowlist hinzufügen" onClick={addAllowlist}><Plus className="h-4 w-4" /></Button></div></label><div className="space-y-1 text-xs text-muted">{draft.allowlist.map(entry => <div key={entry.gameId} className="flex items-center justify-between"><span>{entry.playerName ? `${entry.playerName} · ` : ''}{entry.gameId}</span><Button variant="ghost" size="sm" aria-label={`GUID ${entry.gameId} entfernen`} onClick={() => update({ allowlist: draft.allowlist.filter(value => value.gameId !== entry.gameId) })}><Trash2 className="h-3.5 w-3.5" /></Button></div>)}</div></fieldset>

      <div className="flex flex-wrap gap-2"><Button loading={saving} disabled={polygonOpen} onClick={submit}><Save className="h-4 w-4" />Speichern</Button>{zone && <Button variant="danger" loading={deleting} onClick={() => onDelete(zone)}><Trash2 className="h-4 w-4" />Löschen</Button>}</div>
    </div>
  );
}
