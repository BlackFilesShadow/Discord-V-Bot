import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Crosshair, Flag, Globe2, Hammer, Plus, Power, Trash2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import { useModalA11y } from '@/lib/useModalA11y';

type FeedKind = 'DEATH' | 'BUILD' | 'PLAYER_LIST' | 'FLAG';
type DeathCategory = 'PVP' | 'SUICIDE' | 'NPC' | 'VEHICLE';
type BuildCategory = 'PLACEMENT' | 'BUILD' | 'DISMANTLE' | 'DESTROY';
type FlagCategory = 'RAISED' | 'LOWERED';
type Category = DeathCategory | BuildCategory | FlagCategory;

interface GameplayFeedConfig {
  id: string;
  kind: FeedKind;
  nitradoConnId: string;
  channelId: string;
  isActive: boolean;
  categories: Category[];
  showActorCoords: boolean;
  showTargetCoords: boolean;
  showTool: boolean;
  showDistance: boolean;
  embedColor: string;
  lastEventAt: string | null;
  lastPolledAt: string | null;
  lastErrorMsg: string | null;
  openDeliveryCount: number;
  retryDeliveryCount: number;
  failedDeliveryCount: number;
  oldestOpenAt: string | null;
  lastSuccessAt: string | null;
  lastPlayerCount: number | null;
  lastPlayerListAt: string | null;
  playerListIntervalMinutes: number | null;
  nextPlayerListPostAt: string | null;
}

interface DiscordChannel { id: string; name: string; type: number; parentId: string | null }
interface Slot { id: string; slot: number; alias: string; alias5: string; status: 'ACTIVE' | 'EXPIRED' | 'REVOKED' }

const DEATH_LABELS: Record<DeathCategory, { label: string; icon: string }> = {
  PVP: { label: 'V-Kill Report', icon: '💀' },
  SUICIDE: { label: 'Self Kill Report', icon: '🩸' },
  NPC: { label: 'Wild Kill Report', icon: '☣️' },
  VEHICLE: { label: 'Crash Kill Report', icon: '💥' },
};

const BUILD_LABELS: Record<BuildCategory, { label: string; icon: string }> = {
  PLACEMENT: { label: 'Placement Report', icon: '📦' },
  BUILD: { label: 'Build Report', icon: '🔨' },
  DISMANTLE: { label: 'Dismantle Report', icon: '🔧' },
  DESTROY: { label: 'Destruction Report', icon: '💥' },
};

const FLAG_LABELS: Record<FlagCategory, { label: string; icon: string }> = {
  RAISED: { label: 'Flagge hoch', icon: '🚩' },
  LOWERED: { label: 'Flagge runter', icon: '🏳️' },
};

const DEFAULTS: Record<FeedKind, Category[]> = {
  DEATH: ['PVP', 'SUICIDE', 'NPC', 'VEHICLE'],
  BUILD: ['PLACEMENT', 'BUILD', 'DISMANTLE', 'DESTROY'],
  PLAYER_LIST: [],
  FLAG: ['RAISED'],
};
const FLAG_OPTIONS: FlagCategory[] = ['RAISED', 'LOWERED'];

function categoryMeta(kind: FeedKind, category: Category): { label: string; icon: string } | null {
  if (kind === 'DEATH') return DEATH_LABELS[category as DeathCategory] ?? null;
  if (kind === 'BUILD') return BUILD_LABELS[category as BuildCategory] ?? null;
  if (kind === 'FLAG') return FLAG_LABELS[category as FlagCategory] ?? null;
  return null;
}

function feedTitle(kind: FeedKind): string {
  if (kind === 'DEATH') return 'Deathfeed';
  if (kind === 'BUILD') return 'Baufeed';
  if (kind === 'FLAG') return 'Flaggen-Feed';
  return 'Online List';
}

