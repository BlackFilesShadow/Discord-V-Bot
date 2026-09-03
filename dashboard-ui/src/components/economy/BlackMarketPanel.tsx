import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, Check, PackagePlus, RefreshCw, RotateCcw, ShoppingCart, Store, Trash2, Truck, WalletCards } from 'lucide-react';
import { api } from '@/lib/api';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { BlackMarketDiscordSettings } from './BlackMarketDiscordSettings';

interface DeliveryItem {
  itemText: string;
  quantity: number;
}

interface Vendor {
  id: string;
  name: string;
  balance: string;
  pendingLiability: string;
  withdrawableBalance: string;
  status: 'ACTIVE' | 'EXPIRED' | 'ARCHIVED';
  createdAt: string;
}

interface Listing {
  id: string;
  vendorAccountId: string;
  sku: string;
  name: string;
  description: string | null;
  price: string;
  active: boolean;
  archivedAt: string | null;
  createdAt: string;
  deliveryItems: DeliveryItem[];
}

interface Purchase {
  id: string;
  listingId: string;
  vendorAccountId: string;
  userDiscordId: string;
  sourcePocket: 'WALLET' | 'BANK';
  quantity: number;
  unitPrice: string;
  amount: string;
  createdAt: string;
  fulfillmentStatus: 'PENDING' | 'DELIVERED' | 'REFUNDED' | 'LEGACY';
  deliveryItems: DeliveryItem[];
  fulfilledAt: string | null;
  fulfillmentNote: string | null;
  refundedAt: string | null;
  refundReason: string | null;
}

interface DashboardMeta {
  isOwner: boolean;
  permissions: string[];
}

interface EconomyCurrency {
  currencyName: string;
  emoji: string;
}

interface PurchaseDraft {
  quantity: string;
  sourcePocket: 'WALLET' | 'BANK';
}

interface VendorPayoutDraft {
  targetUserId: string;
  amount: string;
  targetPocket: 'WALLET' | 'BANK';
}

interface DiscordMember {
  discordId: string;
  username: string;
  displayName: string;
  avatar: string | null;
}

const MAX_MARKET_PRICE = 1_000_000_000_000_000n;
const MAX_TECHNICAL_QUANTITY = 2_147_483_647;
const SNOWFLAKE_RE = /^\d{17,20}$/;

function hasControlChars(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code !== undefined && (code < 0x20 || code === 0x7f)) return true;
  }
  return false;
}

function fmt(value: string): string {
  try { return BigInt(value).toLocaleString('de-DE'); } catch { return value; }
}

function money(value: string, emoji: string): string {
  return `${fmt(value)} ${emoji}`.trim();
}

function itemSnapshot(items: DeliveryItem[]): string {
  return items.length ? items.map(item => `${item.itemText}${item.quantity > 1 ? ` × ${item.quantity}` : ''}`).join(' · ') : '—';
}

function fulfillmentBadge(status: Purchase['fulfillmentStatus']) {
  if (status === 'PENDING') return <Badge variant="warn">OFFEN</Badge>;
  if (status === 'DELIVERED') return <Badge variant="ok">GELIEFERT</Badge>;
  if (status === 'REFUNDED') return <Badge variant="neutral">REFUNDIERT</Badge>;
  return <Badge variant="neutral">LEGACY</Badge>;
}

function syncText(base: string, syncWarning?: string | null): string {
  return syncWarning ? `${base} Discord-Sync: ${syncWarning}` : base;
}

