import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import LegacyServerSlot from './ServerSlot';
import { api, describeApiError } from '@/lib/api';
import { Shell } from '@/components/Shell';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import { Select } from '@/components/ui/Select';
import { EmojiPicker } from '@/components/ui/EmojiPicker';
import { EconomyScopePanel } from '@/components/economy/EconomyScopePanel';
import { FunctionHelpButton } from '@/components/ui/FunctionHelpButton';
import { useToast } from '@/lib/toast';
import {
  Banknote,
  Coins,
  Crosshair,
  Dice5,
  Link as LinkIcon,
  MapPinned,
  Settings,
  Shield,
} from 'lucide-react';

type CasinoGameType = 'SLOT' | 'COINFLIP' | 'DICE' | 'BLACKJACK' | 'ROULETTE' | 'HIGHLOW' | 'BACCARAT' | 'WHEEL';
type Tab = 'settings' | 'whitelist' | 'economy' | 'links' | 'virtual-accounts' | 'bank-casino' | 'killfeed' | 'radar';
type RewardTarget = 'WALLET' | 'BANK';

interface EconomyConfigState {
  enabled: boolean;
  currencyName: string;
  emoji: string;
  startBalance: number;
  playtimeRewardPer10Min: number;
  /** Rolling compatibility response for older clients. */
  playtimeRewardPercent?: number;
  bankInterestPercent: number;
  bankChannelId: string | null;
}

interface EconomyRewardState {
  economyActive: boolean;
  admRewardsEnabled: boolean;
  timezone: string;
  pvp: {
    enabled: boolean;
    baseAmount: string;
    rewardTarget: RewardTarget;
    dailyCap: string | null;
    cooldownSeconds: number;
  };
  playtime: {
    enabled: boolean;
    baseAmount: string;
    rewardTarget: RewardTarget;
  };
}

interface ChannelOption { id: string; name: string; type: number; parentId: string | null; }

interface CasinoGameRow {
  type: CasinoGameType;
  label: string;
  emoji: string;
  description: string;
  enabled: boolean;
  winChancePct: number;
  payoutMult: number;
  minBet: string;
  maxBet: string;
  cooldownSeconds: number;
  drawConditionalPct: number;
  theoreticalRtpPct: number;
  houseEdgePct: number;
}

interface CasinoStatRow {
  type: CasinoGameType;
  wins: number;
  draws: number;
  losses: number;
  bet: string;
  payout: string;
}

interface EconomyOverviewData {
  economy: { enabled: boolean; currencyName: string; emoji: string; accounts: number; links: number; transactions: number };
  bank: { totalWallet: string; totalBank: string; interestPercent: number; bankChannelId: string | null };
  casino: { gamesConfigured: number; gamesEnabled: number; rounds: number; totalBet: string; totalPayout: string; houseEdge: string };
}

const CASINO_TYPES: readonly CasinoGameType[] = [
  'SLOT', 'COINFLIP', 'DICE', 'BLACKJACK', 'ROULETTE', 'HIGHLOW', 'BACCARAT', 'WHEEL',
];
const FALLBACK_META: Record<CasinoGameType, { label: string; emoji: string; description: string; drawConditionalPct: number }> = {
  SLOT: { label: 'Slot', emoji: '🎰', description: 'Drei Walzen mit konfigurierbarer Gewinnchance.', drawConditionalPct: 0 },
  COINFLIP: { label: 'Coinflip', emoji: '🪙', description: 'Kopf oder Zahl mit konfigurierter Server-Chance.', drawConditionalPct: 0 },
  DICE: { label: 'Dice', emoji: '🎲', description: 'Zahl von 1 bis 6 tippen.', drawConditionalPct: 0 },
  BLACKJACK: { label: 'Blackjack', emoji: '🃏', description: 'Automatische Kartenrunde.', drawConditionalPct: 10 },
  ROULETTE: { label: 'Roulette', emoji: '🎡', description: 'Rot oder Schwarz.', drawConditionalPct: 0 },
  HIGHLOW: { label: 'High-Low', emoji: '🔼', description: 'Höher oder tiefer tippen.', drawConditionalPct: 0 },
  BACCARAT: { label: 'Baccarat', emoji: '🎴', description: 'Auf Spieler oder Banker setzen.', drawConditionalPct: 8 },
  WHEEL: { label: 'Glücksrad', emoji: '🎯', description: 'Schnelle Glücksrad-Runde.', drawConditionalPct: 0 },
};
const MAX_BET = 1_000_000_000_000_000n;
const MAX_REWARD = 1_000_000_000_000_000n;
const SNOWFLAKE_RE = /^\d{17,20}$/;

