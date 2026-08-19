import fs from 'node:fs';
import path from 'node:path';

const read = (relative: string): string => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');
const panel = read('dashboard-ui/src/components/economy/VirtualAccountsPanel.tsx');
const guilds = read('src/dashboard/routes/v2/guilds.ts');
const route = read('src/dashboard/routes/v2/economyVirtualAccounts.ts');

describe('Economy-1K virtual account member autocomplete gate', () => {
  it('uses the scoped Discord member search instead of a raw user-id input', () => {
    expect(panel).toContain("import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';");
    expect(panel).toContain("queryKey: ['guild-members', guildId, memberQuery]");
    expect(panel).toContain('`/api/v2/guilds/${guildId}/members?limit=20');
    expect(panel).toContain('placeholder="Mitglied suchen..."');
    expect(panel).not.toContain('<span className="text-muted">Discord-User-ID</span>');
  });

  it('shows human identity but retains the stable Discord id as the canonical booking value', () => {
    expect(panel).toContain('id: member.id');
    expect(panel).toContain('label: member.displayName || member.username');
    expect(panel).toContain('hint: member.id');
    expect(panel).toContain("updatePayout({ userDiscordId: id ?? '' });");
    expect(panel).toContain('setSelectedMember(option);');
    expect(panel).toContain('userDiscordId: payout.userDiscordId');
    expect(route).toContain("targetUserId = asUserDiscordId(String(body.userDiscordId ?? ''))");
  });

  it('keeps an already selected human visible when server-side search results are replaced', () => {
    expect(panel).toContain('const [selectedMember, setSelectedMember] = useState<ComboboxOption | null>(null);');
    expect(panel).toContain('if (selectedMember && !options.some(option => option.id === selectedMember.id))');
    expect(panel).toContain('options.unshift(selectedMember);');
    expect(panel).toContain('setSelectedMember(null);');
  });

  it('keeps member lookup guild-scoped, rate-limited and rejects bots in the picker', () => {
    expect(guilds).toContain("guildsRouter.get('/:guildId/members', memberSearchLimiter, requireGuildAccess");
    expect(guilds).toContain('const guildId = req.guildScope!.guildId;');
    expect(panel).toContain('disabled: member.bot');
  });
});
