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
  'src/modules/bans/expiryRuntime.ts',
  'src/modules/economy/marketOrderReadyRuntime.ts',
  'src/modules/economy/virtualAccountDiscord.ts',
  'src/modules/economy/virtualAccountManagerPanelSafety.ts',
  'src/modules/nitrado/driftDiscord.ts',
  'src/modules/nitrado/serverListCatalog.ts',
  'src/modules/ai/translatedPostSchedulerV2.ts',
  'src/modules/radar/runtime.ts',
] as const;

const compactInteractiveSurfacesWithModalTitles = [
  'src/modules/economy/virtualAccountInteractions.ts',
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

  it.each(compactInteractiveSurfacesWithModalTitles)('%s keeps compact embeds while allowing Discord modal titles', file => {
    const text = source(file);
    expect(text).not.toContain('vEmbed(');
    expect(text).toContain('compactEmbed(');
    expect(text).toContain('compactDescription(');
  });

  it('keeps user-configurable embeds outside the forced system layout', () => {
    const builder = source('src/modules/embeds/embedBuilder.ts');
    expect(builder).toContain('new EmbedBuilder()');
    expect(builder).toContain('embed.setTitle(');

    const webhook = source('src/modules/feeds/webhookReceiver.ts');
    expect(webhook).toContain('.setTitle(data.title)');
    expect(webhook).toContain('if (data.url) embed.setURL(data.url)');
    expect(webhook).toContain('if (data.image) embed.setImage(data.image)');
  });

  it('keeps domain timestamps where they encode real event time', () => {
    expect(source('src/commands/user/caseManagement.ts')).toContain('.setTimestamp(modCase.createdAt)');
    expect(source('src/modules/bans/expiryRuntime.ts')).toContain('.setTimestamp(ban.liftedAt ?? new Date())');
    expect(source('src/modules/economy/marketOrderReadyRuntime.ts')).toContain('.setTimestamp(now)');
    expect(source('src/modules/economy/virtualAccountDiscord.ts')).toContain('.setTimestamp(account.updatedAt)');
    expect(source('src/modules/nitrado/driftDiscord.ts')).toContain('.setTimestamp()');
    expect(source('src/modules/nitrado/serverListCatalog.ts')).toContain('.setTimestamp()');
  });

  it('keeps ephemeral security/admin interaction contracts on migrated commands', () => {
    expect(source('src/commands/user/ticket.ts')).toContain('deferReply({ flags: MessageFlags.Ephemeral })');
    expect(source('src/commands/user/reminder.ts')).toContain('deferReply({ flags: MessageFlags.Ephemeral })');
    expect(source('src/commands/dashboard/permissions.ts')).toContain('flags: MessageFlags.Ephemeral');
    expect(source('src/commands/dashboard/virtualAccounts.ts')).toContain('flags: MessageFlags.Ephemeral');
    expect(source('src/modules/economy/virtualAccountInteractions.ts')).toContain('MessageFlags.Ephemeral');
  });
});
