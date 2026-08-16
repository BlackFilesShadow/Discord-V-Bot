import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Crosshair, Hammer, Plus, Power, Trash2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import { useModalA11y } from '@/lib/useModalA11y';

type FeedKind = 'DEATH' | 'BUILD';
type DeathCategory = 'PVP' | 'DEATH' | 'SUICIDE' | 'NPC' | 'VEHICLE';
type BuildCategory = 'PLACEMENT' | 'BUILD' | 'DISMANTLE' | 'DESTROY';
type Category = DeathCategory | BuildCategory;

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
}

interface DiscordChannel { id: string; name: string; type: number; parentId: string | null }
interface Slot { id: string; slot: number; alias: string; alias5: string; status: 'ACTIVE' | 'EXPIRED' | 'REVOKED' }

const DEATH_LABELS: Record<DeathCategory, { label: string; icon: string }> = {
  PVP: { label: 'PvP-Kills', icon: '💀' },
  DEATH: { label: 'Allgemeiner Tod', icon: '☠️' },
  SUICIDE: { label: 'Suizid', icon: '🩸' },
  NPC: { label: 'NPC / Tiere / Zombies', icon: '🧟' },
  VEHICLE: { label: 'Fahrzeug-Tod', icon: '🚗' },
};

const BUILD_LABELS: Record<BuildCategory, { label: string; icon: string }> = {
  PLACEMENT: { label: 'Platziert', icon: '📦' },
  BUILD: { label: 'Gebaut', icon: '🔨' },
  DISMANTLE: { label: 'Demontiert', icon: '🧰' },
  DESTROY: { label: 'Zerstört', icon: '💥' },
};

const DEFAULTS: Record<FeedKind, Category[]> = {
  DEATH: ['PVP', 'DEATH', 'SUICIDE', 'NPC', 'VEHICLE'],
  BUILD: ['PLACEMENT', 'BUILD', 'DISMANTLE', 'DESTROY'],
};

function categoryMeta(kind: FeedKind, category: Category): { label: string; icon: string } {
  return kind === 'DEATH'
    ? DEATH_LABELS[category as DeathCategory]
    : BUILD_LABELS[category as BuildCategory];
}

