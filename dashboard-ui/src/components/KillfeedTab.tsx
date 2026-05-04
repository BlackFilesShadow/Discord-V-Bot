/**
 * Killfeed-Konfigurationen (Guild-Level, multi-Feed pro Slot).
 *
 * Backend: GET/POST/PATCH/DELETE /api/v2/guilds/:guildId/killfeed[?slot=X][/:id]
 * Live-Watcher pollt alle 60s pro aktivem Slot via Long-Life-Token.
 * Kategorien: DEATH (PvP), SUICIDE (Selbstmord), NPC (Zombie/Tier), VEHICLE.
 */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Power, Crosshair } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import { useModalA11y } from '@/lib/useModalA11y';

type Category = 'DEATH' | 'SUICIDE' | 'NPC' | 'VEHICLE';

interface KillfeedConfig {
  id: string;
  nitradoConnId: string;
  channelId: string;
  isActive: boolean;
  categories: Category[];
  showShooterCoords: boolean;
  showVictimCoords: boolean;
  showWeapon: boolean;
  showDistance: boolean;
  embedColor: string;
  lastEventAt: string | null;
  lastFileName: string | null;
  lastPolledAt: string | null;
  lastErrorMsg: string | null;
}

interface DiscordChannel { id: string; name: string; type: number; parentId: string | null }

interface Slot {
  id: string;
  slot: number;
  alias: string;
  alias5: string;
  status: 'ACTIVE' | 'EXPIRED' | 'REVOKED';
}

const KILLFEED_COLOR_PRESETS: Array<{ name: string; hex: string }> = [
  { name: 'Rot',    hex: '#dc2626' },
  { name: 'Orange', hex: '#f97316' },
  { name: 'Gold',   hex: '#eab308' },
  { name: 'Grün',   hex: '#22c55e' },
  { name: 'Blau',   hex: '#3b82f6' },
  { name: 'Lila',   hex: '#8b5cf6' },
  { name: 'Grau',   hex: '#6b7280' },
];

const CATEGORY_LABELS: Record<Category, { label: string; icon: string; desc: string }> = {
  DEATH:   { label: 'Deathfeed',     icon: '💀', desc: 'PvP-Kills (Spieler vs. Spieler)' },
  SUICIDE: { label: 'Suizid-Feed',   icon: '🩸', desc: 'Selbstmord / Sturzschaden / Hunger / Durst' },
  NPC:     { label: 'NPC/Zombies',   icon: '🧟', desc: 'Tod durch Zombies / Tiere / NPCs' },
  VEHICLE: { label: 'Fahrzeug-Tod',  icon: '🚗', desc: 'Tod durch Fahrzeug-Unfälle' },
};

