from pathlib import Path

# 1) Resolved legacy scope must no longer block clean secondary gameservers.
p = Path('src/modules/economy/scopeMigration.ts')
s = p.read_text(encoding='utf-8')
s = s.replace(
''' * Bis alle Repository-Queries servergescopt sind, darf eine RESOLVED
 * Legacy-Economy ausserdem nur ueber ihren Primaerserver angesprochen werden.
''',
''' * Eine RESOLVED Legacy-Economy bindet ausschliesslich die alten migrierten
 * Zeilen an ihren Primaerserver. Alle heutigen Economy-/Casino-Repositories
 * sind Guild+Gameserver-gescoppt; andere aktive Server duerfen deshalb mit
 * eigenem, leerem Scope normal arbeiten und sehen niemals Legacy-Guthaben.
''', 1)
old = '''  if (state.primaryNitradoConnId !== nitradoConnId) {
    throw new EconomyScopeMismatchError(
      'Die vorhandene Legacy-Economy gehoert zum ausgewaehlten Primaerserver. Andere Server bleiben bis zur vollstaendigen serverbezogenen Kontoumstellung getrennt und ohne Zugriff auf Legacy-Guthaben.',
    );
  }
'''
new = '''  // RESOLVED bedeutet: alle alten NULL-gescopten Zeilen wurden exakt dem
  // gespeicherten Primaerserver zugeordnet. Ein anderer Server ist danach ein
  // eigener leerer Scope und darf sicher neue Economy-Daten anlegen.
  if (state.primaryNitradoConnId === nitradoConnId) return;
  return;
'''
if old not in s:
    raise SystemExit('scope mismatch guard marker missing')
p.write_text(s.replace(old, new, 1), encoding='utf-8')

# 2) Update unit invariant: unresolved stays blocked, resolved secondary scope is allowed.
p = Path('tests/modules/economyScopeMigration.test.ts')
t = p.read_text(encoding='utf-8')
old = '''  it('blockiert Zugriff ueber einen anderen als den Legacy-Primaerserver', async () => {
    migrationFindUnique.mockResolvedValue({
      guildId,
      status: 'RESOLVED',
      primaryNitradoConnId: connA,
      detectedActiveServerCount: 2,
      resolvedByDiscordId: actor,
      resolvedAt: new Date(),
    });
    await expect(assertEconomyScopeReady(guildId, connB)).rejects.toBeInstanceOf(EconomyScopeMismatchError);
  });
'''
new = '''  it('laesst nach der Legacy-Aufloesung einen zweiten servergescoppten Economy-Scope zu', async () => {
    migrationFindUnique.mockResolvedValue({
      guildId,
      status: 'RESOLVED',
      primaryNitradoConnId: connA,
      detectedActiveServerCount: 2,
      resolvedByDiscordId: actor,
      resolvedAt: new Date(),
    });
    await expect(assertEconomyScopeReady(guildId, connB)).resolves.toBeUndefined();
  });
'''
if old not in t:
    raise SystemExit('scope migration test marker missing')
p.write_text(t.replace(old, new, 1), encoding='utf-8')

