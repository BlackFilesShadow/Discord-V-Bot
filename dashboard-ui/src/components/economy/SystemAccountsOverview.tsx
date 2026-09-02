import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/Badge';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { api } from '@/lib/api';

interface SystemAccountCapabilities {
  managedBy: 'LOTTERY' | 'BLACK_MARKET' | 'SERVER_BANK' | 'VIRTUAL_ACCOUNTS';
  canConfigure: boolean;
  canDelete: boolean;
  canArchive: boolean;
  canPayout: boolean;
  canSyncProjection: boolean;
  canRestore: boolean;
  readOnlyReason: string | null;
}

interface SystemAccountRow {
  id: string;
  kind: 'LOTTERY_POT' | 'MARKET_VENDOR';
  name: string;
  hidden: boolean;
  walletBalance: string;
  bankBalance: string;
  totalBalance: string;
  status: 'ACTIVE' | 'EXPIRED' | 'ARCHIVED';
  currencyName: string;
  currencyEmoji: string;
  accountEmoji: string;
  capabilities: SystemAccountCapabilities;
}

function fmtBig(value: string): string {
  try { return BigInt(value).toLocaleString('de-DE'); } catch { return value; }
}

function ownerLabel(account: SystemAccountRow): string {
  if (account.capabilities.managedBy === 'LOTTERY') return 'Lotterie';
  if (account.capabilities.managedBy === 'BLACK_MARKET') return 'Schwarzmarkt';
  return 'Fachfunktion';
}

export function SystemAccountsOverview({ guildId, slot }: { guildId: string; slot: string }) {
  const query = useQuery({
    queryKey: ['economy-system-accounts', guildId, slot],
    queryFn: () => api.get<{ accounts: SystemAccountRow[] }>(
      `/api/v2/guilds/${guildId}/economy/virtual-accounts/control/system-accounts?slot=${encodeURIComponent(slot)}`,
    ),
    retry: false,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Systemkonten · Lotterie & Schwarzmarkt</CardTitle>
      </CardHeader>
      <p className="text-xs text-muted mb-4">
        Diese Konten nutzen dieselbe Economy-Infrastruktur, werden aber ausschließlich von ihrer Fachfunktion verändert. Deshalb gibt es hier bewusst keine generischen Konfigurieren-, Löschen-, Archivieren- oder Auszahlungsaktionen.
      </p>

      {query.isLoading && <p className="text-sm text-muted">Lade Systemkonten…</p>}
      {query.isError && <p className="text-sm text-danger">Systemkonten konnten nicht geladen werden: {(query.error as Error).message}</p>}
      {!query.isLoading && !query.isError && (query.data?.accounts.length ?? 0) === 0 && (
        <p className="text-sm text-muted">Aktuell existieren keine Lotterie- oder Schwarzmarkt-Systemkonten.</p>
      )}

      <div className="space-y-3">
        {query.data?.accounts.map(account => (
          <div key={account.id} className="rounded-lg border border-border/60 bg-bg-elev/40 p-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium text-white truncate">{account.accountEmoji} {account.name}</p>
                  <Badge variant="neutral">{account.kind}</Badge>
                  <Badge variant={account.status === 'ACTIVE' ? 'ok' : account.status === 'EXPIRED' ? 'warn' : 'neutral'}>{account.status}</Badge>
                  <Badge variant="neutral">verwaltet durch {ownerLabel(account)}</Badge>
                  {account.hidden && <Badge variant="warn">früher ausgeblendet</Badge>}
                </div>
                <div className="mt-2 grid max-w-xl grid-cols-3 gap-2 text-xs">
                  <div><span className="text-muted block">Wallet</span><span className="text-white font-semibold">{fmtBig(account.walletBalance)} {account.currencyEmoji}</span></div>
                  <div><span className="text-muted block">Bank</span><span className="text-white font-semibold">{fmtBig(account.bankBalance)} {account.currencyEmoji}</span></div>
                  <div><span className="text-muted block">Gesamt</span><span className="text-white font-semibold">{fmtBig(account.totalBalance)} {account.currencyEmoji}</span></div>
                </div>
                <p className="mt-2 text-[11px] text-muted">
                  Währung: {account.currencyName} {account.currencyEmoji}
                </p>
                {account.capabilities.readOnlyReason && (
                  <p className="mt-1 text-[11px] text-warning">{account.capabilities.readOnlyReason}</p>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