export function KillfeedTab({ guildId, isOwner, slots }: { guildId: string; isOwner: boolean; slots: Slot[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [kind, setKind] = useState<FeedKind>('DEATH');
  const [activeSlot, setActiveSlot] = useState<number>(slots.find(s => s.status === 'ACTIVE')?.slot ?? slots[0]?.slot ?? 1);
  const [editing, setEditing] = useState<GameplayFeedConfig | 'new' | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const actionLock = useRef(false);

  const query = useQuery({
    queryKey: ['gameplay-feeds', guildId, activeSlot, kind],
    queryFn: () => api.get<{ kind: FeedKind; configs: GameplayFeedConfig[] }>(
      `/api/v2/guilds/${guildId}/killfeed?slot=${activeSlot}&kind=${kind}`,
    ),
    enabled: !!guildId && slots.length > 0,
  });
  const channelsQuery = useQuery({
    queryKey: ['guild-channels', guildId],
    queryFn: () => api.get<{ channels: DiscordChannel[] }>(`/api/v2/guilds/${guildId}/channels`),
    enabled: isOwner,
  });

  if (!isOwner) {
    return (
      <Card glow>
        <CardHeader><CardTitle>Nicht erlaubt</CardTitle></CardHeader>
        <p className="text-muted text-sm">Nur der Server-Owner oder berechtigte Manager können Gameplay-Feeds verwalten.</p>
      </Card>
    );
  }
  if (slots.length === 0) {
    return (
      <Card glow>
        <CardHeader><CardTitle>Keine Slots vorhanden</CardTitle></CardHeader>
        <p className="text-muted text-sm">Lege zuerst einen Nitrado-Slot an.</p>
      </Card>
    );
  }

  const configs = query.data?.configs ?? [];
  const channels = channelsQuery.data?.channels ?? [];
  const channelName = (id: string) => channels.find(c => c.id === id)?.name ?? id;
  const title = feedTitle(kind);
  const invalidate = () => qc.invalidateQueries({ queryKey: ['gameplay-feeds', guildId, activeSlot, kind] });

  const kindIcon = kind === 'DEATH'
    ? <Crosshair className="h-5 w-5 text-accent" />
    : kind === 'BUILD'
      ? <Hammer className="h-5 w-5 text-accent" />
      : kind === 'FLAG'
        ? <Flag className="h-5 w-5 text-accent" />
        : <Globe2 className="h-5 w-5 text-accent" />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-white inline-flex items-center gap-2">
            {kindIcon}
            Nitrado Gameplay-Feeds
          </h2>
          <p className="text-xs text-muted mt-0.5">Persistente ADM-V2-Zustellung mit Retry, Server-Scope und Event-Dedupe.</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Select value={kind} onChange={e => { setKind(e.target.value as FeedKind); setEditing(null); }}>
            <option value="DEATH">Deathfeed</option>
            <option value="BUILD">Baufeed</option>
            <option value="PLAYER_LIST">🌐 Online List</option>
            <option value="FLAG">🚩 Flaggen-Feed</option>
          </Select>
          <Select value={String(activeSlot)} onChange={e => { setActiveSlot(Number(e.target.value)); setEditing(null); }}>
            {slots.map(slot => (
              <option key={slot.id} value={slot.slot}>Slot #{slot.slot} · {slot.alias || slot.alias5}</option>
            ))}
          </Select>
          <Button size="sm" onClick={() => setEditing('new')}>
            <Plus className="h-4 w-4 mr-1" /> Neu
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 max-w-3xl">
        <button type="button" onClick={() => { setKind('DEATH'); setEditing(null); }} className={`rounded-lg border px-3 py-2 text-sm ${kind === 'DEATH' ? 'border-accent text-white bg-accent/10' : 'border-border text-muted'}`}>💀 Deathfeed</button>
        <button type="button" onClick={() => { setKind('BUILD'); setEditing(null); }} className={`rounded-lg border px-3 py-2 text-sm ${kind === 'BUILD' ? 'border-accent text-white bg-accent/10' : 'border-border text-muted'}`}>🔨 Baufeed</button>
        <button type="button" onClick={() => { setKind('PLAYER_LIST'); setEditing(null); }} className={`rounded-lg border px-3 py-2 text-sm ${kind === 'PLAYER_LIST' ? 'border-accent text-white bg-accent/10' : 'border-border text-muted'}`}>🌐 Online List</button>
        <button type="button" onClick={() => { setKind('FLAG'); setEditing(null); }} className={`rounded-lg border px-3 py-2 text-sm ${kind === 'FLAG' ? 'border-accent text-white bg-accent/10' : 'border-border text-muted'}`}>🚩 Flaggen-Feed</button>
      </div>

      {kind === 'FLAG' && (
        <Card className="!p-3">
          <p className="text-sm text-muted">Lege <strong className="text-white">Flagge hoch</strong> und <strong className="text-white">Flagge runter</strong> jeweils als eigene Konfiguration mit eigenem Discord-Kanal an. Jeder Flaggen-Post enthält den Button <strong className="text-white">🔎 Kurz-Online prüfen</strong>.</p>
        </Card>
      )}

      {query.isLoading && <div className="h-24 rounded-xl skeleton" />}
      {query.isError && <Card glow><p className="text-danger text-sm">{(query.error as Error).message}</p></Card>}
      {!query.isLoading && configs.length === 0 && <Card><p className="text-muted text-sm">Noch kein {title} für Slot #{activeSlot} eingerichtet.</p></Card>}

      <div className="grid gap-3">
        {configs.map(config => (
          <Card key={config.id} className="!p-4">
            <div className="flex items-start gap-3 flex-wrap">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="font-semibold text-white">#{channelName(config.channelId)}</h3>
                  {!config.isActive && <span className="text-[10px] bg-warn/20 text-warn px-1.5 py-0.5 rounded">inaktiv</span>}
                  {config.lastErrorMsg && <span className="text-[10px] bg-danger/20 text-danger px-1.5 py-0.5 rounded">Fehler</span>}
                </div>
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {config.categories.map(category => {
                    const meta = categoryMeta(kind, category);
                    return meta ? <span key={category} className="text-[10px] bg-bg-elev border border-border px-1.5 py-0.5 rounded">{meta.icon} {meta.label}</span> : null;
                  })}
                </div>
                <div className="text-[11px] text-muted mt-2 space-y-0.5">
                  <div>Letzter Poll: <span className="text-white">{config.lastPolledAt ? new Date(config.lastPolledAt).toLocaleString() : '—'}</span></div>
                  <div>Letztes Event: <span className="text-white">{config.lastEventAt ? new Date(config.lastEventAt).toLocaleString() : '—'}</span></div>
                  {kind !== 'PLAYER_LIST' && <>
                    <div>Offene Zustellungen: <span className="text-white">{config.openDeliveryCount}</span> · Retry: <span className="text-white">{config.retryDeliveryCount}</span> · Final fehlgeschlagen: <span className="text-white">{config.failedDeliveryCount}</span></div>
                    <div>Älteste offene: <span className="text-white">{config.oldestOpenAt ? new Date(config.oldestOpenAt).toLocaleString() : '—'}</span></div>
                    <div>Letzter Erfolg: <span className="text-white">{config.lastSuccessAt ? new Date(config.lastSuccessAt).toLocaleString() : '—'}</span></div>
                  </>}
                  {kind === 'FLAG' && <div>Koordinaten: Spieler <span className="text-white">{config.showActorCoords ? 'Aktiv' : 'Inaktiv'}</span> · Flagge <span className="text-white">{config.showTargetCoords ? 'Aktiv' : 'Inaktiv'}</span></div>}
                  {kind === 'PLAYER_LIST' && <>
                    <div>Online List: <span className="text-white">{config.isActive ? 'Aktiv' : 'Inaktiv'}</span> · Koordinaten: <span className="text-white">{config.showActorCoords ? 'Aktiv' : 'Inaktiv'}</span></div>
                    <div>Intervall: <span className="text-white">{config.playerListIntervalMinutes ? `alle ${config.playerListIntervalMinutes} Min.` : 'Aus – nur bei Änderung'}</span></div>
                    <div>Spieler online: <span className="text-white">{config.lastPlayerCount ?? '—'}</span></div>
                    <div>Letzte Online-List-Aktualisierung: <span className="text-white">{config.lastPlayerListAt ? new Date(config.lastPlayerListAt).toLocaleString() : '—'}</span></div>
                    {config.playerListIntervalMinutes && <div>Nächster Intervall-Post: <span className="text-white">{config.nextPlayerListPostAt ? new Date(config.nextPlayerListPostAt).toLocaleString() : 'beim nächsten Poll'}</span></div>}
                  </>}
                  {config.lastErrorMsg && <div className="text-danger break-words">⚠ {config.lastErrorMsg}</div>}
                </div>
              </div>
              <div className="flex gap-1.5">
                <Button
                  size="sm"
                  variant="ghost"
                  loading={pendingAction === `toggle:${config.id}`}
                  disabled={pendingAction !== null}
                  aria-label={`${title} ${config.isActive ? 'deaktivieren' : 'aktivieren'}`}
                  onClick={async () => {
                    if (actionLock.current) return;
                    actionLock.current = true;
                    setPendingAction(`toggle:${config.id}`);
                    try {
                      await api.patch(`/api/v2/guilds/${guildId}/killfeed/${config.id}?slot=${activeSlot}&kind=${kind}`, { isActive: !config.isActive });
                      toast.success(config.isActive ? `${title} deaktiviert.` : `${title} aktiviert.`);
                      invalidate();
                    } catch (error) {
                      toast.error(error instanceof ApiError ? error.message : 'Umschalten fehlgeschlagen.');
                    } finally {
                      actionLock.current = false;
                      setPendingAction(null);
                    }
                  }}
                ><Power className="h-3.5 w-3.5" /></Button>
                <Button size="sm" variant="outline" onClick={() => setEditing(config)}>Bearbeiten</Button>
                <Button
                  size="sm"
                  variant="danger"
                  loading={pendingAction === `delete:${config.id}`}
                  disabled={pendingAction !== null}
                  aria-label={`${title} für ${channelName(config.channelId)} löschen`}
                  onClick={async () => {
                    if (!confirm(`${title} in #${channelName(config.channelId)} wirklich löschen?`)) return;
                    if (actionLock.current) return;
                    actionLock.current = true;
                    setPendingAction(`delete:${config.id}`);
                    try {
                      await api.del(`/api/v2/guilds/${guildId}/killfeed/${config.id}?slot=${activeSlot}&kind=${kind}`);
                      toast.success(`${title} gelöscht.`);
                      invalidate();
                    } catch (error) {
                      toast.error(error instanceof ApiError ? error.message : 'Löschen fehlgeschlagen.');
                    } finally {
                      actionLock.current = false;
                      setPendingAction(null);
                    }
                  }}
                ><Trash2 className="h-3.5 w-3.5" /></Button>
              </div>
            </div>
          </Card>
        ))}
      </div>

      {editing && (
        <FeedEditor
          guildId={guildId}
          slot={activeSlot}
          kind={kind}
          existing={editing === 'new' ? null : editing}
          channels={channels}
          onClose={() => setEditing(null)}
          onSaved={() => {
            toast.success(`${title} gespeichert.`);
            setEditing(null);
            invalidate();
          }}
        />
      )}
    </div>
  );
}

function FeedEditor({
  guildId, slot, kind, existing, channels, onClose, onSaved,
}: {
  guildId: string;
  slot: number;
  kind: FeedKind;
  existing: GameplayFeedConfig | null;
  channels: DiscordChannel[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [channelId, setChannelId] = useState(existing?.channelId ?? '');
  const [categories, setCategories] = useState<Category[]>(existing?.categories ?? DEFAULTS[kind]);
  const [showActorCoords, setShowActorCoords] = useState(existing?.showActorCoords ?? true);
  const [showTargetCoords, setShowTargetCoords] = useState(existing?.showTargetCoords ?? (kind === 'FLAG'));
  const [showTool, setShowTool] = useState(existing?.showTool ?? (kind !== 'FLAG'));
  const [showDistance, setShowDistance] = useState(existing?.showDistance ?? (kind === 'DEATH'));
  const [embedColor, setEmbedColor] = useState(existing?.embedColor ?? (kind === 'BUILD' ? '#eab308' : kind === 'PLAYER_LIST' ? '#2563eb' : kind === 'FLAG' ? '#22c55e' : '#dc2626'));
  const [playerListIntervalMinutes, setPlayerListIntervalMinutes] = useState<number | null>(existing?.playerListIntervalMinutes ?? null);
  const [isActive, setIsActive] = useState(existing?.isActive ?? true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const modalRef = useModalA11y<HTMLDivElement>(onClose);
  const textChannels = channels.filter(channel => channel.type === 0 || channel.type === 5);
  const available: Category[] = kind === 'FLAG' ? FLAG_OPTIONS : DEFAULTS[kind];

  const toggleCategory = (category: Category) => {
    if (kind === 'FLAG') {
      setCategories([category]);
      if (!existing) setEmbedColor(category === 'RAISED' ? '#22c55e' : '#eab308');
      return;
    }
    setCategories(current => current.includes(category) ? current.filter(value => value !== category) : [...current, category]);
  };

  const save = async () => {
    setError(null);
    const invalidFlagCategories = kind === 'FLAG' && categories.length !== 1;
    if (!channelId || (kind !== 'PLAYER_LIST' && categories.length === 0) || invalidFlagCategories || !/^#[0-9a-fA-F]{6}$/.test(embedColor)) {
      setError(kind === 'FLAG'
        ? 'Channel, gültige Farbe und genau eine Flaggen-Aktion sind erforderlich.'
        : kind === 'PLAYER_LIST'
          ? 'Channel und gültige Farbe sind erforderlich.'
          : 'Channel, gültige Farbe und mindestens eine Kategorie sind erforderlich.');
      return;
    }
    setBusy(true);
    try {
      const body = {
        channelId,
        categories,
        showActorCoords,
        showTargetCoords,
        showTool: kind === 'FLAG' ? false : showTool,
        showDistance: kind === 'FLAG' ? false : showDistance,
        embedColor,
        isActive,
        ...(kind === 'PLAYER_LIST' ? { playerListIntervalMinutes } : {}),
      };
      const base = `/api/v2/guilds/${guildId}/killfeed`;
      if (existing) await api.patch(`${base}/${existing.id}?slot=${slot}&kind=${kind}`, body);
      else await api.post(`${base}?slot=${slot}&kind=${kind}`, body);
      onSaved();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Speichern fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 backdrop-blur-sm p-4" onClick={onClose}>
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className="w-full max-w-2xl max-h-[92vh] overflow-y-auto rounded-2xl border border-border bg-bg-card p-5 shadow-2xl outline-none"
        onClick={event => event.stopPropagation()}
      >
        <h3 className="text-lg font-semibold text-white">{kind === 'DEATH' ? 'Deathfeed' : kind === 'BUILD' ? 'Baufeed' : kind === 'FLAG' ? '🚩 Flaggen-Feed' : '🌐 Online List'} konfigurieren</h3>
        <div className="grid gap-4 mt-4">
          <label className="text-sm text-muted">Discord-Channel
            <Select className="mt-1 w-full" value={channelId} onChange={event => setChannelId(event.target.value)}>
              <option value="">Channel wählen…</option>
              {textChannels.map(channel => <option key={channel.id} value={channel.id}>#{channel.name}</option>)}
            </Select>
          </label>

          {kind !== 'PLAYER_LIST' && <div>
            <div className="text-sm text-muted mb-2">{kind === 'FLAG' ? 'Flaggen-Aktion – genau eine auswählen' : 'Kategorien'}</div>
            <div className="grid sm:grid-cols-2 gap-2">
              {available.map(category => {
                const meta = categoryMeta(kind, category);
                if (!meta) return null;
                return (
                  <label key={category} className="flex items-center gap-2 rounded-lg border border-border p-2 text-sm text-white">
                    <input type={kind === 'FLAG' ? 'radio' : 'checkbox'} name={kind === 'FLAG' ? 'flag-action' : undefined} checked={categories.includes(category)} onChange={() => toggleCategory(category)} />
                    <span>{meta.icon} {meta.label}</span>
                  </label>
                );
              })}
            </div>
          </div>}

          <div className="grid sm:grid-cols-2 gap-2 text-sm text-white">
            <label className="flex items-center gap-2"><input type="checkbox" checked={showActorCoords} onChange={e => setShowActorCoords(e.target.checked)} />{kind === 'DEATH' ? 'Opfer-Position' : kind === 'BUILD' ? 'Spieler-Position' : kind === 'FLAG' ? 'Spieler-Koordinaten' : 'Koordinaten anzeigen'}</label>
            {(kind === 'DEATH' || kind === 'FLAG') && <label className="flex items-center gap-2"><input type="checkbox" checked={showTargetCoords} onChange={e => setShowTargetCoords(e.target.checked)} />{kind === 'FLAG' ? 'Flaggen-Koordinaten' : 'Killer-Position'}</label>}
            {kind !== 'PLAYER_LIST' && kind !== 'FLAG' && <label className="flex items-center gap-2"><input type="checkbox" checked={showTool} onChange={e => setShowTool(e.target.checked)} />{kind === 'DEATH' ? 'Waffe / Ursache' : 'Werkzeug'}</label>}
            {kind === 'DEATH' && <label className="flex items-center gap-2"><input type="checkbox" checked={showDistance} onChange={e => setShowDistance(e.target.checked)} />Distanz</label>}
            <label className="flex items-center gap-2"><input type="checkbox" checked={isActive} onChange={e => setIsActive(e.target.checked)} />Aktiv</label>
          </div>

          {kind === 'PLAYER_LIST' && (
            <label className="text-sm text-muted">Online-List-Intervall
              <Select
                className="mt-1 w-full"
                value={playerListIntervalMinutes === null ? 'off' : String(playerListIntervalMinutes)}
                onChange={event => setPlayerListIntervalMinutes(event.target.value === 'off' ? null : Number(event.target.value))}
              >
                <option value="off">Aus – nur bei Änderung</option>
                <option value="5">Alle 5 Minuten</option>
                <option value="10">Alle 10 Minuten</option>
                <option value="15">Alle 15 Minuten</option>
                <option value="30">Alle 30 Minuten</option>
                <option value="60">Alle 60 Minuten</option>
              </Select>
            </label>
          )}

          <label className="text-sm text-muted">Embed-Farbe
            <Input className="mt-1" value={embedColor} onChange={event => setEmbedColor(event.target.value)} placeholder="#dc2626" />
          </label>

          {error && <p className="text-sm text-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose} disabled={busy}>Abbrechen</Button>
            <Button onClick={() => void save()} disabled={busy}>{busy ? 'Speichert…' : 'Speichern'}</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