# 3) Owner-facing migration resolver panel.
component = r'''import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, DatabaseZap, RefreshCw } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Select } from '@/components/ui/Select';

interface EconomyScopeStatus {
  required: boolean;
  state: {
    status: 'MIGRATION_REQUIRED' | 'RESOLVED';
    primaryNitradoConnId: string | null;
    detectedActiveServerCount: number;
    resolvedAt: string | null;
  } | null;
  servers: Array<{ id: string; slot: number; alias: string; nitradoServerId: string }>;
}

export function EconomyScopePanel({ guildId, slot }: { guildId: string; slot: string }) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const status = useQuery({
    queryKey: ['economy-scope-status', guildId],
    queryFn: () => api.get<EconomyScopeStatus>(`/api/v2/guilds/${guildId}/economy-scope/status`),
    retry: false,
  });

  const suggested = useMemo(() => {
    const servers = status.data?.servers ?? [];
    return servers.find(server => String(server.slot) === slot) ?? servers[0] ?? null;
  }, [status.data, slot]);

  useEffect(() => {
    if (status.data?.required && !selected && suggested) setSelected(suggested.id);
  }, [status.data?.required, selected, suggested]);

  const resolve = useMutation({
    mutationFn: () => api.post<{ ok: boolean; alreadyResolved: boolean; primaryNitradoConnId: string; updatedRows: number }>(
      `/api/v2/guilds/${guildId}/economy-scope/resolve`,
      { nitradoConnId: selected },
    ),
    onSuccess: async result => {
      setMessage(result.alreadyResolved
        ? 'Legacy-Economy war bereits korrekt zugeordnet.'
        : `Legacy-Economy zugeordnet (${result.updatedRows} bestehende Zeilen). Andere Slots starten getrennt mit eigenem Bestand.`);
      await status.refetch();
      await qc.invalidateQueries();
    },
    onError: (error: Error) => setMessage(error.message),
  });

  if (status.isLoading) return null;
  if (status.isError) {
    if (status.error instanceof ApiError && status.error.status === 403) return null;
    return (
      <Card>
        <CardHeader><CardTitle><span className="inline-flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-warning" />Economy-Scope pruefen</span></CardTitle></CardHeader>
        <p className="text-sm text-danger">Migrationsstatus konnte nicht geladen werden: {(status.error as Error).message}</p>
      </Card>
    );
  }
  if (!status.data?.required) return null;

  return (
    <Card className="border-warning/40 bg-warning/5">
      <CardHeader><CardTitle><span className="inline-flex items-center gap-2"><DatabaseZap className="h-4 w-4 text-warning" />Einmalige Economy-Zuordnung erforderlich</span></CardTitle></CardHeader>
      <div className="space-y-3">
        <p className="text-sm text-muted">
          Auf diesem Discord-Server existieren alte guildweite Economy-Daten aus der Zeit vor den servergetrennten Konten. Bevor Economy, Lotterie oder Schwarzmarkt starten koennen, muss der Server-Owner einmal festlegen, welchem Gameserver diese alten Daten gehoeren.
        </p>
        <p className="text-xs text-warning">
          Es werden keine Guthaben kopiert oder auf mehrere Server verteilt. Nur bestehende Legacy-Daten werden genau einem Primaerserver zugeordnet; alle anderen Slots beginnen danach als eigener Economy-Scope.
        </p>
        <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
          <label className="text-sm flex-1">
            <span className="text-muted">Legacy-Economy zuordnen zu</span>
            <Select value={selected} onChange={e => { setSelected(e.target.value); setMessage(null); }}>
              <option value="">— Gameserver waehlen —</option>
              {status.data.servers.map(server => (
                <option key={server.id} value={server.id}>Slot #{server.slot} · {server.alias || server.nitradoServerId}</option>
              ))}
            </Select>
          </label>
          <Button disabled={!selected || resolve.isPending} onClick={() => resolve.mutate()}>
            {resolve.isPending ? <><RefreshCw className="h-3.5 w-3.5 animate-spin mr-1" />Ordne zu…</> : 'Zuordnen & Economy freigeben'}
          </Button>
        </div>
        {message && <p className={`text-xs ${resolve.isError ? 'text-danger' : 'text-green-400'}`}>{message}</p>}
      </div>
    </Card>
  );
}
'''
Path('dashboard-ui/src/components/economy/EconomyScopePanel.tsx').write_text(component, encoding='utf-8')

# 4) Slot economy page: show resolver + exact backend error.
p = Path('dashboard-ui/src/pages/ServerSlot.tsx')
u = p.read_text(encoding='utf-8')
u = u.replace(
"import { BlackMarketPanel } from '@/components/economy/BlackMarketPanel';\n",
"import { BlackMarketPanel } from '@/components/economy/BlackMarketPanel';\nimport { EconomyScopePanel } from '@/components/economy/EconomyScopePanel';\n", 1)
u = u.replace(
'''            pending={updateEconomy.isPending}\n          />''',
'''            pending={updateEconomy.isPending}\n            error={economy.isError ? (economy.error as Error).message : null}\n          />''', 1)
u = u.replace(
'''  guildId, slot, data, loading, onSave, pending,\n}: {\n  guildId: string;\n  slot: string;\n  data: EconomyConfigState | undefined;\n  loading: boolean;\n  onSave: (p: Partial<EconomyConfigState>) => void;\n  pending: boolean;\n}) {''',
'''  guildId, slot, data, loading, onSave, pending, error,\n}: {\n  guildId: string;\n  slot: string;\n  data: EconomyConfigState | undefined;\n  loading: boolean;\n  onSave: (p: Partial<EconomyConfigState>) => void;\n  pending: boolean;\n  error: string | null;\n}) {''', 1)
u = u.replace(
'''    <div className="space-y-6">\n      <EconomyOverview guildId={guildId} slot={slot} />''',
'''    <div className="space-y-6">\n      <EconomyScopePanel guildId={guildId} slot={slot} />\n      <EconomyOverview guildId={guildId} slot={slot} />''', 1)
u = u.replace(
'''        {loading && <p className="text-muted">Lade…</p>}\n        {data && <EconomyForm value={data} onSave={onSave} pending={pending} />}''',
'''        {loading && <p className="text-muted">Lade…</p>}\n        {error && <p className="text-danger text-sm">Economy-Konfiguration konnte nicht geladen werden: {error}</p>}\n        {data && <EconomyForm value={data} onSave={onSave} pending={pending} />}''', 1)
p.write_text(u, encoding='utf-8')

# 5) Do not present mutation buttons as ready while their backing API is unavailable.
p = Path('dashboard-ui/src/components/economy/VirtualAccountsPanel.tsx')
v = p.read_text(encoding='utf-8')
v = v.replace('disabled={create.isPending || !nameValid || !expiryValid}', 'disabled={create.isPending || accounts.isError || !nameValid || !expiryValid}', 1)
v = v.replace('Virtuelle Konten konnten nicht geladen werden.</p>', 'Virtuelle Konten konnten nicht geladen werden: {(accounts.error as Error).message}</p>', 1)
v = v.replace('{audit.data?.entries.length === 0 &&', '{audit.isError && <p className="text-xs text-danger">Audit konnte nicht geladen werden: {(audit.error as Error).message}</p>}\n                {audit.data?.entries.length === 0 &&', 1)
p.write_text(v, encoding='utf-8')