const NAV: ReadonlyArray<[Tab, string, typeof Settings]> = [
  ['settings', 'Settings', Settings],
  ['whitelist', 'Whitelist', Shield],
  ['economy', 'Economy', Coins],
  ['links', 'Economy-Links', LinkIcon],
  ['virtual-accounts', 'Virtuelle Konten', Banknote],
  ['bank-casino', 'Bank und Casino Funktionen', Dice5],
  ['killfeed', 'Killfeed & ADM', Crosshair],
  ['radar', 'Zonenradar', MapPinned],
];

function fmtBig(value: string): string {
  try { return BigInt(value).toLocaleString('de-DE'); } catch { return value; }
}

function validUnsignedBigint(value: string, max: bigint, allowEmpty = false): boolean {
  if (allowEmpty && value === '') return true;
  if (!/^\d+$/.test(value)) return false;
  try {
    const parsed = BigInt(value);
    return parsed >= 0n && parsed <= max;
  } catch {
    return false;
  }
}

function SlotV3Shell({ tab, children }: { tab: Tab; children: React.ReactNode }) {
  const { guildId, slot } = useParams<{ guildId: string; slot: string }>();
  const navigate = useNavigate();
  const changeTab = (next: Tab) => navigate(`/servers/${guildId}/server/${slot}?tab=${next}`);
  const sidebar = (
    <nav className="space-y-1 text-sm" aria-label="Slot-Funktionen">
      {NAV.map(([key, label, Icon], index) => (
        <div key={key} className={index === 4 ? 'pt-4 mt-3 border-t border-border/60' : ''}>
          <button
            type="button"
            onClick={() => changeTab(key)}
            className={`w-full text-left px-3 py-2 rounded-md inline-flex items-center gap-2 transition-colors ${
              tab === key ? 'bg-accent/20 text-accent border border-accent/25' : 'text-muted hover:bg-bg-elev hover:text-white border border-transparent'
            }`}
          >
            <Icon className="h-4 w-4" />{label}
          </button>
        </div>
      ))}
    </nav>
  );
  return (
    <Shell title={`Slot #${slot}`} back={`/servers/${guildId}`} sidebar={sidebar}>
      <div className="mx-auto max-w-5xl space-y-6">
        <nav className="md:hidden -mx-4 px-4 flex gap-2 overflow-x-auto pb-1" aria-label="Slot-Funktionen mobil">
          {NAV.map(([key, label, Icon]) => (
            <button
              key={key}
              type="button"
              onClick={() => changeTab(key)}
              className={`shrink-0 inline-flex items-center gap-2 px-3 py-2 rounded-md text-sm whitespace-nowrap transition-colors ${
                tab === key ? 'bg-accent/20 text-accent' : 'text-muted bg-bg-elev/40 hover:bg-bg-elev hover:text-white'
              }`}
            >
              <Icon className="h-4 w-4" />{label}
            </button>
          ))}
        </nav>
        {children}
      </div>
    </Shell>
  );
}

