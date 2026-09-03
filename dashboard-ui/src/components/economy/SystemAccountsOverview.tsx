import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
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
  kind: 'CUSTOM' | 'LOTTERY_POT' | 'MARKET_VENDOR';
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
  if (account.capabilities.managedBy === 'SERVER_BANK') return 'Serverbank';
  return 'Fachfunktion';
}

export function SystemAccountsOverview({ guildId, slot, onConfigureServerBank }: {
  guildId: string;
  slot: string;
  onConfigureServerBank: () => void;
}) {
  const query = useQuery({
    queryKey: ['economy-system-accounts', guildId, slot],
    queryFn: () => api.get<{ accounts: SystemAccountRow[] }>(
      `/api/v2/guilds/${guildId}/economy/virtual-accounts/control/system-accounts?slot=${encodeURIComponent(slot)}`,
    ),
    retry: false,
  });
  // Runtime responses can temporarily be incomplete during rolling deployments,
  // stale proxies or test fixtures. Never let an optional read-only registry take
  // down the whole account workspace; an invalid/missing list is rendered empty.
  const responseAccounts = query.data?.accounts;
  const hasValidAccounts = Array.isArray(responseAccounts);
  const accounts: SystemAccountRow[] = Array.isArray(responseAccounts) ? responseAccounts : [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Systemkonten · Lotterie, Schwarzmarkt & Serverbank</CardTitle>
      </CardHeader>
      <p className="text-xs text-muted mb-4">
        Lotterie und Schwarzmarkt werden ausschließlich in ihren Fachbereichen verändert. Die Serverbank ist direkt über „Serverbank konfigurieren“ erreichbar; Löschen und Archivieren sind für Systemkonten nicht verfügbar.
      </p>

      {query.isLoading && <p className="text-sm text-muted">Lade Systemkonten…</p>}
      {query.isError && <p className="text-sm text-danger">Systemkonten konnten nicht geladen werden: {(query.error as Error).message}</p>}
      {!query.isLoading && !query.isError && query.data && !hasValidAccounts && (
        <p className="text-sm text-warning">Systemkonto-Antwort ist unvollständig. Die übrige Kontenverwaltung bleibt verfügbar; bitte Seite aktualisieren.</p>
      )}
      {!query.isLoading && !query.isError && hasValidAccounts && accounts.length === 0 && (
        <p className="text-sm text-muted">Aktuell existieren keine Lotterie-, Schwarzmarkt- oder Serverbank-Systemkonten.</p>
      )}

      <div className="space-y-3">
        {accounts.map(account => (
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
              {account.capabilities.managedBy === 'SERVER_BANK' && account.capabilities.canConfigure && (
                <Button size="sm" variant="outline" onClick={onConfigureServerBank}>Serverbank konfigurieren</Button>
              )}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