export function KillfeedTab({ guildId, isOwner, slots }: { guildId: string; isOwner: boolean; slots: Slot[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [kind, setKind] = useState<FeedKind>('DEATH');
  const [activeSlot, setActiveSlot] = useState<number>(slots.find(s => s.status === 'ACTIVE')?.slot ?? slots[0]?.slot ?? 1);
  const [editing, setEditing] = useState<GameplayFeedConfig | 'new' | null>(null);

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
  const title = kind === 'DEATH' ? 'Deathfeed' : 'Baufeed';

  const invalidate = () => qc.invalidateQueries({ queryKey: ['gameplay-feeds', guildId, activeSlot, kind] });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-white inline-flex items-center gap-2">
            {kind === 'DEATH' ? <Crosshair className="h-5 w-5 text-accent" /> : <Hammer className="h-5 w-5 text-accent" />}
            Nitrado Gameplay-Feeds
          </h2>
          <p className="text-xs text-muted mt-0.5">
            Persistente ADM-V2-Zustellung mit Retry, Server-Scope und Event-Dedupe.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Select value={kind} onChange={e => { setKind(e.target.value as FeedKind); setEditing(null); }}>
            <option value="DEATH">Deathfeed</option>
            <option value="BUILD">Baufeed</option>
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

      <div className="grid grid-cols-2 gap-2 max-w-md">
        <button
          type="button"
          onClick={() => { setKind('DEATH'); setEditing(null); }}
          className={`rounded-lg border px-3 py-2 text-sm ${kind === 'DEATH' ? 'border-accent text-white bg-accent/10' : 'border-border text-muted'}`}
        >
          💀 Deathfeed
        </button>
        <button
          type="button"
          onClick={() => { setKind('BUILD'); setEditing(null); }}
          className={`rounded-lg border px-3 py-2 text-sm ${kind === 'BUILD' ? 'border-accent text-white bg-accent/10' : 'border-border text-muted'}`}
        >
          🔨 Baufeed
        </button>
      </div>

      {query.isLoading && <div className="h-24 rounded-xl skeleton" />}
      {query.isError && (
        <Card glow><p className="text-danger text-sm">{(query.error as Error).message}</p></Card>
      )}
      {!query.isLoading && configs.length === 0 && (
        <Card><p className="text-muted text-sm">Noch kein {title} für Slot #{activeSlot} eingerichtet.</p></Card>
      )}

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
                    return <span key={category} className="text-[10px] bg-bg-elev border border-border px-1.5 py-0.5 rounded">{meta.icon} {meta.label}</span>;
                  })}
                </div>
                <div className="text-[11px] text-muted mt-2 space-y-0.5">
                  <div>Letzter Poll: <span className="text-white">{config.lastPolledAt ? new Date(config.lastPolledAt).toLocaleString() : '—'}</span></div>
                  <div>Letztes Event: <span className="text-white">{config.lastEventAt ? new Date(config.lastEventAt).toLocaleString() : '—'}</span></div>
                  {config.lastErrorMsg && <div className="text-danger break-words">⚠ {config.lastErrorMsg}</div>}
                </div>
              </div>
              <div className="flex gap-1.5">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    try {
                      await api.patch(`/api/v2/guilds/${guildId}/killfeed/${config.id}?slot=${activeSlot}&kind=${kind}`, { isActive: !config.isActive });
                      toast.success(config.isActive ? `${title} deaktiviert.` : `${title} aktiviert.`);
                      invalidate();
                    } catch (error) {
                      toast.error(error instanceof ApiError ? error.message : 'Umschalten fehlgeschlagen.');
                    }
                  }}
                ><Power className="h-3.5 w-3.5" /></Button>
                <Button size="sm" variant="outline" onClick={() => setEditing(config)}>Bearbeiten</Button>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={async () => {
                    if (!confirm(`${title} in #${channelName(config.channelId)} wirklich löschen?`)) return;
                    try {
                      await api.del(`/api/v2/guilds/${guildId}/killfeed/${config.id}?slot=${activeSlot}&kind=${kind}`);
                      toast.success(`${title} gelöscht.`);
                      invalidate();
                    } catch (error) {
                      toast.error(error instanceof ApiError ? error.message : 'Löschen fehlgeschlagen.');
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
  const [showTargetCoords, setShowTargetCoords] = useState(existing?.showTargetCoords ?? false);
  const [showTool, setShowTool] = useState(existing?.showTool ?? true);
  const [showDistance, setShowDistance] = useState(existing?.showDistance ?? (kind === 'DEATH'));
  const [embedColor, setEmbedColor] = useState(existing?.embedColor ?? (kind === 'BUILD' ? '#eab308' : '#dc2626'));
  const [isActive, setIsActive] = useState(existing?.isActive ?? true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const modalRef = useModalA11y<HTMLDivElement>(onClose);
  const textChannels = channels.filter(channel => channel.type === 0 || channel.type === 5);
  const available = DEFAULTS[kind];

  const toggleCategory = (category: Category) => {
    setCategories(current => current.includes(category) ? current.filter(value => value !== category) : [...current, category]);
  };

  const save = async () => {
    setError(null);
    if (!channelId || categories.length === 0 || !/^#[0-9a-fA-F]{6}$/.test(embedColor)) {
      setError('Channel, gültige Farbe und mindestens eine Kategorie sind erforderlich.');
      return;
    }
    setBusy(true);
    try {
      const body = { channelId, categories, showActorCoords, showTargetCoords, showTool, showDistance, embedColor, isActive };
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
        <h3 className="text-lg font-semibold text-white">{kind === 'DEATH' ? 'Deathfeed' : 'Baufeed'} konfigurieren</h3>
        <div className="grid gap-4 mt-4">
          <label className="text-sm text-muted">Discord-Channel
            <Select className="mt-1 w-full" value={channelId} onChange={event => setChannelId(event.target.value)}>
              <option value="">Channel wählen…</option>
              {textChannels.map(channel => <option key={channel.id} value={channel.id}>#{channel.name}</option>)}
            </Select>
          </label>

          <div>
            <div className="text-sm text-muted mb-2">Kategorien</div>
            <div className="grid sm:grid-cols-2 gap-2">
              {available.map(category => {
                const meta = categoryMeta(kind, category);
                return (
                  <label key={category} className="flex items-center gap-2 rounded-lg border border-border p-2 text-sm text-white">
                    <input type="checkbox" checked={categories.includes(category)} onChange={() => toggleCategory(category)} />
                    <span>{meta.icon} {meta.label}</span>
                  </label>
                );
              })}
            </div>
          </div>

          <div className="grid sm:grid-cols-2 gap-2 text-sm text-white">
            <label className="flex items-center gap-2"><input type="checkbox" checked={showActorCoords} onChange={e => setShowActorCoords(e.target.checked)} />{kind === 'DEATH' ? 'Opfer-Position' : 'Spieler-Position'}</label>
            {kind === 'DEATH' && <label className="flex items-center gap-2"><input type="checkbox" checked={showTargetCoords} onChange={e => setShowTargetCoords(e.target.checked)} />Killer-Position</label>}
            <label className="flex items-center gap-2"><input type="checkbox" checked={showTool} onChange={e => setShowTool(e.target.checked)} />{kind === 'DEATH' ? 'Waffe / Ursache' : 'Werkzeug'}</label>
            {kind === 'DEATH' && <label className="flex items-center gap-2"><input type="checkbox" checked={showDistance} onChange={e => setShowDistance(e.target.checked)} />Distanz</label>}
            <label className="flex items-center gap-2"><input type="checkbox" checked={isActive} onChange={e => setIsActive(e.target.checked)} />Aktiv</label>
          </div>

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