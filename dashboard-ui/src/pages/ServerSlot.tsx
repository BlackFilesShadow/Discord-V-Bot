import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Shell } from '@/components/Shell';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import { Settings, Users, Shield, Coins, Link as LinkIcon } from 'lucide-react';

type Tab = 'settings' | 'factions' | 'whitelist' | 'economy' | 'links';

interface ServerSettingsState {
  whitelistActive: boolean;
  economyActive: boolean;
  permaOnly: boolean;
}

interface EconomyConfigState {
  enabled: boolean;
  currencyName: string;
  emoji: string;
  startBalance: number;
  playtimeRewardPercent: number;
}

export default function ServerSlot() {
  const { guildId, slot } = useParams<{ guildId: string; slot: string }>();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('settings');

  const settings = useQuery({
    queryKey: ['settings', guildId, slot],
    queryFn: () => api.get<ServerSettingsState>(`/api/v2/guilds/${guildId}/dashboard/server/${slot}/settings`),
    enabled: !!guildId && !!slot,
  });

  const updateSettings = useMutation({
    mutationFn: (patch: Partial<ServerSettingsState>) =>
      api.patch(`/api/v2/guilds/${guildId}/dashboard/server/${slot}/settings`, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings', guildId, slot] }),
  });

  const economy = useQuery({
    queryKey: ['economy', guildId],
    queryFn: () => api.get<EconomyConfigState>(`/api/v2/guilds/${guildId}/economy/config`),
    enabled: !!guildId,
  });

  const updateEconomy = useMutation({
    mutationFn: (patch: Partial<EconomyConfigState>) =>
      api.patch(`/api/v2/guilds/${guildId}/economy/config`, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['economy', guildId] }),
  });

  const sidebar = (
    <nav className="space-y-1 text-sm">
      {([
        ['settings', 'Settings', Settings],
        ['factions', 'Fraktionssystem', Users],
        ['whitelist', 'Whitelist', Shield],
        ['economy', 'Economy', Coins],
        ['links', 'Economy-Links', LinkIcon],
      ] as const).map(([key, label, Icon]) => (
        <button
          key={key}
          onClick={() => setTab(key)}
          className={`w-full text-left px-3 py-2 rounded-md inline-flex items-center gap-2 transition-colors ${
            tab === key ? 'bg-accent/20 text-accent' : 'text-muted hover:bg-bg-elev hover:text-white'
          }`}
          type="button"
        >
          <Icon className="h-4 w-4" />
          {label}
        </button>
      ))}
    </nav>
  );

  return (
    <Shell title={`Slot #${slot}`} back={`/servers/${guildId}`} sidebar={sidebar}>
      <div className="max-w-3xl mx-auto space-y-6">
        {tab === 'settings' && (
          <Card>
            <CardHeader><CardTitle>Server-Toggles</CardTitle></CardHeader>
            {settings.isLoading && <p className="text-muted">Lade…</p>}
            {settings.data && (
              <div className="space-y-4">
                <Switch
                  checked={settings.data.whitelistActive}
                  onChange={v => updateSettings.mutate({ whitelistActive: v })}
                  label="Whitelist aktiv"
                />
                <Switch
                  checked={settings.data.economyActive}
                  onChange={v => updateSettings.mutate({ economyActive: v })}
                  label="Economy aktiv"
                />
                <Switch
                  checked={settings.data.permaOnly}
                  onChange={v => updateSettings.mutate({ permaOnly: v })}
                  label="Perma-Only Modus"
                />
              </div>
            )}
          </Card>
        )}

        {tab === 'factions' && (
          <Card>
            <CardHeader><CardTitle>Fraktionssystem</CardTitle></CardHeader>
            <p className="text-muted text-sm">
              Fraktion erstellen via <code className="text-accent">POST /api/v2/guilds/{guildId}/factions</code>.
            </p>
          </Card>
        )}

        {tab === 'whitelist' && (
          <Card>
            <CardHeader><CardTitle>Whitelist</CardTitle></CardHeader>
            <p className="text-muted text-sm">
              Channel-Setup, Anfragen-Channel, Live-Liste — Endpoints unter
              <code className="text-accent"> /api/v2/guilds/{guildId}/whitelist</code>.
            </p>
          </Card>
        )}

        {tab === 'economy' && (
          <Card>
            <CardHeader><CardTitle>Economy-Konfiguration</CardTitle></CardHeader>
            {economy.isLoading && <p className="text-muted">Lade…</p>}
            {economy.data && (
              <EconomyForm
                value={economy.data}
                onSave={patch => updateEconomy.mutate(patch)}
                pending={updateEconomy.isPending}
              />
            )}
          </Card>
        )}

        {tab === 'links' && (
          <Card>
            <CardHeader><CardTitle>Economy-Links (Discord ↔ In-Game)</CardTitle></CardHeader>
            <p className="text-muted text-sm">
              Tabelle aller Bindungen via <code className="text-accent">/api/v2/guilds/{guildId}/economy-links</code>.
            </p>
          </Card>
        )}
      </div>
    </Shell>
  );
}

function EconomyForm({
  value, onSave, pending,
}: { value: EconomyConfigState; onSave: (p: Partial<EconomyConfigState>) => void; pending: boolean }) {
  const [draft, setDraft] = useState(value);
  return (
    <div className="space-y-4">
      <Switch
        checked={draft.enabled}
        onChange={v => setDraft({ ...draft, enabled: v })}
        label="Economy aktiviert"
      />
      <div className="grid grid-cols-2 gap-3">
        <label className="text-sm">
          <span className="text-muted">Waehrungsname</span>
          <Input value={draft.currencyName} onChange={e => setDraft({ ...draft, currencyName: e.target.value })} maxLength={40} />
        </label>
        <label className="text-sm">
          <span className="text-muted">Emoji</span>
          <Input value={draft.emoji} onChange={e => setDraft({ ...draft, emoji: e.target.value })} maxLength={8} />
        </label>
        <label className="text-sm">
          <span className="text-muted">Startguthaben (neue Members)</span>
          <Input
            type="number" min={0} value={draft.startBalance}
            onChange={e => setDraft({ ...draft, startBalance: Math.max(0, Number(e.target.value) || 0) })}
          />
        </label>
        <label className="text-sm">
          <span className="text-muted">Spielzeit-Belohnung %/min</span>
          <Input
            type="number" min={0} max={1000} value={draft.playtimeRewardPercent}
            onChange={e => setDraft({ ...draft, playtimeRewardPercent: Math.max(0, Math.min(1000, Number(e.target.value) || 0)) })}
          />
        </label>
      </div>
      <Button onClick={() => onSave(draft)} disabled={pending}>
        {pending ? 'Speichere…' : 'Update'}
      </Button>
    </div>
  );
}