function EconomyV3Page({ guildId, slot }: { guildId: string; slot: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const config = useQuery({
    queryKey: ['economy', guildId, slot],
    queryFn: () => api.get<EconomyConfigState>(`/api/v2/guilds/${guildId}/economy/config?slot=${encodeURIComponent(slot)}`),
    retry: false,
  });
  const overview = useQuery({
    queryKey: ['economy-overview', guildId, slot],
    queryFn: () => api.get<EconomyOverviewData>(`/api/v2/guilds/${guildId}/economy/overview?slot=${encodeURIComponent(slot)}`),
    retry: false,
  });
  const rewards = useQuery({
    queryKey: ['economy-rewards', guildId, slot],
    queryFn: () => api.get<EconomyRewardState>(`/api/v2/guilds/${guildId}/economy/rewards?slot=${encodeURIComponent(slot)}`),
    retry: false,
  });
  const update = useMutation({
    mutationFn: (patch: Partial<EconomyConfigState>) => api.put<EconomyConfigState>(
      `/api/v2/guilds/${guildId}/economy/config?slot=${encodeURIComponent(slot)}`,
      patch,
    ),
    onSuccess: saved => {
      qc.setQueryData(['economy', guildId, slot], saved);
      void qc.invalidateQueries({ queryKey: ['economy-overview', guildId, slot] });
      void qc.invalidateQueries({ queryKey: ['economy-rewards', guildId, slot] });
      toast.push({ variant: 'success', title: 'Gespeichert', desc: 'Economy-Konfiguration aktualisiert.' });
    },
    onError: err => {
      const d = describeApiError(err);
      toast.push({ variant: 'danger', title: d.title, desc: d.desc });
    },
  });
  const updateRewards = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.put<EconomyRewardState>(
      `/api/v2/guilds/${guildId}/economy/rewards?slot=${encodeURIComponent(slot)}`,
      patch,
    ),
    onSuccess: saved => {
      qc.setQueryData(['economy-rewards', guildId, slot], saved);
      toast.push({ variant: 'success', title: 'Rewards gespeichert', desc: 'Automatische DayZ-Rewards wurden aktualisiert.' });
    },
    onError: err => {
      const d = describeApiError(err);
      toast.push({ variant: 'danger', title: d.title, desc: d.desc });
    },
  });

  return (
    <>
      <div className="flex items-center gap-2 border-b border-border/60 pb-3">
        <h2 className="text-base font-semibold text-white">Economy</h2>
        <FunctionHelpButton title="Economy" text={[
          'Hier konfigurierst du die servergescoppte Währung und automatische DayZ-Rewards.',
          'Spielzeit wird in vollständigen 10-Minuten-Buckets gebucht; historische Zeit wird nicht nachbezahlt.',
          'Der ADM-Rewards-Master bleibt ein eigenes Sicherheits-Gate und muss für automatische Auszahlungen aktiv sein.',
        ]} />
      </div>
      <EconomyScopePanel guildId={guildId} slot={slot} />
      {overview.data && (
        <Card>
          <CardHeader><CardTitle>Wirtschaft-Status</CardTitle></CardHeader>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 text-sm">
            <Metric label="Konten" value={String(overview.data.economy.accounts)} />
            <Metric label="Verknüpfungen" value={String(overview.data.economy.links)} />
            <Metric label="Wallet gesamt" value={fmtBig(overview.data.bank.totalWallet)} />
            <Metric label="Bank gesamt" value={fmtBig(overview.data.bank.totalBank)} />
          </div>
        </Card>
      )}
      {config.isLoading && <Card><p className="text-muted">Lade Economy-Konfiguration…</p></Card>}
      {config.isError && <Card><p className="text-danger">Economy-Konfiguration konnte nicht geladen werden.</p></Card>}
      {config.data && <EconomyConfigCard value={config.data} onSave={patch => update.mutate(patch)} pending={update.isPending} />}
      {rewards.isLoading && <Card><p className="text-muted">Lade DayZ-Rewards…</p></Card>}
      {rewards.isError && <Card><p className="text-danger">DayZ-Rewards konnten nicht geladen werden.</p></Card>}
      {rewards.data && (
        <AdmRewardsCard
          value={rewards.data}
          pending={updateRewards.isPending}
          onSave={patch => updateRewards.mutate(patch)}
        />
      )}
    </>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border/60 bg-bg-elev/40 p-3 min-w-0">
      <p className="text-[11px] text-muted">{label}</p>
      <p className="font-semibold text-white break-words">{value}</p>
    </div>
  );
}

