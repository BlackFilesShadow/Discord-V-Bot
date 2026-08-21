import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, PackagePlus, RefreshCw, ShoppingCart, Store, Truck } from 'lucide-react';
import { api } from '@/lib/api';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';

interface Vendor {
  id: string;
  name: string;
  balance: string;
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
  stock: number;
  maxPerPurchase: number;
  active: boolean;
  archivedAt: string | null;
  createdAt: string;
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
}

interface DashboardMeta {
  isOwner: boolean;
  permissions: string[];
}

interface PurchaseDraft {
  quantity: string;
  sourcePocket: 'WALLET' | 'BANK';
}

const MAX_MARKET_PRICE = 1_000_000_000_000_000n;
const MAX_MARKET_STOCK = 1_000_000_000;

function fmt(value: string): string {
  try { return BigInt(value).toLocaleString('de-DE'); } catch { return value; }
}

export function BlackMarketPanel({ guildId, slot }: { guildId: string; slot: string }) {
  const qc = useQueryClient();
  const scope = `slot=${encodeURIComponent(slot)}`;
  const [vendorName, setVendorName] = useState('');
  const [listing, setListing] = useState({ vendorAccountId: '', sku: '', name: '', description: '', price: '', stock: '0', maxPerPurchase: '10' });
  const [restock, setRestock] = useState<Record<string, string>>({});
  const [purchaseDrafts, setPurchaseDrafts] = useState<Record<string, PurchaseDraft>>({});
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  // Teilt sich bewusst denselben Query-Key wie ServerSlot. So gibt es eine
  // kanonische Berechtigungswahrheit fuer Buyer-vs-Manager-UI ohne neue Rechte.
  const dashboardMeta = useQuery({
    queryKey: ['dashboard-slot-meta', guildId, slot],
    queryFn: () => api.get<DashboardMeta>(`/api/v2/guilds/${guildId}/dashboard`),
    retry: false,
  });
  const canManage = Boolean(
    dashboardMeta.data?.isOwner || dashboardMeta.data?.permissions.includes('economy.manage'),
  );

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

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['economy-black-market-vendors', guildId, slot] });
    void qc.invalidateQueries({ queryKey: ['economy-black-market-listings', guildId, slot] });
    void qc.invalidateQueries({ queryKey: ['economy-black-market-purchases', guildId, slot] });
    void qc.invalidateQueries({ queryKey: ['economy-virtual-accounts', guildId, slot] });
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

  const createListing = useMutation({
    mutationFn: () => api.post<Listing>(`/api/v2/guilds/${guildId}/economy/black-market/listings?${scope}`, {
      vendorAccountId: listing.vendorAccountId,
      sku: listing.sku.trim(),
      name: listing.name.trim(),
      description: listing.description.trim() || null,
      price: listing.price.trim(),
      stock: Number(listing.stock),
      maxPerPurchase: Number(listing.maxPerPurchase),
    }),
    onSuccess: row => {
      setListing(current => ({ ...current, sku: '', name: '', description: '', price: '', stock: '0', maxPerPurchase: '10' }));
      setMessage({ ok: true, text: `Angebot „${row.name}“ erstellt.` });
      invalidate();
    },
    onError: (error: Error) => setMessage({ ok: false, text: error.message }),
  });

  const restockListing = useMutation({
    mutationFn: ({ id, stock }: { id: string; stock: number }) => api.post<Listing>(
      `/api/v2/guilds/${guildId}/economy/black-market/listings/${id}/restock?${scope}`,
      { stock },
    ),
    onSuccess: row => {
      setMessage({ ok: true, text: `Bestand fuer „${row.name}“ aktualisiert.` });
      invalidate();
    },
    onError: (error: Error) => setMessage({ ok: false, text: error.message }),
  });

  const archiveListing = useMutation({
    mutationFn: (id: string) => api.post<Listing>(`/api/v2/guilds/${guildId}/economy/black-market/listings/${id}/archive?${scope}`, {}),
    onSuccess: row => {
      setMessage({ ok: true, text: `Angebot „${row.name}“ archiviert.` });
      invalidate();
    },
    onError: (error: Error) => setMessage({ ok: false, text: error.message }),
  });

  const purchaseListing = useMutation({
    mutationFn: (vars: { id: string; quantity: number; sourcePocket: 'WALLET' | 'BANK' }) =>
      api.post<{ booked: boolean; purchase: Purchase; listing: Listing }>(
        `/api/v2/guilds/${guildId}/economy/black-market/listings/${vars.id}/purchase?${scope}`,
        { quantity: vars.quantity, sourcePocket: vars.sourcePocket },
      ),
    onSuccess: (result, vars) => {
      setMessage({
        ok: true,
        text: result.booked
          ? `Kauf gebucht: ${result.purchase.quantity}× fuer ${fmt(result.purchase.amount)}.`
          : 'Dieser Kauf war bereits verarbeitet; es wurde nicht doppelt gebucht.',
      });
      setPurchaseDrafts(current => ({ ...current, [vars.id]: { quantity: '1', sourcePocket: vars.sourcePocket } }));
      invalidate();
    },
    onError: (error: Error) => setMessage({ ok: false, text: `Kauf fehlgeschlagen: ${error.message}` }),
  });

  const activeVendors = useMemo(() => (vendors.data?.vendors ?? []).filter(v => v.status === 'ACTIVE'), [vendors.data]);
  const vendorNameValid = vendorName.trim().length >= 1 && vendorName.trim().length <= 80;
  const listingValid = listing.vendorAccountId.length > 0
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(listing.sku.trim())
    && listing.name.trim().length >= 1 && listing.name.trim().length <= 120
    && listing.description.length <= 500
    && /^\d+$/.test(listing.price) && BigInt(listing.price || '0') >= 1n && BigInt(listing.price || '0') <= MAX_MARKET_PRICE
    && /^\d+$/.test(listing.stock) && Number.isSafeInteger(Number(listing.stock)) && Number(listing.stock) <= MAX_MARKET_STOCK
    && /^\d+$/.test(listing.maxPerPurchase) && Number(listing.maxPerPurchase) >= 1 && Number(listing.maxPerPurchase) <= 1000;

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
        Serverseparater Haendler mit eigenem MARKET_VENDOR-Konto. Bestand und Zahlung werden beim Kauf atomar gebucht; die Ausgabe der DayZ-Items bleibt bewusst manuell.
      </p>

      {canManage && (
        <div className="grid gap-4 xl:grid-cols-2">
          <div className="rounded-lg border border-border/60 bg-bg/40 p-3 space-y-3">
            <p className="text-sm font-medium text-white">Haendler anlegen</p>
            <Input value={vendorName} onChange={e => setVendorName(e.target.value)} maxLength={80} placeholder="z. B. Nachtmarkt" />
            <Button disabled={createVendor.isPending || vendors.isError || listings.isError || !vendorNameValid} onClick={() => { setMessage(null); createVendor.mutate(); }}>
              {createVendor.isPending ? 'Erstelle…' : 'Haendler erstellen'}
            </Button>
            <div className="space-y-1 pt-2 border-t border-border/50">
              {(vendors.data?.vendors ?? []).map(vendor => (
                <div key={vendor.id} className="flex items-center justify-between gap-2 text-xs py-1.5">
                  <span className="truncate text-white">{vendor.name}</span>
                  <span className="flex items-center gap-2"><Badge variant={vendor.status === 'ACTIVE' ? 'ok' : 'neutral'}>{vendor.status}</Badge><strong>{fmt(vendor.balance)}</strong></span>
                </div>
              ))}
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
              <Input value={listing.sku} onChange={e => setListing(current => ({ ...current, sku: e.target.value }))} maxLength={80} placeholder="SKU" />
              <Input value={listing.name} onChange={e => setListing(current => ({ ...current, name: e.target.value }))} maxLength={120} placeholder="Produktname" />
              <Input value={listing.price} onChange={e => setListing(current => ({ ...current, price: e.target.value.trim() }))} inputMode="numeric" placeholder="Preis" />
              <Input value={listing.stock} onChange={e => setListing(current => ({ ...current, stock: e.target.value.trim() }))} inputMode="numeric" placeholder="Bestand" />
              <Input value={listing.maxPerPurchase} onChange={e => setListing(current => ({ ...current, maxPerPurchase: e.target.value.trim() }))} inputMode="numeric" placeholder="Max. pro Kauf" />
              <Input value={listing.description} onChange={e => setListing(current => ({ ...current, description: e.target.value }))} maxLength={500} placeholder="Beschreibung (optional)" />
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
            const draftStock = restock[row.id] ?? String(row.stock);
            const stockValid = /^\d+$/.test(draftStock)
              && Number.isSafeInteger(Number(draftStock))
              && Number(draftStock) <= MAX_MARKET_STOCK;
            const buyDraft = purchaseDrafts[row.id] ?? { quantity: '1', sourcePocket: 'WALLET' as const };
            const buyQuantity = Number(buyDraft.quantity);
            const buyValid = row.active
              && row.stock > 0
              && /^\d+$/.test(buyDraft.quantity)
              && Number.isSafeInteger(buyQuantity)
              && buyQuantity >= 1
              && buyQuantity <= Math.min(1000, row.maxPerPurchase, row.stock);
            return (
              <div key={row.id} className="rounded-lg border border-border/60 bg-bg-elev/40 p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2"><strong className="text-white">{row.name}</strong><Badge variant={row.active ? 'ok' : 'neutral'}>{row.active ? 'AKTIV' : 'ARCHIVIERT'}</Badge></div>
                    <p className="text-xs text-muted mt-1">{row.sku} · Preis {fmt(row.price)} · Bestand {row.stock} · Limit {row.maxPerPurchase}</p>
                    {row.description && <p className="text-xs text-muted/80 mt-1">{row.description}</p>}
                  </div>
                  {row.active && canManage && (
                    <div className="flex flex-wrap items-center gap-2">
                      <Input aria-label={`Bestand ${row.name}`} className="w-24" value={draftStock} onChange={e => setRestock({ ...restock, [row.id]: e.target.value.trim() })} inputMode="numeric" />
                      <Button size="sm" variant="ghost" disabled={!stockValid || restockListing.isPending} onClick={() => restockListing.mutate({ id: row.id, stock: Number(draftStock) })}>Bestand</Button>
                      <Button aria-label={`Angebot ${row.name} archivieren`} size="sm" variant="danger" disabled={archiveListing.isPending} onClick={() => archiveListing.mutate(row.id)}><Archive className="h-3.5 w-3.5" /></Button>
                    </div>
                  )}
                </div>

                {row.active && (
                  <div className="mt-3 pt-3 border-t border-border/50 flex flex-wrap items-end gap-2">
                    <label className="text-xs">
                      <span className="text-muted block mb-1">Kaufmenge</span>
                      <Input
                        aria-label={`Kaufmenge ${row.name}`}
                        className="w-20"
                        value={buyDraft.quantity}
                        onChange={e => setPurchaseDrafts(current => ({
                          ...current,
                          [row.id]: { ...buyDraft, quantity: e.target.value.trim() },
                        }))}
                        inputMode="numeric"
                      />
                    </label>
                    <label className="text-xs">
                      <span className="text-muted block mb-1">Bezahlen aus</span>
                      <Select
                        aria-label={`Bezahlen aus ${row.name}`}
                        value={buyDraft.sourcePocket}
                        onChange={e => setPurchaseDrafts(current => ({
                          ...current,
                          [row.id]: { ...buyDraft, sourcePocket: e.target.value as 'WALLET' | 'BANK' },
                        }))}
                      >
                        <option value="WALLET">Wallet</option>
                        <option value="BANK">Bank</option>
                      </Select>
                    </label>
                    <Button
                      size="sm"
                      disabled={!buyValid || purchaseListing.isPending}
                      onClick={() => {
                        setMessage(null);
                        purchaseListing.mutate({ id: row.id, quantity: buyQuantity, sourcePocket: buyDraft.sourcePocket });
                      }}
                    >
                      <ShoppingCart className="h-3.5 w-3.5 mr-1" />{purchaseListing.isPending ? 'Buche…' : 'Kaufen'}
                    </Button>
                    {row.stock === 0 && <span className="text-xs text-muted">Ausverkauft</span>}
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
          <p className="text-sm font-medium text-white mb-2">Letzte Kaeufe</p>
          <div className="space-y-1 max-h-52 overflow-y-auto">
            {(purchases.data?.purchases ?? []).map(purchase => (
              <div key={purchase.id} className="grid sm:grid-cols-[1fr,auto,auto] gap-2 text-xs border-b border-border/40 py-1.5 last:border-0">
                <span className="text-muted truncate">User {purchase.userDiscordId}</span>
                <span>{purchase.quantity}× · {fmt(purchase.amount)}</span>
                <span className="text-muted/70">{new Date(purchase.createdAt).toLocaleString('de-DE')}</span>
              </div>
            ))}
            {purchases.isError && <p className="text-danger text-xs">Kaufhistorie konnte nicht geladen werden: {(purchases.error as Error).message}</p>}
          </div>
        </div>
      )}

      {message && <p className={`mt-3 text-xs ${message.ok ? 'text-green-400' : 'text-danger'}`}>{message.text}</p>}
    </Card>
  );
}