export function BlackMarketPanel({ guildId, slot }: { guildId: string; slot: string }) {
  const qc = useQueryClient();
  const scope = `slot=${encodeURIComponent(slot)}`;
  const [vendorName, setVendorName] = useState('');
  const [listing, setListing] = useState({ vendorAccountId: '', name: '', description: '', price: '' });
  const [purchaseDrafts, setPurchaseDrafts] = useState<Record<string, PurchaseDraft>>({});
  const [payoutDrafts, setPayoutDrafts] = useState<Record<string, VendorPayoutDraft>>({});
  const [payoutMemberQuery, setPayoutMemberQuery] = useState('');
  const [refundReasons, setRefundReasons] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const dashboardMeta = useQuery({
    queryKey: ['dashboard-slot-meta', guildId, slot],
    queryFn: () => api.get<DashboardMeta>(`/api/v2/guilds/${guildId}/dashboard`),
    retry: false,
  });
  const canManage = Boolean(dashboardMeta.data?.isOwner || dashboardMeta.data?.permissions.includes('economy.manage'));

  const currency = useQuery({
    queryKey: ['economy-config', guildId, slot],
    queryFn: () => api.get<EconomyCurrency>(`/api/v2/guilds/${guildId}/economy/config?${scope}`),
    retry: false,
  });
  const currencyEmoji = currency.data?.emoji ?? '🪙';
  const currencyName = currency.data?.currencyName ?? 'Währung';

  const vendors = useQuery({
    queryKey: ['economy-black-market-vendors', guildId, slot],
    queryFn: () => api.get<{ vendors: Vendor[] }>(`/api/v2/guilds/${guildId}/economy/black-market/vendors?${scope}`),
    enabled: canManage,
    retry: false,
  });
  const listings = useQuery({
    queryKey: ['economy-black-market-listings', guildId, slot, canManage ? 'manage' : 'view'],
    queryFn: () => api.get<{ listings: Listing[] }>(
      `/api/v2/guilds/${guildId}/economy/black-market/listings?${scope}&includeInactive=${canManage ? 'true' : 'false'}`,
    ),
    retry: false,
  });
  const purchases = useQuery({
    queryKey: ['economy-black-market-purchases', guildId, slot],
    queryFn: () => api.get<{ purchases: Purchase[] }>(`/api/v2/guilds/${guildId}/economy/black-market/purchases?${scope}&limit=50`),
    enabled: canManage,
    retry: false,
  });
  const payoutMembers = useQuery({
    queryKey: ['economy-black-market-payout-members', guildId, slot, payoutMemberQuery],
    queryFn: () => api.get<{ members: DiscordMember[] }>(
      `/api/v2/guilds/${guildId}/economy/virtual-accounts/control/members?slot=${encodeURIComponent(slot)}&limit=20${payoutMemberQuery ? `&q=${encodeURIComponent(payoutMemberQuery)}` : ''}`,
    ),
    enabled: canManage,
    placeholderData: previous => previous,
    retry: false,
  });
  const payoutMemberOptions = useMemo<ComboboxOption[]>(() => (payoutMembers.data?.members ?? []).map(member => ({
    id: member.discordId,
    label: member.displayName || member.username,
    hint: member.username,
    avatar: member.avatar ? `https://cdn.discordapp.com/avatars/${member.discordId}/${member.avatar}.png?size=64` : undefined,
  })), [payoutMembers.data?.members]);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['economy-black-market-vendors', guildId, slot] });
    void qc.invalidateQueries({ queryKey: ['economy-black-market-listings', guildId, slot] });
    void qc.invalidateQueries({ queryKey: ['economy-black-market-purchases', guildId, slot] });
    void qc.invalidateQueries({ queryKey: ['economy-black-market-discord', guildId, slot] });
    void qc.invalidateQueries({ queryKey: ['economy-virtual-control', guildId, slot] });
    void qc.invalidateQueries({ queryKey: ['economy-overview', guildId, slot] });
  };

  const createVendor = useMutation({
    mutationFn: () => api.post<Vendor>(`/api/v2/guilds/${guildId}/economy/black-market/vendors?${scope}`, { name: vendorName.trim() }),
    onSuccess: vendor => {
      setVendorName('');
      setListing(current => ({ ...current, vendorAccountId: vendor.id }));
      setMessage({ ok: true, text: `Haendler „${vendor.name}“ erstellt.` });
      invalidate();
    },
    onError: (error: Error) => setMessage({ ok: false, text: error.message }),
  });

  const payoutVendor = useMutation({
    mutationFn: (vars: { id: string; draft: VendorPayoutDraft }) => api.post<{ booked: boolean; vendor: Vendor; syncWarning?: string | null }>(
      `/api/v2/guilds/${guildId}/economy/black-market/vendors/${vars.id}/payout?${scope}`,
      { targetUserId: vars.draft.targetUserId, amount: vars.draft.amount, targetPocket: vars.draft.targetPocket },
    ),
    onSuccess: result => {
      setMessage({ ok: true, text: syncText(result.booked ? 'Haendlerguthaben ausgezahlt.' : 'Diese Auszahlung war bereits verarbeitet.', result.syncWarning) });
      invalidate();
    },
    onError: (error: Error) => setMessage({ ok: false, text: `Auszahlung fehlgeschlagen: ${error.message}` }),
  });

  const archiveVendor = useMutation({
    mutationFn: (id: string) => api.post<Vendor & { syncWarning?: string | null }>(`/api/v2/guilds/${guildId}/economy/black-market/vendors/${id}/archive?${scope}`, {}),
    onSuccess: vendor => {
      setMessage({ ok: true, text: syncText(`Haendler „${vendor.name}“ archiviert.`, vendor.syncWarning) });
      invalidate();
    },
    onError: (error: Error) => setMessage({ ok: false, text: `Archivierung fehlgeschlagen: ${error.message}` }),
  });

  const removeVendor = useMutation({
    mutationFn: (id: string) => api.del<{ ok: boolean; removed: { id: string; name: string; mode: 'CONTROL_HIDDEN'; changed: boolean }; syncWarning?: string | null }>(
      `/api/v2/guilds/${guildId}/economy/black-market/vendors/${id}?${scope}`,
    ),
    onSuccess: result => {
      const base = result.removed.changed
        ? `Haendler „${result.removed.name}“ entfernt. Bestell-, Kauf- und Audit-Historie bleiben erhalten.`
        : `Haendler „${result.removed.name}“ war bereits entfernt.`;
      setMessage({ ok: true, text: syncText(base, result.syncWarning) });
      invalidate();
    },
    onError: (error: Error) => setMessage({ ok: false, text: `Entfernen fehlgeschlagen: ${error.message}` }),
  });

  const createListing = useMutation({
    mutationFn: () => api.post<Listing & { syncWarning?: string | null }>(`/api/v2/guilds/${guildId}/economy/black-market/listings?${scope}`, {
      vendorAccountId: listing.vendorAccountId,
      name: listing.name,
      description: listing.description.trim() || null,
      price: listing.price.trim(),
    }),
    onSuccess: row => {
      setListing(current => ({ ...current, name: '', description: '', price: '' }));
      setMessage({ ok: true, text: syncText(`Angebot „${row.name}“ erstellt.`, row.syncWarning) });
      invalidate();
    },
    onError: (error: Error) => setMessage({ ok: false, text: error.message }),
  });

  const archiveListing = useMutation({
    mutationFn: (id: string) => api.post<Listing & { syncWarning?: string | null }>(`/api/v2/guilds/${guildId}/economy/black-market/listings/${id}/archive?${scope}`, {}),
    onSuccess: row => {
      setMessage({ ok: true, text: syncText(`Angebot „${row.name}“ archiviert.`, row.syncWarning) });
      invalidate();
    },
    onError: (error: Error) => setMessage({ ok: false, text: `Archivierung fehlgeschlagen: ${error.message}` }),
  });

  const removeListing = useMutation({
    mutationFn: (id: string) => api.del<{ ok: boolean; removed: { id: string; name: string; mode: 'CONTROL_HIDDEN' }; syncWarning?: string | null }>(
      `/api/v2/guilds/${guildId}/economy/black-market/listings/${id}?${scope}`,
    ),
    onSuccess: result => {
      setMessage({ ok: true, text: syncText(`Angebot „${result.removed.name}“ entfernt. Bestehende Bestellungen und Audit-Historie bleiben erhalten.`, result.syncWarning) });
      invalidate();
    },
    onError: (error: Error) => setMessage({ ok: false, text: `Entfernen fehlgeschlagen: ${error.message}` }),
  });

  const purchaseListing = useMutation({
    mutationFn: (vars: { id: string; quantity: number; sourcePocket: 'WALLET' | 'BANK' }) =>
      api.post<{ booked: boolean; purchase: Purchase; listing: Listing; syncWarning?: string | null }>(
        `/api/v2/guilds/${guildId}/economy/black-market/listings/${vars.id}/purchase?${scope}`,
        { quantity: vars.quantity, sourcePocket: vars.sourcePocket },
      ),
    onSuccess: (result, vars) => {
      setMessage({
        ok: true,
        text: syncText(result.booked
          ? `Bestellung ${result.purchase.id} gebucht: ${result.purchase.quantity}× fuer ${money(result.purchase.amount, currencyEmoji)}. Status: OFFEN.`
          : 'Dieser Kauf war bereits verarbeitet; es wurde nicht doppelt gebucht.', result.syncWarning),
      });
      setPurchaseDrafts(current => ({ ...current, [vars.id]: { quantity: '1', sourcePocket: vars.sourcePocket } }));
      invalidate();
    },
    onError: (error: Error) => setMessage({ ok: false, text: `Kauf fehlgeschlagen: ${error.message}` }),
  });

  const deliverPurchase = useMutation({
    mutationFn: (id: string) => api.post<{ changed: boolean; purchase: Purchase }>(
      `/api/v2/guilds/${guildId}/economy/black-market/purchases/${id}/deliver?${scope}`,
      {},
    ),
    onSuccess: result => {
      setMessage({ ok: true, text: result.changed ? `Bestellung ${result.purchase.id} als geliefert markiert.` : 'Bestellung war bereits geliefert.' });
      invalidate();
    },
    onError: (error: Error) => setMessage({ ok: false, text: `Lieferstatus fehlgeschlagen: ${error.message}` }),
  });

  const refundPurchase = useMutation({
    mutationFn: (vars: { id: string; reason: string }) => api.post<{ booked: boolean; purchase: Purchase; syncWarning?: string | null }>(
      `/api/v2/guilds/${guildId}/economy/black-market/purchases/${vars.id}/refund?${scope}`,
      { reason: vars.reason },
    ),
    onSuccess: result => {
      setMessage({ ok: true, text: syncText(result.booked ? `Bestellung ${result.purchase.id} vollständig refundiert.` : 'Dieser Refund war bereits verarbeitet.', result.syncWarning) });
      invalidate();
    },
    onError: (error: Error) => setMessage({ ok: false, text: `Refund fehlgeschlagen: ${error.message}` }),
  });

  const activeVendors = useMemo(() => (vendors.data?.vendors ?? []).filter(v => v.status === 'ACTIVE'), [vendors.data]);
  const vendorNameValid = vendorName.trim().length >= 1 && vendorName.trim().length <= 80;
  const listingValid = listing.vendorAccountId.length > 0
    && listing.name.trim().length >= 1 && listing.name.trim().length <= 120
    && !hasControlChars(listing.name.trim())
    && listing.description.length <= 500
    && /^\d+$/.test(listing.price) && BigInt(listing.price || '0') >= 1n && BigInt(listing.price || '0') <= MAX_MARKET_PRICE;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle><span className="inline-flex items-center gap-2"><Store className="h-4 w-4" />Schwarzmarkt</span></CardTitle>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void listings.refetch();
              void currency.refetch();
              if (canManage) { void vendors.refetch(); void purchases.refetch(); }
            }}
            disabled={listings.isFetching || (canManage && (vendors.isFetching || purchases.isFetching))}
            aria-label="Schwarzmarkt aktualisieren"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${listings.isFetching || (canManage && (vendors.isFetching || purchases.isFetching)) ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </CardHeader>

      <p className="text-xs text-muted mb-4">
        Gegenstände sind Freitext: schreibe sie genau so hinein, wie sie angezeigt werden sollen — inklusive Emoji, z. B. „🔫 M4A1“. Angebote besitzen weder Mengenbestand noch ein konfigurierbares Kauflimit. Sie bleiben verfügbar, solange sie aktiv sind. Entfernen blendet das Angebot aus und beendet Direktkäufe, ohne bestehende Bestellungen oder Audit-Historie zu zerstören. V-Bot ergänzt automatisch die Server-Währung {currencyName} {currencyEmoji}.
      </p>

      <BlackMarketDiscordSettings guildId={guildId} slot={slot} canManage={canManage} onMessage={setMessage} />

      {canManage && (
        <div className="grid gap-4 xl:grid-cols-2">
          <div className="rounded-lg border border-border/60 bg-bg/40 p-3 space-y-3">
            <p className="text-sm font-medium text-white">Haendler anlegen</p>
            <Input value={vendorName} onChange={e => setVendorName(e.target.value)} maxLength={80} placeholder="z. B. Nachtmarkt" />
            <Button disabled={createVendor.isPending || vendors.isError || listings.isError || !vendorNameValid} onClick={() => { setMessage(null); createVendor.mutate(); }}>
              {createVendor.isPending ? 'Erstelle…' : 'Haendler erstellen'}
            </Button>
            <div className="space-y-3 pt-2 border-t border-border/50">
              {(vendors.data?.vendors ?? []).map(vendor => {
                const draft = payoutDrafts[vendor.id] ?? { targetUserId: '', amount: '', targetPocket: 'WALLET' as const };
                const payoutValid = vendor.status === 'ACTIVE' && SNOWFLAKE_RE.test(draft.targetUserId) && /^\d+$/.test(draft.amount) && BigInt(draft.amount || '0') > 0n && BigInt(draft.amount || '0') <= BigInt(vendor.withdrawableBalance);
                return (
                  <div key={vendor.id} className="rounded border border-border/40 p-2 space-y-2 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-white font-medium">{vendor.name}</span>
                      <Badge variant={vendor.status === 'ACTIVE' ? 'ok' : 'neutral'}>{vendor.status}</Badge>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-muted">
                      <span>Saldo <strong className="text-white block">{money(vendor.balance, currencyEmoji)}</strong></span>
                      <span>Reserviert <strong className="text-white block">{money(vendor.pendingLiability, currencyEmoji)}</strong></span>
                      <span>Frei <strong className="text-white block">{money(vendor.withdrawableBalance, currencyEmoji)}</strong></span>
                    </div>
                    {vendor.status === 'ACTIVE' && (
                      <div className="grid gap-2 2xl:grid-cols-[minmax(0,1fr)_110px_110px_auto_auto] items-end">
                        <Combobox
                          value={draft.targetUserId || null}
                          onChange={targetUserId => setPayoutDrafts(current => ({ ...current, [vendor.id]: { ...draft, targetUserId: targetUserId ?? '' } }))}
                          options={payoutMemberOptions}
                          onSearch={setPayoutMemberQuery}
                          loading={payoutMembers.isFetching}
                          placeholder="Discord-Mitglied auswählen…"
                          emptyText="Kein menschliches Guild-Mitglied gefunden."
                          disabled={payoutVendor.isPending}
                        />
                        <Input aria-label={`Auszahlungsbetrag ${vendor.name}`} value={draft.amount} onChange={e => setPayoutDrafts(current => ({ ...current, [vendor.id]: { ...draft, amount: e.target.value.trim() } }))} inputMode="numeric" placeholder={`Betrag ${currencyEmoji}`} />
                        <Select aria-label={`Auszahlungszielkonto ${vendor.name}`} value={draft.targetPocket} onChange={e => setPayoutDrafts(current => ({ ...current, [vendor.id]: { ...draft, targetPocket: e.target.value as 'WALLET' | 'BANK' } }))}>
                          <option value="WALLET">Wallet</option><option value="BANK">Bank</option>
                        </Select>
                        <Button size="sm" variant="ghost" disabled={!payoutValid || payoutVendor.isPending} onClick={() => payoutVendor.mutate({ id: vendor.id, draft })}><WalletCards className="h-3.5 w-3.5 mr-1" />Auszahlen</Button>
                        <Button aria-label={`Haendler ${vendor.name} archivieren`} title="Archivieren ist erst möglich, wenn Guthaben, aktive Angebote und offene Bestellungen abgearbeitet sind." size="sm" variant="ghost" disabled={archiveVendor.isPending || removeVendor.isPending} onClick={() => archiveVendor.mutate(vendor.id)}><Archive className="h-3.5 w-3.5 mr-1" />Archivieren</Button>
                        <Button
                          className="2xl:col-start-5"
                          aria-label={`Haendler ${vendor.name} entfernen`}
                          title="Entfernen ist nur für aktive Händler ohne Wallet-/Bank-Guthaben, aktive Angebote oder offene Bestellungen möglich. Historie bleibt erhalten."
                          size="sm"
                          variant="danger"
                          disabled={removeVendor.isPending || archiveVendor.isPending}
                          onClick={() => {
                            if (window.confirm(`Haendler „${vendor.name}“ wirklich entfernen? Bestell-, Kauf- und Audit-Historie bleiben erhalten.`)) removeVendor.mutate(vendor.id);
                          }}
                        ><Trash2 className="h-3.5 w-3.5 mr-1" />Löschen</Button>
                      </div>
                    )}
                  </div>
                );
              })}
              {vendors.isError && <p className="text-danger text-xs">Haendler konnten nicht geladen werden: {(vendors.error as Error).message}</p>}
            </div>
          </div>

          <div className="rounded-lg border border-border/60 bg-bg/40 p-3 space-y-3">
            <p className="text-sm font-medium text-white inline-flex items-center gap-1.5"><PackagePlus className="h-3.5 w-3.5" />Angebot anlegen</p>
            <Select value={listing.vendorAccountId} onChange={e => setListing(current => ({ ...current, vendorAccountId: e.target.value }))}>
              <option value="">— Haendler waehlen —</option>
              {activeVendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
            </Select>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="text-xs sm:col-span-2">
                <span className="text-muted block mb-1">Gegenstand / Item</span>
                <Input value={listing.name} onChange={e => setListing(current => ({ ...current, name: e.target.value }))} maxLength={120} placeholder="z. B. 🔫 M4A1" />
              </label>
              <label className="text-xs sm:col-span-2">
                <span className="text-muted block mb-1">Preis in {currencyName} {currencyEmoji}</span>
                <Input value={listing.price} onChange={e => setListing(current => ({ ...current, price: e.target.value.trim() }))} inputMode="numeric" placeholder="Preis" />
              </label>
              <label className="text-xs sm:col-span-2">
                <span className="text-muted block mb-1">Beschreibung (optional)</span>
                <Input value={listing.description} onChange={e => setListing(current => ({ ...current, description: e.target.value }))} maxLength={500} placeholder="Beschreibung" />
              </label>
            </div>
            <Button disabled={createListing.isPending || !listingValid} onClick={() => { setMessage(null); createListing.mutate(); }}>
              {createListing.isPending ? 'Erstelle…' : 'Angebot erstellen'}
            </Button>
          </div>
        </div>
      )}

      <div className={`${canManage ? 'mt-5' : ''} pt-4 ${canManage ? 'border-t border-border' : ''}`}>
        <p className="text-sm font-medium text-white mb-2 inline-flex items-center gap-1.5"><Truck className="h-3.5 w-3.5" />Angebote</p>
        <div className="space-y-2">
          {(listings.data?.listings ?? []).map(row => {
            const buyDraft = purchaseDrafts[row.id] ?? { quantity: '1', sourcePocket: 'WALLET' as const };
            const buyQuantity = Number(buyDraft.quantity);
            const buyValid = row.active && /^\d+$/.test(buyDraft.quantity)
              && Number.isSafeInteger(buyQuantity) && buyQuantity >= 1 && buyQuantity <= MAX_TECHNICAL_QUANTITY;
            return (
              <div key={row.id} className="rounded-lg border border-border/60 bg-bg-elev/40 p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2"><strong className="text-white break-words">{row.name}</strong><Badge variant={row.active ? 'ok' : 'neutral'}>{row.active ? 'AKTIV' : 'ARCHIVIERT'}</Badge></div>
                    <p className="text-xs text-muted mt-1">Preis <strong className="text-white">{money(row.price, currencyEmoji)}</strong></p>
                    {row.description && <p className="text-xs text-muted/80 mt-1">{row.description}</p>}
                  </div>
                  {canManage && (
                    <div className="flex items-center gap-2">
                      {row.active && (
                        <Button aria-label={`Angebot ${row.name} archivieren`} size="sm" variant="ghost" disabled={archiveListing.isPending || removeListing.isPending} onClick={() => archiveListing.mutate(row.id)}><Archive className="h-3.5 w-3.5" /></Button>
                      )}
                      <Button
                        aria-label={`Angebot ${row.name} entfernen`}
                        size="sm"
                        variant="danger"
                        disabled={removeListing.isPending || archiveListing.isPending}
                        onClick={() => {
                          if (window.confirm(`Angebot „${row.name}“ wirklich entfernen? Bestehende Bestellungen bleiben erhalten.`)) removeListing.mutate(row.id);
                        }}
                      ><Trash2 className="h-3.5 w-3.5" /></Button>
                    </div>
                  )}
                </div>

                {row.active && (
                  <div className="mt-3 pt-3 border-t border-border/50 flex flex-wrap items-end gap-2">
                    <label className="text-xs"><span className="text-muted block mb-1">Kaufmenge</span><Input aria-label={`Kaufmenge ${row.name}`} className="w-28" value={buyDraft.quantity} onChange={e => setPurchaseDrafts(current => ({ ...current, [row.id]: { ...buyDraft, quantity: e.target.value.trim() } }))} inputMode="numeric" /></label>
                    <label className="text-xs"><span className="text-muted block mb-1">Bezahlen aus</span><Select aria-label={`Bezahlen aus ${row.name}`} value={buyDraft.sourcePocket} onChange={e => setPurchaseDrafts(current => ({ ...current, [row.id]: { ...buyDraft, sourcePocket: e.target.value as 'WALLET' | 'BANK' } }))}><option value="WALLET">Wallet</option><option value="BANK">Bank</option></Select></label>
                    <Button size="sm" disabled={!buyValid || purchaseListing.isPending} onClick={() => { setMessage(null); purchaseListing.mutate({ id: row.id, quantity: buyQuantity, sourcePocket: buyDraft.sourcePocket }); }}><ShoppingCart className="h-3.5 w-3.5 mr-1" />{purchaseListing.isPending ? 'Buche…' : 'Kaufen'}</Button>
                  </div>
                )}
              </div>
            );
          })}
          {listings.isError && <p className="text-danger text-xs">Angebote konnten nicht geladen werden: {(listings.error as Error).message}</p>}
          {(listings.data?.listings ?? []).length === 0 && !listings.isLoading && <p className="text-muted text-xs">Noch keine Angebote vorhanden.</p>}
        </div>
      </div>

      {canManage && (
        <div className="mt-5 pt-4 border-t border-border">
          <p className="text-sm font-medium text-white mb-2">Bestellungen & Auslieferung</p>
          <div className="space-y-2 max-h-[34rem] overflow-y-auto">
            {(purchases.data?.purchases ?? []).map(purchase => {
              const reason = refundReasons[purchase.id] ?? '';
              return (
                <div key={purchase.id} className="rounded border border-border/40 p-2 text-xs space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-muted">User <strong className="text-white">{purchase.userDiscordId}</strong> · {purchase.quantity}× · {money(purchase.amount, currencyEmoji)} · {purchase.sourcePocket}</span>
                    {fulfillmentBadge(purchase.fulfillmentStatus)}
                  </div>
                  <div className="text-muted/80">ID <code>{purchase.id}</code> · {new Date(purchase.createdAt).toLocaleString('de-DE')}</div>
                  <div className="text-muted/80">{itemSnapshot(purchase.deliveryItems ?? [])}</div>
                  {purchase.fulfillmentNote && <div className="text-muted/80">Notiz: {purchase.fulfillmentNote}</div>}
                  {purchase.refundReason && <div className="text-muted/80">Refund: {purchase.refundReason}</div>}
                  {purchase.fulfillmentStatus === 'PENDING' && (
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <Button size="sm" variant="ghost" disabled={deliverPurchase.isPending || refundPurchase.isPending} onClick={() => deliverPurchase.mutate(purchase.id)}><Check className="h-3.5 w-3.5 mr-1" />Geliefert</Button>
                      <Input aria-label={`Refund-Grund ${purchase.id}`} className="min-w-52 flex-1" value={reason} onChange={e => setRefundReasons(current => ({ ...current, [purchase.id]: e.target.value }))} maxLength={500} placeholder="Refund-Grund" />
                      <Button size="sm" variant="danger" disabled={reason.trim().length < 1 || deliverPurchase.isPending || refundPurchase.isPending} onClick={() => refundPurchase.mutate({ id: purchase.id, reason: reason.trim() })}><RotateCcw className="h-3.5 w-3.5 mr-1" />Refund</Button>
                    </div>
                  )}
                </div>
              );
            })}
            {purchases.isError && <p className="text-danger text-xs">Kaufhistorie konnte nicht geladen werden: {(purchases.error as Error).message}</p>}
          </div>
        </div>
      )}

      {message && <p className={`mt-3 text-xs ${message.ok ? 'text-ok' : 'text-danger'}`}>{message.text}</p>}
    </Card>
  );
}