function EconomyConfigCard({ value, onSave, pending }: {
  value: EconomyConfigState;
  onSave: (patch: Partial<EconomyConfigState>) => void;
  pending: boolean;
}) {
  const [draft, setDraft] = useState({
    enabled: value.enabled,
    currencyName: value.currencyName,
    emoji: value.emoji,
    startBalance: value.startBalance,
    playtimeRewardPer10Min: value.playtimeRewardPer10Min ?? value.playtimeRewardPercent ?? 0,
  });
  useEffect(() => {
    setDraft({
      enabled: value.enabled,
      currencyName: value.currencyName,
      emoji: value.emoji,
      startBalance: value.startBalance,
      playtimeRewardPer10Min: value.playtimeRewardPer10Min ?? value.playtimeRewardPercent ?? 0,
    });
  }, [value]);
  const valid = draft.currencyName.trim().length >= 1
    && draft.currencyName.length <= 40
    && draft.emoji.length >= 1
    && draft.emoji.length <= 40
    && Number.isInteger(draft.startBalance)
    && draft.startBalance >= 0
    && Number.isInteger(draft.playtimeRewardPer10Min)
    && draft.playtimeRewardPer10Min >= 0
    && draft.playtimeRewardPer10Min <= 1_000_000_000;

  return (
    <Card>
      <CardHeader><CardTitle>Economy-Konfiguration</CardTitle></CardHeader>
      <div className="space-y-4">
        <Switch checked={draft.enabled} onChange={enabled => setDraft(s => ({ ...s, enabled }))} label="Economy aktiviert" />
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm"><span className="text-muted">Währungsname</span><Input value={draft.currencyName} maxLength={40} onChange={e => setDraft(s => ({ ...s, currencyName: e.target.value }))} /></label>
          <label className="text-sm"><span className="text-muted">Emoji</span><EmojiPicker value={draft.emoji} onChange={emoji => setDraft(s => ({ ...s, emoji }))} /></label>
          <label className="text-sm"><span className="text-muted">Startguthaben</span><Input type="number" min={0} max={1_000_000_000} value={draft.startBalance} onChange={e => setDraft(s => ({ ...s, startBalance: Math.max(0, Math.min(1_000_000_000, Math.trunc(Number(e.target.value) || 0))) }))} /></label>
          <label className="text-sm">
            <span className="text-muted">Spielzeit-Belohnung je 10 Minuten</span>
            <Input type="number" min={0} max={1_000_000_000} value={draft.playtimeRewardPer10Min} onChange={e => setDraft(s => ({ ...s, playtimeRewardPer10Min: Math.max(0, Math.min(1_000_000_000, Math.trunc(Number(e.target.value) || 0))) }))} />
            <span className="mt-1 block text-[11px] text-muted">0 deaktiviert die Spielzeit-Auszahlung. Historische Zeit wird nicht nachbezahlt.</span>
          </label>
        </div>
        <Button disabled={pending || !valid} onClick={() => onSave(draft)}>{pending ? 'Speichere…' : 'Economy speichern'}</Button>
      </div>
    </Card>
  );
}

