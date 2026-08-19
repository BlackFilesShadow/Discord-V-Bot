import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('Economy-Lotterie — Runtime/Dashboard Integration', () => {
  const v2 = read('src/dashboard/routes/v2.ts');
  const route = read('src/dashboard/routes/v2/economyLottery.ts');
  const interaction = read('src/events/interactionCreate.ts');
  const index = read('src/index.ts');
  const command = read('src/commands/dashboard/lottery.ts');
  const inventory = read('src/commands/inventory.ts');
  const serverSlot = read('dashboard-ui/src/pages/ServerSlot.tsx');
  const panel = read('dashboard-ui/src/components/economy/LotteryPanel.tsx');

  it('mountet Lottery hinter Domain-Auth und kanonischem Gameserver-Scope vor dem generischen Economy-Router', () => {
    const lotteryMount = "v2Router.use('/guilds/:guildId/economy/lottery', requireEconomyDashboardAccess, requireSafeDashboardEconomyScope, economyLotteryRouter);";
    const generic = "v2Router.use('/guilds/:guildId/economy', requireEconomyDashboardAccess, requireSafeDashboardEconomyScope, economyRouter);";
    expect(v2).toContain(lotteryMount);
    expect(v2.indexOf(lotteryMount)).toBeLessThan(v2.indexOf(generic));
    expect(route).toContain("requireGuildPermission('economy.view')");
    expect(route).toContain("requireGuildPermission('economy.manage')");
    expect(route).not.toMatch(/economyLotteryRouter\.delete\s*\(/);
  });

  it('registriert genau die User-Funktionen status/buy/my und keine Admin-Start-Kommandos', () => {
    expect(command).toContain(".setName('lottery')");
    expect(command).toContain(".setName('status')");
    expect(command).toContain(".setName('buy')");
    expect(command).toContain(".setName('my')");
    expect(command).not.toContain(".setName('start')");
    expect(command).not.toContain(".setName('end')");
    expect(command).toContain('idempotencyKey: `discord-slash:${interaction.id}`');
    expect(command).toContain('await refreshLotteryMessage(interaction.client, round.id)');
    expect(command).toContain('Lotterie-Embed-Refresh nach Slash-Kauf');
    expect(inventory).toContain("'lottery'");
  });

  it('verdrahtet Buttons zentral und startet/stoppt den Scheduler mit der Bot-Runtime', () => {
    expect(interaction).toContain("button.customId.startsWith('lottery_buy_')");
    expect(interaction).toContain('handleLotteryBuyButton');
    const lottery = read('src/modules/economy/lottery.ts');
    expect(lottery).toContain('Lotterie-Embed-Refresh nach Button-Kauf');
    expect(lottery).toContain('const potName = `Lotterie ${roundId}`;');
    expect(lottery).toContain('nameKey: potName.toLowerCase()');
    expect(lottery).toContain('Teilnahme beendet. Die Auswertung läuft.');
    expect(index).toContain("import { startLotteryScheduler, stopLotteryScheduler } from './modules/economy/lottery';");
    expect(index).toContain('startLotteryScheduler(client);');
    expect(index).toContain('stopLotteryScheduler();');
  });

  it('integriert die responsive und slotgescoppte Dashboard-Verwaltung in Economy', () => {
    expect(serverSlot).toContain("import { LotteryPanel } from '@/components/economy/LotteryPanel';");
    expect(serverSlot).toContain('<LotteryPanel guildId={guildId} slot={slot} />');
    expect(panel).toContain("{ guildId, slot }: { guildId: string; slot: string }");
    expect(panel).toContain('lottery/current?${scope}');
    expect(panel).toContain('md:grid-cols-2');
    expect(panel).toContain('md:grid-cols-4');
    expect(panel).toContain('Lotterie starten');
    expect(panel).toContain('Jetzt beenden');
  });

  it('spiegelt economy.manage und die Domain-Grenzen fail-closed in der UI', () => {
    expect(panel).toContain("queryKey: ['dashboard-slot-meta', guildId, slot]");
    expect(panel).toContain("permissions.includes('economy.manage')");
    expect(panel).toContain("active.status === 'ACTIVE' && canManage");
    expect(panel).toContain('!active && canManage');
    expect(panel).toContain('const MAX_TICKET_PRICE = 1_000_000_000_000n;');
    expect(panel).toContain('const MIN_END_DELAY_MS = 60_000;');
    expect(panel).toContain('const MAX_END_DELAY_MS = 30 * 24 * 60 * 60 * 1000;');
    expect(panel).toContain("channel.type === 0 || channel.type === 5");
    expect(panel).toContain('channelValid');
    expect(panel).toContain('ticketValid');
  });
});