export function KillfeedTab({ guildId, isOwner, slots }: { guildId: string; isOwner: boolean; slots: Slot[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [activeSlot, setActiveSlot] = useState<number>(slots.find(s => s.status === 'ACTIVE')?.slot ?? slots[0]?.slot ?? 1);

  const q = useQuery({
    queryKey: ['killfeed', guildId, activeSlot],
    queryFn: () => api.get<{ configs: KillfeedConfig[] }>(`/api/v2/guilds/${guildId}/killfeed?slot=${activeSlot}`),
    enabled: !!guildId && slots.length > 0,
  });
  const channelsQ = useQuery({
    queryKey: ['guild-channels', guildId],
    queryFn: () => api.get<{ channels: DiscordChannel[] }>(`/api/v2/guilds/${guildId}/channels`),
    enabled: isOwner,
  });

  const [editing, setEditing] = useState<{ existing: KillfeedConfig | null } | null>(null);

  if (!isOwner) {
    return (
      <Card glow>
        <CardHeader><CardTitle>Nicht erlaubt</CardTitle></CardHeader>
        <p className="text-muted text-sm">Nur der Discord-Server-Owner oder berechtigte Manager können Killfeeds verwalten.</p>
      </Card>
    );
  }

  if (slots.length === 0) {
    return (
      <Card glow>
        <CardHeader><CardTitle>Keine Slots vorhanden</CardTitle></CardHeader>
        <p className="text-muted text-sm">Lege zuerst einen Nitrado-Slot an, bevor du Killfeeds konfigurieren kannst.</p>
      </Card>
    );
  }

  const configs = q.data?.configs ?? [];
  const channels = channelsQ.data?.channels ?? [];
  const channelName = (id: string) => channels.find(c => c.id === id)?.name ?? id;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-lg font-semibold text-white inline-flex items-center gap-2">
            <Crosshair className="h-5 w-5 text-accent" />
            Killfeed
          </h2>
          <p className="text-xs text-muted mt-0.5">
            Live-Polling alle 60s vom Nitrado-ADM-Log. Pro Konfiguration ein Channel + Kategorien-Auswahl.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={String(activeSlot)} onChange={e => setActiveSlot(Number(e.target.value))}>
            {slots.map(s => (
              <option key={s.id} value={s.slot}>
                Slot #{s.slot} · {s.alias || s.alias5}
              </option>
            ))}
          </Select>
          <Button size="sm" onClick={() => setEditing({ existing: null })}>
            <Plus className="h-4 w-4 mr-1" /> Neu
          </Button>
        </div>
      </div>

      {q.isLoading && <div className="h-24 rounded-xl skeleton" />}
      {q.isError && (
        <Card glow>
          <p className="text-danger font-medium">Fehler beim Laden.</p>
          <p className="text-muted text-sm mt-1">{(q.error as Error).message}</p>
        </Card>
      )}

      {!q.isLoading && configs.length === 0 && (
        <Card>
          <p className="text-muted text-sm">Noch keine Killfeed-Konfiguration für Slot #{activeSlot}. Klick „Neu" um einen zu erstellen.</p>
        </Card>
      )}

      <div className="grid gap-3">
        {configs.map(cfg => (
          <KillfeedConfigCard
            key={cfg.id}
            config={cfg}
            channelName={channelName}
            onEdit={() => setEditing({ existing: cfg })}
            onToggle={async () => {
              try {
                await api.patch(`/api/v2/guilds/${guildId}/killfeed/${cfg.id}?slot=${activeSlot}`, { isActive: !cfg.isActive });
                toast.success(cfg.isActive ? 'Killfeed deaktiviert.' : 'Killfeed aktiviert.');
                qc.invalidateQueries({ queryKey: ['killfeed', guildId, activeSlot] });
              } catch (e) {
                toast.error(e instanceof ApiError ? e.message : 'Fehler beim Umschalten.');
              }
            }}
            onDelete={async () => {
              if (!confirm(`Killfeed in #${channelName(cfg.channelId)} wirklich löschen? Bereits gepostete Embeds bleiben erhalten.`)) return;
              try {
                await api.del(`/api/v2/guilds/${guildId}/killfeed/${cfg.id}?slot=${activeSlot}`);
                toast.success('Killfeed gelöscht.');
                qc.invalidateQueries({ queryKey: ['killfeed', guildId, activeSlot] });
              } catch (e) {
                toast.error(e instanceof ApiError ? e.message : 'Löschen fehlgeschlagen.');
              }
            }}
          />
        ))}
      </div>

      {editing && (
        <KillfeedEditModal
          guildId={guildId}
          slot={activeSlot}
          existing={editing.existing}
          channels={channels}
          onClose={() => setEditing(null)}
          onSaved={() => {
            toast.success(editing.existing ? 'Killfeed gespeichert.' : 'Killfeed angelegt.');
            qc.invalidateQueries({ queryKey: ['killfeed', guildId, activeSlot] });
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function KillfeedConfigCard({
  config, channelName, onEdit, onToggle, onDelete,
}: {
  config: KillfeedConfig;
  channelName: (id: string) => string;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const cats = config.categories.map(c => CATEGORY_LABELS[c]);
  const lastPoll = config.lastPolledAt ? new Date(config.lastPolledAt).toLocaleString() : '—';
  const lastEvent = config.lastEventAt ? new Date(config.lastEventAt).toLocaleString() : '—';

  return (
    <Card className="!p-4">
      <div className="flex items-start gap-3 flex-wrap">
        <div
          className="h-10 w-10 rounded-md grid place-items-center font-bold text-sm shrink-0 border"
          style={{ backgroundColor: config.embedColor + '22', borderColor: config.embedColor + '55', color: config.embedColor }}
        >
          <Crosshair className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-semibold text-white truncate">#{channelName(config.channelId)}</h3>
            {!config.isActive && <span className="text-[10px] bg-warn/20 text-warn px-1.5 py-0.5 rounded">inaktiv</span>}
            {config.lastErrorMsg && <span className="text-[10px] bg-danger/20 text-danger px-1.5 py-0.5 rounded" title={config.lastErrorMsg}>Fehler</span>}
          </div>
          <div className="flex flex-wrap gap-1 mt-1.5">
            {cats.map(c => (
              <span key={c.label} className="text-[10px] bg-bg-elev border border-border px-1.5 py-0.5 rounded inline-flex items-center gap-1">
                <span>{c.icon}</span>{c.label}
              </span>
            ))}
          </div>
          <div className="text-[11px] text-muted mt-2 space-y-0.5">
            <div>Letzter Poll: <span className="text-white">{lastPoll}</span></div>
            <div>Letztes Event: <span className="text-white">{lastEvent}</span></div>
            <div>
              Anzeigen:{' '}
              {config.showShooterCoords && <span className="text-white">Schütze-Pos </span>}
              {config.showVictimCoords && <span className="text-white">Opfer-Pos </span>}
              {config.showWeapon && <span className="text-white">Waffe </span>}
              {config.showDistance && <span className="text-white">Distanz</span>}
            </div>
            {config.lastErrorMsg && <div className="text-danger truncate" title={config.lastErrorMsg}>⚠ {config.lastErrorMsg}</div>}
          </div>
        </div>
        <div className="flex flex-col sm:flex-row gap-1.5 shrink-0">
          <Button size="sm" variant="ghost" onClick={onToggle} title={config.isActive ? 'Deaktivieren' : 'Aktivieren'}>
            <Power className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="outline" onClick={onEdit}>Bearbeiten</Button>
          <Button size="sm" variant="danger" onClick={onDelete}><Trash2 className="h-3.5 w-3.5" /></Button>
        </div>
      </div>
    </Card>
  );
}

function KillfeedEditModal({
  guildId, slot, existing, channels, onClose, onSaved,
}: {
  guildId: string;
  slot: number;
  existing: KillfeedConfig | null;
  channels: DiscordChannel[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [channelId, setChannelId] = useState(existing?.channelId ?? '');
  const [categories, setCategories] = useState<Category[]>(existing?.categories ?? ['DEATH']);
  const [showShooterCoords, setShowShooterCoords] = useState(existing?.showShooterCoords ?? false);
  const [showVictimCoords, setShowVictimCoords] = useState(existing?.showVictimCoords ?? true);
  const [showWeapon, setShowWeapon] = useState(existing?.showWeapon ?? true);
  const [showDistance, setShowDistance] = useState(existing?.showDistance ?? true);
  const [embedColor, setEmbedColor] = useState(existing?.embedColor ?? '#dc2626');
  const [isActive, setIsActive] = useState(existing?.isActive ?? true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const textChannels = channels.filter(c => c.type === 0 || c.type === 5);

  const toggleCategory = (c: Category) => {
    setCategories(prev => prev.includes(c) ? prev.filter(x => x !== c) : [...prev, c]);
  };

  const valid = !!channelId && categories.length > 0 && /^#[0-9a-fA-F]{6}$/.test(embedColor);

  const modalRef = useModalA11y<HTMLDivElement>(onClose);

  const save = async () => {
    setErr(null);
    if (!valid) { setErr('Channel und mindestens eine Kategorie erforderlich.'); return; }
    setBusy(true);
    try {
      const body = {
        channelId,
        categories,
        showShooterCoords,
        showVictimCoords,
        showWeapon,
        showDistance,
        embedColor,
        isActive,
      };
      if (existing) {
        await api.patch(`/api/v2/guilds/${guildId}/killfeed/${existing.id}?slot=${slot}`, body);
      } else {
        await api.post(`/api/v2/guilds/${guildId}/killfeed?slot=${slot}`, body);
      }
      onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Unbekannter Fehler');
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
        aria-labelledby="killfeed-modal-title"
        tabIndex={-1}
        className="relative w-full max-w-2xl max-h-[92vh] overflow-y-auto rounded-2xl border border-border bg-bg-card shadow-2xl outline-none"
        onClick={e => e.stopPropagation()}
        style={{
          backgroundImage: `radial-gradient(1200px 400px at 0% 0%, ${embedColor}1a, transparent 60%)`,
        }}
      >
        <div
          className="pointer-events-none absolute inset-0 rounded-2xl"
          style={{ boxShadow: `inset 0 0 0 1px ${embedColor}33, 0 0 60px -10px ${embedColor}55` }}
        />

        <div className="relative p-6 border-b border-border flex items-start justify-between gap-4">
          <div>
            <div className="text-[10px] tracking-[0.2em] text-muted uppercase">Slot {slot} • Killfeed</div>
            <h2 id="killfeed-modal-title" className="text-xl font-semibold text-white mt-1">
              {existing ? 'Killfeed bearbeiten' : 'Neuer Killfeed'}
            </h2>
            <p className="text-xs text-muted mt-1">Live-Sync alle 60s. Channel-Bindung exakt 1:1.</p>
          </div>
          <div
            className="h-12 w-12 rounded-xl border grid place-items-center text-lg shrink-0"
            style={{ backgroundColor: `${embedColor}22`, borderColor: `${embedColor}66`, color: embedColor }}
          >
            <Crosshair className="h-6 w-6" />
          </div>
        </div>

        <div className="relative p-6 space-y-5">
          {/* Channel */}
          <label className="block">
            <span className="text-xs text-muted">Discord-Channel <span className="text-[10px]">(Embed wird hier gepostet)</span></span>
            <Select value={channelId} onChange={e => setChannelId(e.target.value)}>
              <option value="">— wählen —</option>
              {textChannels.map(c => <option key={c.id} value={c.id}>#{c.name}</option>)}
            </Select>
          </label>

          {/* Kategorien */}
          <div>
            <span className="text-xs text-muted">Kategorien <span className="text-[10px]">(min. 1)</span></span>
            <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
              {(Object.keys(CATEGORY_LABELS) as Category[]).map(c => {
                const meta = CATEGORY_LABELS[c];
                const active = categories.includes(c);
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => toggleCategory(c)}
                    className={`text-left px-3 py-2 rounded-lg border transition ${
                      active
                        ? 'border-primary bg-primary/15 text-primary'
                        : 'border-border bg-bg-elev text-fg hover:border-primary/50'
                    }`}
                  >
                    <div className="flex items-center gap-2 font-medium text-sm">
                      <span>{meta.icon}</span>{meta.label}
                    </div>
                    <div className="text-[10px] text-muted mt-0.5">{meta.desc}</div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Toggles */}
          <div>
            <span className="text-xs text-muted">Embed-Inhalt</span>
            <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
              {[
                ['Schützen-Koordinaten', showShooterCoords, setShowShooterCoords],
                ['Opfer-Koordinaten', showVictimCoords, setShowVictimCoords],
                ['Waffe', showWeapon, setShowWeapon],
                ['Distanz', showDistance, setShowDistance],
              ].map(([label, value, setter], i) => (
                <label key={i} className="flex items-center gap-2 px-3 py-2 rounded-md bg-bg-elev border border-border cursor-pointer hover:border-primary/50">
                  <input
                    type="checkbox"
                    checked={value as boolean}
                    onChange={e => (setter as (v: boolean) => void)(e.target.checked)}
                    className="accent-primary"
                  />
                  <span>{label as string}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Aktiv-Schalter */}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={isActive} onChange={e => setIsActive(e.target.checked)} className="accent-primary" />
            <span className="text-white font-medium">Killfeed aktiv</span>
            <span className="text-[10px] text-muted">(Watcher pollt nur aktive Configs)</span>
          </label>

          {/* Farbe */}
          <div>
            <span className="text-xs text-muted">Embed-Farbe</span>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {KILLFEED_COLOR_PRESETS.map(p => {
                const active = p.hex.toLowerCase() === embedColor.toLowerCase();
                return (
                  <button
                    key={p.hex}
                    type="button"
                    onClick={() => setEmbedColor(p.hex)}
                    className={`group relative h-9 w-9 rounded-lg border transition ${active ? 'scale-110' : 'hover:scale-105'}`}
                    style={{
                      backgroundColor: p.hex,
                      borderColor: active ? '#ffffff' : `${p.hex}88`,
                      boxShadow: active ? `0 0 0 2px ${p.hex}aa, 0 0 18px -2px ${p.hex}` : `0 0 10px -3px ${p.hex}aa`,
                    }}
                    title={p.name}
                  >
                    {active && <span className="absolute inset-0 grid place-items-center text-white text-xs font-bold drop-shadow">✓</span>}
                  </button>
                );
              })}
              <div className="ml-1 flex items-center gap-2">
                <input
                  type="color"
                  value={embedColor}
                  onChange={e => setEmbedColor(e.target.value)}
                  className="h-9 w-12 rounded-lg bg-bg-elev border border-border cursor-pointer"
                />
                <Input value={embedColor} onChange={e => setEmbedColor(e.target.value)} className="w-28 font-mono text-xs" maxLength={7} />
              </div>
            </div>
          </div>

          {err && (
            <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">{err}</div>
          )}
        </div>

        <div className="relative p-5 border-t border-border flex gap-2 justify-end bg-bg-card/60">
          <Button variant="ghost" onClick={onClose}>Abbrechen</Button>
          <Button onClick={save} disabled={busy || !valid} loading={busy}>
            {existing ? 'Speichern' : 'Erstellen'}
          </Button>
        </div>
      </div>
    </div>
  );
}