function AdmRewardsCard({ value, pending, onSave }: {
  value: EconomyRewardState;
  pending: boolean;
  onSave: (patch: Record<string, unknown>) => void;
}) {
  const [master, setMaster] = useState(value.admRewardsEnabled);
  const [pvpEnabled, setPvpEnabled] = useState(value.pvp.enabled);
  const [pvpAmount, setPvpAmount] = useState(value.pvp.baseAmount);
  const [pvpTarget, setPvpTarget] = useState<RewardTarget>(value.pvp.rewardTarget);
  const [dailyCap, setDailyCap] = useState(value.pvp.dailyCap ?? '');
  const [cooldown, setCooldown] = useState(value.pvp.cooldownSeconds);
  const [playtimeTarget, setPlaytimeTarget] = useState<RewardTarget>(value.playtime.rewardTarget);

  useEffect(() => {
    setMaster(value.admRewardsEnabled);
    setPvpEnabled(value.pvp.enabled);
    setPvpAmount(value.pvp.baseAmount);
    setPvpTarget(value.pvp.rewardTarget);
    setDailyCap(value.pvp.dailyCap ?? '');
    setCooldown(value.pvp.cooldownSeconds);
    setPlaytimeTarget(value.playtime.rewardTarget);
  }, [value]);

  const pvpAmountValid = validUnsignedBigint(pvpAmount, MAX_REWARD) && (!pvpEnabled || BigInt(pvpAmount || '0') > 0n);
  const capValid = validUnsignedBigint(dailyCap, MAX_REWARD, true);
  const valid = pvpAmountValid && capValid && Number.isInteger(cooldown) && cooldown >= 0 && cooldown <= 86_400;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle>Automatische DayZ-Rewards</CardTitle>
            <p className="mt-1 text-xs text-muted">ADM-Ereignisse werden nur bezahlt, wenn Economy und dieser Master-Schalter aktiv sind.</p>
          </div>
          <Badge variant={value.economyActive && master ? 'ok' : 'neutral'}>{value.economyActive && master ? 'Auszahlungen aktiv' : 'Auszahlungen gesperrt'}</Badge>
        </div>
      </CardHeader>

      <div className="space-y-5">
        <Switch checked={master} onChange={setMaster} label="ADM-Rewards aktiviert" />

        <div className="rounded-lg border border-border/60 bg-bg-elev/30 p-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div><p className="font-medium text-white">PvP-Kill-Reward</p><p className="text-[11px] text-muted">Tageslimit und Cooldown verhindern einfaches Kill-Farming.</p></div>
            <Switch checked={pvpEnabled} onChange={setPvpEnabled} ariaLabel="PvP-Rewards aktiv" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm"><span className="text-muted">Betrag pro Kill</span><Input aria-label="PvP Reward Betrag" inputMode="numeric" value={pvpAmount} onChange={e => setPvpAmount(e.target.value.trim())} /></label>
            <label className="text-sm"><span className="text-muted">Zielkonto</span><Select aria-label="PvP Reward Zielkonto" value={pvpTarget} onChange={e => setPvpTarget(e.target.value as RewardTarget)}><option value="WALLET">Wallet</option><option value="BANK">Bank</option></Select></label>
            <label className="text-sm"><span className="text-muted">Tageslimit (leer = unbegrenzt)</span><Input aria-label="PvP Tageslimit" inputMode="numeric" value={dailyCap} onChange={e => setDailyCap(e.target.value.trim())} placeholder="unbegrenzt" /></label>
            <label className="text-sm"><span className="text-muted">Reward-Cooldown (Sek.)</span><Input aria-label="PvP Reward Cooldown" type="number" min={0} max={86_400} value={cooldown} onChange={e => setCooldown(Math.max(0, Math.min(86_400, Math.trunc(Number(e.target.value) || 0))))} /></label>
          </div>
        </div>

        <div className="rounded-lg border border-border/60 bg-bg-elev/30 p-4 space-y-3">
          <div>
            <p className="font-medium text-white">Spielzeit-Reward</p>
            <p className="text-[11px] text-muted">Aktuell {fmtBig(value.playtime.baseAmount)} pro vollständige 10 Minuten · Betrag wird oben in der Economy-Konfiguration gepflegt.</p>
          </div>
          <label className="text-sm block max-w-sm"><span className="text-muted">Zielkonto</span><Select aria-label="Spielzeit Reward Zielkonto" value={playtimeTarget} onChange={e => setPlaytimeTarget(e.target.value as RewardTarget)}><option value="WALLET">Wallet</option><option value="BANK">Bank</option></Select></label>
        </div>

        <p className="text-[11px] text-muted">Tagesgrenzen werden in <code>{value.timezone}</code> ausgewertet. Deaktivierte Zeit-Buckets werden als verarbeitet markiert und später nicht rückwirkend ausgezahlt.</p>
        {!value.economyActive && <p className="text-xs text-warning">Economy ist aktuell deaktiviert. Die Regeln können vorbereitet werden, erzeugen aber kein Geld.</p>}
        <Button
          disabled={pending || !valid}
          onClick={() => onSave({
            admRewardsEnabled: master,
            pvp: {
              enabled: pvpEnabled,
              baseAmount: pvpAmount,
              rewardTarget: pvpTarget,
              dailyCap: dailyCap === '' ? null : dailyCap,
              cooldownSeconds: cooldown,
            },
            playtime: { rewardTarget: playtimeTarget },
          })}
        >
          {pending ? 'Speichere…' : 'DayZ-Rewards speichern'}
        </Button>
      </div>
    </Card>
  );
}

function BankCasinoV3Page({ guildId, slot }: { guildId: string; slot: string }) {
  const config = useQuery({
    queryKey: ['economy', guildId, slot],
    queryFn: () => api.get<EconomyConfigState>(`/api/v2/guilds/${guildId}/economy/config?slot=${encodeURIComponent(slot)}`),
    retry: false,
  });
  const channels = useQuery({
    queryKey: ['guild-channels', guildId],
    queryFn: () => api.get<{ channels: ChannelOption[] }>(`/api/v2/guilds/${guildId}/channels`),
    retry: false,
  });
  const qc = useQueryClient();
  const toast = useToast();
  const updateEconomy = useMutation({
    mutationFn: (patch: Partial<EconomyConfigState>) => api.put<EconomyConfigState>(
      `/api/v2/guilds/${guildId}/economy/config?slot=${encodeURIComponent(slot)}`,
      patch,
    ),
    onSuccess: saved => {
      qc.setQueryData(['economy', guildId, slot], saved);
      toast.push({ variant: 'success', title: 'Gespeichert', desc: 'Bank-Konfiguration aktualisiert.' });
    },
    onError: err => {
      const d = describeApiError(err);
      toast.push({ variant: 'danger', title: d.title, desc: d.desc });
    },
  });

  return (
    <>
      <div className="flex items-center gap-2 border-b border-border/60 pb-3">
        <h2 className="text-base font-semibold text-white">Bank und Casino</h2>
        <FunctionHelpButton title="Bank und Casino" text={[
          'Jedes Casino-Spiel hat eine eigene servergescoppte Konfiguration und einen eigenen Discord-Command.',
          'Gewinnchance, Auszahlung, Einsatzgrenzen und Cooldown werden vor jeder Runde aus genau dieser Karte gelesen.',
          'RTP über 100 % wird serverseitig blockiert; Draw-Anteile von Blackjack/Baccarat sind im RTP enthalten.',
        ]} />
      </div>
      {config.data && (
        <BankCard
          value={config.data}
          channels={channels.data?.channels ?? []}
          channelsForbidden={channels.isError}
          pending={updateEconomy.isPending}
          onSave={patch => updateEconomy.mutate(patch)}
        />
      )}
      <CasinoCards guildId={guildId} slot={slot} economyEnabled={config.data?.enabled === true} />
    </>
  );
}

