import fs from 'node:fs';
import { normalizeSourceNewlines } from '../helpers/sourceText';
import path from 'node:path';

const read = (relative: string): string => normalizeSourceNewlines(fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8'));
const panel = read('dashboard-ui/src/components/economy/VirtualAccountsControlPanel.tsx');
const route = read('src/dashboard/routes/v2/economyVirtualAccounts.ts');
const safetyRoute = read('src/dashboard/routes/v2/economyVirtualAccountTreasurySafety.ts');

describe('Economy virtual account member autocomplete gate', () => {
  it('uses server-scoped Discord member searches instead of raw payout or manager user-id fields', () => {
    expect(panel).toContain("import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';");
    expect(panel).toContain("queryKey: ['economy-virtual-payout-members', guildId, slot, query]");
    expect(panel).toContain('/economy/virtual-accounts/members?slot=${encodeURIComponent(slot)}&limit=20');
    expect(panel).toContain('/economy/virtual-accounts/control/members?slot=${encodeURIComponent(slot)}');
    expect(panel).toContain('placeholder="Guild-Mitglied suchen…"');
    expect(route).toContain("economyVirtualAccountsRouter.get('/members', payoutMemberSearchLimiter, requireGuildPermission('economy.view')");
  });

  it('keeps the internal V-Bot User GUID only for the legacy admin payout compatibility request', () => {
    expect(route).toContain("select: { id: true, discordId: true }");
    expect(route).toContain('id: userId');
    expect(route).toContain('discordId: member.id');
    expect(panel).toContain('id: member.id');
    expect(panel).toContain('hint: `Discord ${member.discordId}`');
    expect(panel).toContain('userId: form.userId');
    expect(panel).toContain('USER_GUID_RE.test(form.userId)');
  });

  it('revalidates the supplied internal GUID against active User and current human guild membership before booking', () => {
    expect(safetyRoute).toContain('where: { id: rawUser }');
    expect(safetyRoute).toContain("if (!user || user.status !== 'ACTIVE')");
    expect(safetyRoute).toContain('guild.members.cache.get(user.discordId)');
    expect(safetyRoute).toContain('await guild.members.fetch(user.discordId).catch(() => null)');
    expect(safetyRoute).toContain('if (!member || member.user.bot)');
    expect(safetyRoute).toContain('toUserDiscordId: asUserDiscordId(user.discordId)');
  });

  it('keeps an already selected payout human visible when server-side search results are replaced', () => {
    expect(panel).toContain('const [selectedMember, setSelectedMember] = useState<ComboboxOption | null>(null);');
    expect(panel).toContain('if (selectedMember && !mapped.some(option => option.id === selectedMember.id)) mapped.unshift(selectedMember);');
    expect(panel).toContain('setSelectedMember(null);');
  });

  it('rate-limits legacy member lookup and control lookup exposes only human guild members', () => {
    expect(route).toContain('const payoutMemberSearchLimiter = rateLimit({');
    expect(route).toContain('max: 30');
    expect(route).toContain('filter(member => !member.user.bot)');
    expect(route).toContain("where: { discordId: { in: discordIds }, status: 'ACTIVE' }");
    expect(panel).toContain("queryKey: ['economy-virtual-manager-members', guildId, slot, query]");
  });
});
