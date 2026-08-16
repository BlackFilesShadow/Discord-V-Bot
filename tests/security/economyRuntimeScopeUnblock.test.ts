import fs from 'node:fs';
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
    const readyGuard = scope.slice(
      scope.indexOf('export async function assertEconomyScopeReady'),
      scope.indexOf('export interface ResolveLegacyEconomyResult'),
    );
    expect(readyGuard).toContain("if (state.status !== 'RESOLVED' || !state.primaryNitradoConnId)");
    expect(readyGuard).not.toContain('throw new EconomyScopeMismatchError');
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
