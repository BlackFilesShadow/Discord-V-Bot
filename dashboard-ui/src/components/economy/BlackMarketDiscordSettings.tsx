import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Radio, RefreshCw, Save, ShoppingCart } from 'lucide-react';
import { api } from '@/lib/api';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Switch } from '@/components/ui/Switch';

interface DiscordChannel {
  id: string;
  name: string;
  type: number;
}

interface MarketProjection {
  catalogChannelId: string | null;
  directBuyEnabled: boolean;
  directBuyChannelId: string | null;
  orderChannelId: string | null;
  orderReadyChannelId: string | null;
  catalogMessageCount: number;
  directBuyMessageCount: number;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
}

export function BlackMarketDiscordSettings({
  guildId,
  slot,
  canManage,
  onMessage,
}: {
  guildId: string;
  slot: string;
  canManage: boolean;
  onMessage: (message: { ok: boolean; text: string }) => void;
}) {
  const qc = useQueryClient();
  const scope = `slot=${encodeURIComponent(slot)}`;
  const [catalogChannelId, setCatalogChannelId] = useState('');
  const [directBuyEnabled, setDirectBuyEnabled] = useState(false);
  const [directBuyChannelId, setDirectBuyChannelId] = useState('');
  const [orderChannelId, setOrderChannelId] = useState('');
  const [orderReadyChannelId, setOrderReadyChannelId] = useState('');
  const [touched, setTouched] = useState(false);

  const channels = useQuery({
    queryKey: ['guild-channels', guildId],
    queryFn: () => api.get<{ channels: DiscordChannel[] }>(`/api/v2/guilds/${guildId}/channels`),
    retry: false,
  });
  const projection = useQuery({
    queryKey: ['economy-black-market-discord', guildId, slot],
    queryFn: () => api.get<{ projection: MarketProjection | null }>(
      `/api/v2/guilds/${guildId}/economy/black-market/discord?${scope}`,
    ),
    retry: false,
  });

  useEffect(() => {
    if (touched || !projection.data) return;
    const row = projection.data.projection;
    setCatalogChannelId(row?.catalogChannelId ?? '');
    setDirectBuyEnabled(row?.directBuyEnabled ?? false);
    setDirectBuyChannelId(row?.directBuyChannelId ?? '');
    setOrderChannelId(row?.orderChannelId ?? '');
    setOrderReadyChannelId(row?.orderReadyChannelId ?? '');
  }, [projection.data, touched]);

  const textChannels = useMemo(
    () => (channels.data?.channels ?? []).filter(channel => channel.type === 0),
    [channels.data?.channels],
  );

  const save = useMutation({
    mutationFn: () => api.put<{ projection: MarketProjection }>(
      `/api/v2/guilds/${guildId}/economy/black-market/discord?${scope}`,
      {
        catalogChannelId: catalogChannelId || null,
        directBuyEnabled,
        directBuyChannelId: directBuyEnabled ? (directBuyChannelId || null) : null,
        orderChannelId: directBuyEnabled ? (orderChannelId || null) : null,
        orderReadyChannelId: directBuyEnabled ? (orderReadyChannelId || null) : null,
      },
    ),
    onSuccess: result => {
      setTouched(false);
      onMessage({ ok: true, text: 'Discord-Verkaufsliste, Bestellbutton und Direktkauf wurden gespeichert und sofort synchronisiert.' });
      qc.setQueryData(['economy-black-market-discord', guildId, slot], { projection: result.projection });
    },
    onError: (error: Error) => onMessage({ ok: false, text: `Discord-Integration fehlgeschlagen: ${error.message}` }),
  });

  const sync = useMutation({
    mutationFn: () => api.post<{ projection: MarketProjection | null }>(
      `/api/v2/guilds/${guildId}/economy/black-market/discord/sync?${scope}`,
      {},
    ),
    onSuccess: result => {
      onMessage({ ok: true, text: 'Discord-Verkaufsliste und Bestellbutton wurden sofort neu synchronisiert.' });
      qc.setQueryData(['economy-black-market-discord', guildId, slot], { projection: result.projection });
    },
    onError: (error: Error) => onMessage({ ok: false, text: `Live-Sync fehlgeschlagen: ${error.message}` }),
  });

  const current = projection.data?.projection ?? null;
  const invalid = directBuyEnabled && (!directBuyChannelId || !orderChannelId || !orderReadyChannelId);

  return (
    <div className="mb-5 rounded-lg border border-border/60 bg-bg/40 p-3 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-white inline-flex items-center gap-1.5"><Radio className="h-3.5 w-3.5" />Discord Live-Sync</p>
        <div className="flex items-center gap-2">
          {current?.lastSyncError
            ? <Badge variant="warn">SYNC-FEHLER</Badge>
            : current?.lastSyncedAt ? <Badge variant="ok">LIVE</Badge> : <Badge variant="neutral">NICHT AKTIV</Badge>}
          {canManage && (
            <Button
              size="sm"
              variant="ghost"
              aria-label="Discord-Schwarzmarkt jetzt synchronisieren"
              disabled={sync.isPending || projection.isLoading}
              onClick={() => sync.mutate()}
            >
              <RefreshCw className={`h-3.5 w-3.5 mr-1 ${sync.isPending ? 'animate-spin' : ''}`} />Sync
            </Button>
          )}
        </div>
      </div>

      <p className="text-xs text-muted">
        Die Verkaufsliste wird als Discord-Embed ausgegeben und nach bestätigten Änderungen sofort aktualisiert. Bei aktiviertem Direktkauf erscheint der Sammelbestellungs-Button im selben Verkaufsliste-Kanal direkt zusammen mit der Liste. Zusätzlich erzeugt V-Bot pro aktivem Angebot ein eigenes Direktkauf-Embed im gewählten Direktkauf-Kanal; dadurch gibt es keine 25-Angebote-Grenze durch Discord-Auswahlmenüs.
      </p>

      {canManage && (
        <div className="grid gap-3 md:grid-cols-2">
          <label className="text-xs">
            <span className="text-muted block mb-1">Kanal für Verkaufsliste + Bestellbutton</span>
            <Select value={catalogChannelId} onChange={event => { setTouched(true); setCatalogChannelId(event.target.value); }} disabled={channels.isLoading || save.isPending}>
              <option value="">— Verkaufsliste aus —</option>
              {textChannels.map(channel => <option key={channel.id} value={channel.id}>#{channel.name}</option>)}
            </Select>
          </label>

          <div className="space-y-2">
            <Switch checked={directBuyEnabled} onChange={value => { setTouched(true); setDirectBuyEnabled(value); }} label="Direktkauf aktivieren" disabled={save.isPending} />
            <Select value={directBuyChannelId} onChange={event => { setTouched(true); setDirectBuyChannelId(event.target.value); }} disabled={!directBuyEnabled || channels.isLoading || save.isPending}>
              <option value="">— Direktkauf-Kanal wählen —</option>
              {textChannels.map(channel => <option key={channel.id} value={channel.id}>#{channel.name}</option>)}
            </Select>
          </div>

          <label className="text-xs">
            <span className="text-muted block mb-1">Bestellungs-Kanal (Sammelbestellung)</span>
            <Select value={orderChannelId} onChange={event => { setTouched(true); setOrderChannelId(event.target.value); }} disabled={!directBuyEnabled || channels.isLoading || save.isPending}>
              <option value="">{directBuyEnabled ? '— Bestellungs-Kanal wählen —' : '— nur bei aktivem Direktkauf —'}</option>
              {textChannels.map(channel => <option key={channel.id} value={channel.id}>#{channel.name}</option>)}
            </Select>
          </label>

          <label className="text-xs">
            <span className="text-muted block mb-1">Bestellung-bereit-Kanal (Kunden-Mention)</span>
            <Select value={orderReadyChannelId} onChange={event => { setTouched(true); setOrderReadyChannelId(event.target.value); }} disabled={!directBuyEnabled || channels.isLoading || save.isPending}>
              <option value="">{directBuyEnabled ? '— Bestellung-bereit-Kanal wählen —' : '— nur bei aktivem Direktkauf —'}</option>
              {textChannels.map(channel => <option key={channel.id} value={channel.id}>#{channel.name}</option>)}
            </Select>
          </label>

          <div className="md:col-span-2 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              aria-label="Discord-Schwarzmarkt speichern und synchronisieren"
              disabled={save.isPending || invalid || channels.isError}
              onClick={() => save.mutate()}
            >
              <Save className="h-3.5 w-3.5 mr-1" />{save.isPending ? 'Synchronisiere…' : 'Speichern & sofort synchronisieren'}
            </Button>
            {current && (
              <span className="text-[11px] text-muted inline-flex items-center gap-1">
                <ShoppingCart className="h-3 w-3" />{current.catalogMessageCount} Listen-Embed(s) · {current.directBuyMessageCount} Direktkauf-Embed(s)
              </span>
            )}
          </div>
        </div>
      )}

      {current?.lastSyncError && <p className="text-xs text-danger">Discord-Syncfehler: {current.lastSyncError}</p>}
      {channels.isError && <p className="text-xs text-danger">Discord-Kanäle konnten nicht geladen werden: {(channels.error as Error).message}</p>}
      {projection.isError && <p className="text-xs text-danger">Discord-Konfiguration konnte nicht geladen werden: {(projection.error as Error).message}</p>}
    </div>
  );
}
