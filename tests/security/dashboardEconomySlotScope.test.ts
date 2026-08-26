import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const slot = fs.readFileSync(path.join(root, 'dashboard-ui', 'src', 'pages', 'ServerSlot.tsx'), 'utf8');
const virtualAccounts = fs.readFileSync(path.join(root, 'dashboard-ui', 'src', 'components', 'economy', 'VirtualAccountsControlPanel.tsx'), 'utf8');
const lottery = fs.readFileSync(path.join(root, 'dashboard-ui', 'src', 'components', 'economy', 'LotteryPanel.tsx'), 'utf8');
const market = fs.readFileSync(path.join(root, 'dashboard-ui', 'src', 'components', 'economy', 'BlackMarketPanel.tsx'), 'utf8');

describe('Dashboard Economy Slot Scope', () => {
  it('isoliert Economy-Config/Overview/Admin-Pay und React-Query-Cache pro Slot', () => {
    expect(slot).toContain("queryKey: ['economy', guildId, slot]");
    expect(slot).toContain('/economy/config?slot=${encodeURIComponent(slot!)}');
    expect(slot).toContain("queryKey: ['economy-overview', guildId, slot]");
    expect(slot).toContain('/economy/overview?slot=${encodeURIComponent(slot)}');
    expect(slot).toContain('/admin-pay?slot=${encodeURIComponent(slot)}');
  });

  it('isoliert Casino-Reads und Writes pro Slot', () => {
    expect(slot).toContain("queryKey: ['casino-games', guildId, slot]");
    expect(slot).toContain("queryKey: ['casino-stats', guildId, slot]");
    expect(slot).toContain('/casino/games?slot=${encodeURIComponent(slot)}');
    expect(slot).toContain('/casino/stats?slot=${encodeURIComponent(slot)}');
    expect(slot).toContain('/casino/games/${vars.type}?slot=${encodeURIComponent(slot)}');
  });

  it('gibt den Slot an alle Economy-Unterpanels weiter', () => {
    expect(slot).toContain('<VirtualAccountsPanel guildId={guildId} slot={slot} />');
    expect(slot).toContain('<LotteryPanel guildId={guildId} slot={slot} />');
    expect(slot).toContain('<BlackMarketPanel guildId={guildId} slot={slot} />');
    expect(slot).toContain('<CasinoTable guildId={guildId} slot={slot} />');
    expect(slot).toContain('<AdminPayForm guildId={guildId} slot={slot} />');
  });

  it('isoliert virtuelle Konten inklusive Control, Managerpanel, Audit und Payout pro Slot', () => {
    expect(virtualAccounts).toContain("{ guildId, slot }: { guildId: string; slot: string }");
    expect(virtualAccounts).toContain("['economy-virtual-control', guildId, slot]");
    expect(virtualAccounts).toContain('/control/accounts?slot=${encodeURIComponent(slot)}');
    expect(virtualAccounts).toContain("['economy-virtual-manager-panel', guildId, slot]");
    expect(virtualAccounts).toContain('/control/manager-panel?slot=${encodeURIComponent(slot)}');
    expect(virtualAccounts).toContain("['economy-virtual-account-audit', guildId, slot, auditAccountId]");
    expect(virtualAccounts).toContain('/payout?slot=${encodeURIComponent(slot)}');
  });

  it('isoliert Lotterie und Schwarzmarkt pro Slot', () => {
    expect(lottery).toContain("['economy-lottery-current', guildId, slot]");
    expect(lottery).toContain("['economy-lottery-history', guildId, slot]");
    expect(lottery).toContain('lottery/current?${scope}');
    expect(market).toContain("['economy-black-market-vendors', guildId, slot]");
    expect(market).toContain("['economy-black-market-listings', guildId, slot]");
    expect(market).toContain("['economy-black-market-purchases', guildId, slot]");
    expect(market).toContain('black-market/vendors?${scope}');
  });
});
