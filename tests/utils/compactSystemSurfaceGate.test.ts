import fs from 'node:fs';
import path from 'node:path';

const compactSystemSurfaces = [
  'src/commands/about.ts',
  'src/commands/user/ticket.ts',
  'src/commands/user/feedback.ts',
  'src/commands/user/register.ts',
  'src/commands/user/upload.ts',
  'src/commands/user/search.ts',
  'src/commands/user/level.ts',
  'src/commands/user/reminder.ts',
  'src/commands/user/fraktionen.ts',
  'src/commands/user/moderation.ts',
  'src/commands/user/caseManagement.ts',
  'src/commands/dashboard/permissions.ts',
  'src/commands/dashboard/virtualAccounts.ts',
  'src/modules/leaderboard/leaderboardFeed.ts',
  'src/modules/reminders/reminderScheduler.ts',
  'src/modules/ai/translatedPostSchedulerV2.ts',
] as const;

function source(file: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');
}

describe('compact V-Bot system surface gate', () => {
  it.each(compactSystemSurfaces)('%s keeps system headings out of Discord title', file => {
    const text = source(file);
    expect(text).not.toContain('.setTitle(');
    expect(text).toMatch(/compact(?:Description|Embed)|buildStatusEmbed|economyEmbed/);
  });

  it('keeps the user-configurable embed builder outside the forced system layout', () => {
    const text = source('src/modules/embeds/embedBuilder.ts');
    expect(text).toContain('new EmbedBuilder()');
    expect(text).toContain('embed.setTitle(');
  });

  it('keeps domain timestamps where they encode real event time', () => {
    expect(source('src/commands/user/caseManagement.ts')).toContain('.setTimestamp(modCase.createdAt)');
  });

  it('keeps ephemeral security/admin interaction contracts on migrated commands', () => {
    expect(source('src/commands/user/ticket.ts')).toContain('deferReply({ flags: MessageFlags.Ephemeral })');
    expect(source('src/commands/user/reminder.ts')).toContain('deferReply({ flags: MessageFlags.Ephemeral })');
    expect(source('src/commands/dashboard/permissions.ts')).toContain('flags: MessageFlags.Ephemeral');
    expect(source('src/commands/dashboard/virtualAccounts.ts')).toContain('flags: MessageFlags.Ephemeral');
  });
});