p = Path('dashboard-ui/src/components/economy/LotteryPanel.tsx')
l = p.read_text(encoding='utf-8')
l = l.replace(
'''      <p className="text-xs text-muted mb-4">\n        Eine aktive Runde pro Gameserver. Der Pot ist ein gesperrtes LOTTERY_POT-Konto; Ziehung, Auszahlung und Refunds laufen idempotent über dieselbe Economy-Infrastruktur.\n      </p>''',
'''      <p className="text-xs text-muted mb-4">\n        Eine aktive Runde pro Gameserver. Der Pot ist ein gesperrtes LOTTERY_POT-Konto; Ziehung, Auszahlung und Refunds laufen idempotent über dieselbe Economy-Infrastruktur.\n      </p>\n      {current.isError && <p className="text-danger text-sm mb-2">Aktuelle Lotterie konnte nicht geladen werden: {(current.error as Error).message}</p>}\n      {history.isError && <p className="text-danger text-sm mb-2">Lotterie-Historie konnte nicht geladen werden: {(history.error as Error).message}</p>}''', 1)
l = l.replace('disabled={create.isPending || !formValid}', 'disabled={create.isPending || current.isError || history.isError || !formValid}', 1)
p.write_text(l, encoding='utf-8')

p = Path('dashboard-ui/src/components/economy/BlackMarketPanel.tsx')
b = p.read_text(encoding='utf-8')
b = b.replace('disabled={createVendor.isPending || vendorName.trim().length < 1}', 'disabled={createVendor.isPending || vendors.isError || listings.isError || vendorName.trim().length < 1}', 1)
b = b.replace('Haendler konnten nicht geladen werden.</p>', 'Haendler konnten nicht geladen werden: {(vendors.error as Error).message}</p>', 1)
b = b.replace('Angebote konnten nicht geladen werden.</p>', 'Angebote konnten nicht geladen werden: {(listings.error as Error).message}</p>', 1)
b = b.replace('Kaufhistorie konnte nicht geladen werden oder dir fehlt economy.manage.</p>', 'Kaufhistorie konnte nicht geladen werden: {(purchases.error as Error).message}</p>', 1)
p.write_text(b, encoding='utf-8')

# 6) Regression coverage for the exact post-deploy failure mode.
test = r'''import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('Economy runtime scope unblock', () => {
  const scope = read('src/modules/economy/scopeMigration.ts');
  const slot = read('dashboard-ui/src/pages/ServerSlot.tsx');
  const resolver = read('dashboard-ui/src/components/economy/EconomyScopePanel.tsx');
  const virtualAccounts = read('dashboard-ui/src/components/economy/VirtualAccountsPanel.tsx');
  const lottery = read('dashboard-ui/src/components/economy/LotteryPanel.tsx');
  const market = read('dashboard-ui/src/components/economy/BlackMarketPanel.tsx');

  it('blockiert nur unaufgeloeste Legacy-Economy und erlaubt danach getrennte Secondary-Scopes', () => {
    expect(scope).toContain("if (state.status !== 'RESOLVED' || !state.primaryNitradoConnId)");
    expect(scope).toContain('Ein anderer Server ist danach ein eigener leerer Scope');
    expect(scope).not.toContain('Andere Server bleiben bis zur vollstaendigen serverbezogenen Kontoumstellung getrennt und ohne Zugriff');
  });

  it('stellt die vorhandene Owner-Resolve-API direkt im Economy-Dashboard bereit', () => {
    expect(resolver).toContain('/economy-scope/status');
    expect(resolver).toContain('/economy-scope/resolve');
    expect(resolver).toContain('Es werden keine Guthaben kopiert oder auf mehrere Server verteilt.');
    expect(slot).toContain('<EconomyScopePanel guildId={guildId} slot={slot} />');
  });

  it('zeigt echte Backend-Ursachen statt generischer Ladefehler', () => {
    expect(slot).toContain('Economy-Konfiguration konnte nicht geladen werden: {error}');
    expect(virtualAccounts).toContain('{(accounts.error as Error).message}');
    expect(lottery).toContain('{(current.error as Error).message}');
    expect(market).toContain('{(vendors.error as Error).message}');
  });

  it('deaktiviert Create-Aktionen solange der Backing-Read fehlschlaegt', () => {
    expect(virtualAccounts).toContain('create.isPending || accounts.isError');
    expect(lottery).toContain('create.isPending || current.isError || history.isError');
    expect(market).toContain('createVendor.isPending || vendors.isError || listings.isError');
  });
});
'''
Path('tests/security/economyRuntimeScopeUnblock.test.ts').write_text(test, encoding='utf-8')

print('economy runtime scope repair applied')
