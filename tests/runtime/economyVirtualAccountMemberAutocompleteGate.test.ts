import fs from 'node:fs';
import { normalizeSourceNewlines } from '../helpers/sourceText';
import path from 'node:path';

const read = (relative: string): string => normalizeSourceNewlines(fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8'));
const panel = read('dashboard-ui/src/components/economy/VirtualAccountsPanel.tsx');
const route = read('src/dashboard/routes/v2/economyVirtualAccounts.ts');

describe('Economy-1K virtual account member autocomplete gate', () => {
  it('uses a server-scoped Discord member search instead of a raw user-id input', () => {
    expect(panel).toContain("import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';");
    expect(panel).toContain("queryKey: ['economy-virtual-payout-members', guildId, slot, memberQuery]");
    expect(panel).toContain('/economy/virtual-accounts/members?${scope}&limit=20');
    expect(panel).toContain('placeholder="Mitglied suchen..."');
    expect(panel).not.toContain('<span className="text-muted">Discord-User-ID</span>');
    expect(route).toContain("economyVirtualAccountsRouter.get('/members', payoutMemberSearchLimiter, requireGuildPermission('economy.view')");
    expect(route).toContain('const { scope } = scoped(req);');
  });

  it('shows Discord identity but uses the internal V-Bot User GUID as the canonical picker and request value', () => {
    expect(route).toContain("select: { id: true, discordId: true }");
    expect(route).toContain('id: userId');
    expect(route).toContain('discordId: member.id');
    expect(panel).toContain('id: member.id');
    expect(panel).toContain('hint: `Discord ${member.discordId}`');
    expect(panel).toContain('userId: payout.userId');
    expect(panel).not.toContain('userDiscordId: payout.userDiscordId');
    expect(panel).toContain('USER_GUID_RE.test(payout.userId)');
    expect(route).toContain('resolvePayoutTargetByUserGuid(String(scope.guildId), body.userId)');
  });

  it('revalidates a supplied internal GUID against active User and current guild membership before booking', () => {
    expect(route).toContain('where: { id: userId }');
    expect(route).toContain("if (!user || user.status !== 'ACTIVE')");
    expect(route).toContain('const member = guild.members.cache.get(user.discordId)');
    expect(route).toContain('await guild.members.fetch(user.discordId).catch(() => null)');
    expect(route).toContain('if (!member || member.user.bot)');
    expect(route).toContain('return asUserDiscordId(user.discordId);');
    expect(route).toContain('toUserId: targetUserId');
  });

  it('keeps an already selected human visible when server-side search results are replaced', () => {
    expect(panel).toContain('const [selectedMember, setSelectedMember] = useState<ComboboxOption | null>(null);');
    expect(panel).toContain('if (selectedMember && !options.some(option => option.id === selectedMember.id))');
    expect(panel).toContain('options.unshift(selectedMember);');
    expect(panel).toContain('setSelectedMember(null);');
  });

  it('rate-limits member lookup and exposes only registered active human guild members', () => {
    expect(route).toContain('const payoutMemberSearchLimiter = rateLimit({');
    expect(route).toContain('max: 30');
    expect(route).toContain('filter(member => !member.user.bot)');
    expect(route).toContain("where: { discordId: { in: discordIds }, status: 'ACTIVE' }");
    expect(route).toContain('if (!userId) return null;');
  });
});