function BankCard({ value, channels, channelsForbidden, pending, onSave }: {
  value: EconomyConfigState;
  channels: ChannelOption[];
  channelsForbidden: boolean;
  pending: boolean;
  onSave: (patch: Partial<EconomyConfigState>) => void;
}) {
  const [bankChannelId, setBankChannelId] = useState(value.bankChannelId ?? '');
  const [interest, setInterest] = useState(value.bankInterestPercent);
  useEffect(() => {
    setBankChannelId(value.bankChannelId ?? '');
    setInterest(value.bankInterestPercent);
  }, [value.bankChannelId, value.bankInterestPercent]);
  const textChannels = channels.filter(c => c.type === 0 || c.type === 5);
  return (
    <Card>
      <CardHeader><CardTitle><span className="inline-flex items-center gap-2"><Banknote className="h-4 w-4" />Bank</span></CardTitle></CardHeader>
      <p className="mb-4 text-xs text-muted">Der Bank-Channel zeigt Kontostände und Bankaktionen. Tageszinsen werden servergescoppt gebucht.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="text-muted">Bank-Channel</span>
          {channelsForbidden ? (
            <Input value={bankChannelId} onChange={e => setBankChannelId(e.target.value.trim())} placeholder="Channel-ID" />
          ) : (
            <Select value={bankChannelId} onChange={e => setBankChannelId(e.target.value)}>
              <option value="">— kein Channel —</option>
              {textChannels.map(c => <option key={c.id} value={c.id}>#{c.name}</option>)}
            </Select>
          )}
        </label>
        <label className="text-sm"><span className="text-muted">Tageszins (%)</span><Input type="number" min={0} max={100} step="0.01" value={interest} onChange={e => setInterest(Math.max(0, Math.min(100, Number(e.target.value) || 0)))} /></label>
      </div>
      <Button className="mt-4" disabled={pending || (bankChannelId !== '' && !SNOWFLAKE_RE.test(bankChannelId))} onClick={() => onSave({ bankChannelId: bankChannelId || null, bankInterestPercent: interest })}>
        {pending ? 'Speichere…' : 'Bank speichern'}
      </Button>
    </Card>
  );
}

function CasinoCards({ guildId, slot, economyEnabled }: { guildId: string; slot: string; economyEnabled: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const games = useQuery({
    queryKey: ['casino-games', guildId, slot],
    queryFn: () => api.get<{ games: CasinoGameRow[] }>(`/api/v2/guilds/${guildId}/casino/games?slot=${encodeURIComponent(slot)}`),
  });
  const stats = useQuery({
    queryKey: ['casino-stats', guildId, slot],
    queryFn: () => api.get<{ stats: CasinoStatRow[] }>(`/api/v2/guilds/${guildId}/casino/stats?slot=${encodeURIComponent(slot)}`),
  });
  const update = useMutation({
    mutationFn: ({ type, patch }: { type: CasinoGameType; patch: Partial<CasinoGameRow> }) => api.put<CasinoGameRow>(
      `/api/v2/guilds/${guildId}/casino/games/${type}?slot=${encodeURIComponent(slot)}`,
      patch,
    ),
    onSuccess: saved => {
      void qc.invalidateQueries({ queryKey: ['casino-games', guildId, slot] });
      toast.push({ variant: 'success', title: `${saved.emoji} ${saved.label} gespeichert`, desc: 'Casino-Regeln wurden aktualisiert.' });
    },
    onError: err => {
      const d = describeApiError(err);
      toast.push({ variant: 'danger', title: d.title, desc: d.desc });
    },
  });
  const byType = useMemo(() => new Map((games.data?.games ?? []).map(g => [g.type, g] as const)), [games.data]);
  const statsByType = useMemo(() => new Map((stats.data?.stats ?? []).map(s => [s.type, s] as const)), [stats.data]);

  return (
    <section className="space-y-4" aria-labelledby="casino-games-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 id="casino-games-heading" className="text-lg font-semibold text-white">🎲 Casino-Games</h3>
          <p className="text-xs text-muted">Acht getrennte Spiele · zentraler Economy-Ledger · jede Runde mit Audit-ID.</p>
        </div>
        <Badge variant={economyEnabled ? 'ok' : 'neutral'}>{economyEnabled ? 'Economy aktiv' : 'Economy deaktiviert'}</Badge>
      </div>
      {games.isLoading && <Card><p className="text-muted">Lade Casino-Konfiguration…</p></Card>}
      {games.isError && <Card><p className="text-danger">Casino-Konfiguration konnte nicht geladen werden.</p></Card>}
      {games.data && (
        <div className="grid gap-4 lg:grid-cols-2">
          {CASINO_TYPES.map(type => {
            const game = byType.get(type);
            const meta = FALLBACK_META[type];
            const fallback: CasinoGameRow = game ?? {
              type,
              label: meta.label,
              emoji: meta.emoji,
              description: meta.description,
              enabled: false,
              winChancePct: 40,
              payoutMult: 2,
              minBet: '1',
              maxBet: '10000',
              cooldownSeconds: 2,
              drawConditionalPct: meta.drawConditionalPct,
              theoreticalRtpPct: 80,
              houseEdgePct: 20,
            };
            return (
              <CasinoGameCard
                key={`${type}:${JSON.stringify(fallback)}`}
                game={fallback}
                stat={statsByType.get(type) ?? null}
                pending={update.isPending && update.variables?.type === type}
                onSave={patch => update.mutate({ type, patch })}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}

function CasinoGameCard({ game, stat, pending, onSave }: {
  game: CasinoGameRow;
  stat: CasinoStatRow | null;
  pending: boolean;
  onSave: (patch: Partial<CasinoGameRow>) => void;
}) {
  const [draft, setDraft] = useState({
    enabled: game.enabled,
    winChancePct: game.winChancePct,
    payoutMult: game.payoutMult,
    minBet: game.minBet,
    maxBet: game.maxBet,
    cooldownSeconds: game.cooldownSeconds,
  });
  useEffect(() => {
    setDraft({
      enabled: game.enabled,
      winChancePct: game.winChancePct,
      payoutMult: game.payoutMult,
      minBet: game.minBet,
      maxBet: game.maxBet,
      cooldownSeconds: game.cooldownSeconds,
    });
  }, [game]);

  let minBet: bigint | null = null;
  let maxBet: bigint | null = null;
  try {
    minBet = /^\d+$/.test(draft.minBet) ? BigInt(draft.minBet) : null;
    maxBet = /^\d+$/.test(draft.maxBet) ? BigInt(draft.maxBet) : null;
  } catch {
    minBet = null;
    maxBet = null;
  }
  const normalizedPayout = Math.round(draft.payoutMult * 1000) / 1000;
  const winProbability = draft.winChancePct / 100;
  const drawProbability = (1 - winProbability) * (game.drawConditionalPct / 100);
  const rtp = (winProbability * normalizedPayout + drawProbability) * 100;
  const valid = Number.isInteger(draft.winChancePct)
    && draft.winChancePct >= 1
    && draft.winChancePct <= 99
    && Number.isFinite(normalizedPayout)
    && normalizedPayout >= 1
    && normalizedPayout <= 100
    && minBet !== null
    && maxBet !== null
    && minBet >= 1n
    && maxBet >= minBet
    && maxBet <= MAX_BET
    && Number.isInteger(draft.cooldownSeconds)
    && draft.cooldownSeconds >= 0
    && draft.cooldownSeconds <= 3600
    && rtp <= 100 + 1e-9;

  const decided = (stat?.wins ?? 0) + (stat?.losses ?? 0);
  const winRate = decided > 0 ? ((stat?.wins ?? 0) / decided) * 100 : 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle><span className="inline-flex items-center gap-2"><span className="text-xl">{game.emoji}</span>{game.label}</span></CardTitle>
            <p className="mt-1 text-xs text-muted break-words">/{game.type === 'HIGHLOW' ? 'highlow' : game.type.toLowerCase()} · {game.description}</p>
          </div>
          <Switch checked={draft.enabled} onChange={enabled => setDraft(s => ({ ...s, enabled }))} ariaLabel={`Casino ${game.type} aktiv`} />
        </div>
      </CardHeader>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm"><span className="text-muted">Gewinnchance (%)</span><Input aria-label={`${game.type} Gewinnchance`} type="number" min={1} max={99} step={1} value={draft.winChancePct} onChange={e => setDraft(s => ({ ...s, winChancePct: Math.max(1, Math.min(99, Math.trunc(Number(e.target.value) || 1))) }))} /></label>
        <label className="text-sm"><span className="text-muted">Auszahlung x</span><Input aria-label={`${game.type} Auszahlung`} type="number" min={1} max={100} step="0.001" value={draft.payoutMult} onChange={e => setDraft(s => ({ ...s, payoutMult: Math.max(1, Math.min(100, Number(e.target.value) || 1)) }))} /></label>
        <label className="text-sm"><span className="text-muted">Mindest-Einsatz</span><Input aria-label={`${game.type} Mindest-Einsatz`} inputMode="numeric" value={draft.minBet} onChange={e => setDraft(s => ({ ...s, minBet: e.target.value.trim() }))} /></label>
        <label className="text-sm"><span className="text-muted">Maximal-Einsatz</span><Input aria-label={`${game.type} Maximal-Einsatz`} inputMode="numeric" value={draft.maxBet} onChange={e => setDraft(s => ({ ...s, maxBet: e.target.value.trim() }))} /></label>
        <label className="text-sm sm:col-span-2"><span className="text-muted">Cooldown (Sekunden)</span><Input aria-label={`${game.type} Cooldown`} type="number" min={0} max={3600} step={1} value={draft.cooldownSeconds} onChange={e => setDraft(s => ({ ...s, cooldownSeconds: Math.max(0, Math.min(3600, Math.trunc(Number(e.target.value) || 0))) }))} /></label>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <Metric label="RTP" value={`${rtp.toFixed(2)}%`} />
        <Metric label="Hausvorteil" value={`${(100 - rtp).toFixed(2)}%`} />
        <Metric label="W / D / L" value={stat ? `${stat.wins} / ${stat.draws} / ${stat.losses}` : '— / — / —'} />
        <Metric label="Win-Rate*" value={`${winRate.toFixed(2)}%`} />
      </div>
      <p className="mt-2 text-[10px] text-muted">* Win-Rate nur aus entschiedenen Runden; Draws werden nicht als Niederlage gezählt.{game.drawConditionalPct > 0 ? ` Draw-Anteil nach einem Nicht-Gewinn: ${game.drawConditionalPct}%.` : ''}</p>
      {rtp > 100 && <p className="mt-2 text-xs text-danger">Diese Kombination würde RTP über 100 % erzeugen und kann nicht gespeichert werden.</p>}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-4">
        <span className="text-[11px] text-muted">Server-Chance und Regeln werden im Runden-Audit gespeichert.</span>
        <Button
          size="sm"
          disabled={pending || !valid}
          onClick={() => onSave({
            enabled: draft.enabled,
            winChancePct: draft.winChancePct,
            payoutMult: normalizedPayout,
            minBet: draft.minBet,
            maxBet: draft.maxBet,
            cooldownSeconds: draft.cooldownSeconds,
          })}
        >
          {pending ? 'Speichere…' : 'Speichern'}
        </Button>
      </div>
    </Card>
  );
}

export default function ServerSlotV3() {
  const { guildId, slot } = useParams<{ guildId: string; slot: string }>();
  const [params] = useSearchParams();
  const tab = (params.get('tab') ?? 'settings') as Tab;

  if (!guildId || !slot) return <LegacyServerSlot />;
  if (tab === 'economy') return <SlotV3Shell tab="economy"><EconomyV3Page guildId={guildId} slot={slot} /></SlotV3Shell>;
  if (tab === 'bank-casino') return <SlotV3Shell tab="bank-casino"><BankCasinoV3Page guildId={guildId} slot={slot} /></SlotV3Shell>;
  return <LegacyServerSlot />;
}
