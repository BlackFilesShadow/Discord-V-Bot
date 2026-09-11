import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

const discord = read('src/modules/economy/virtualAccountDiscord.ts');
const interactions = read('src/modules/economy/virtualAccountInteractions.ts');
const managerSafety = read('src/modules/economy/virtualAccountManagerPanelSafety.ts');
const liveUpdates = read('src/modules/economy/virtualAccountLiveUpdates.ts');

describe('virtual account Discord presentation contract', () => {
  it('uses the compact no-title presentation for fixed V-Bot account surfaces', () => {
    expect(discord).toContain('compactEmbed(');
    expect(discord).toContain('compactDescription(');
    expect(discord).not.toContain('.setTitle(');

    expect(managerSafety).toContain('compactEmbed(');
    expect(managerSafety).toContain('compactDescription(');
    expect(managerSafety).not.toContain('.setTitle(');
  });

  it('keeps configurable account presentation data and real update time visible', () => {
    expect(discord).toContain("if (style === 'BOLD')");
    expect(discord).toContain("if (style === 'ITALIC')");
    expect(discord).toContain("if (style === 'BOLD_ITALIC')");
    expect(discord).toContain('if (finance.bannerUrl) embed.setImage(finance.bannerUrl);');
    expect(discord).toContain('.setTimestamp(account.updatedAt)');
    expect(discord).toContain('finance.currencyEmoji');
    expect(discord).toContain('finance.currencyName');
  });

  it('keeps archive and live projection behavior intact while only changing formatting', () => {
    expect(discord).toContain('archiveChannel.threads.create({');
    expect(discord).toContain('existingThread.parentId !== archiveChannel.id');
    expect(discord).toContain('postVirtualAccountArchive');
    expect(liveUpdates).toContain('await postVirtualAccountArchive(client, {');
    expect(liveUpdates).toContain('await syncVirtualAccountProjectionUnsafe(client, guildId, connId, accountId);');
  });

  it('keeps virtual-account interactions ephemeral and account-bound', () => {
    expect(interactions).toContain('compactEmbed(');
    expect(interactions).toContain('compactDescription(');
    expect(interactions).not.toContain('vEmbed(');
    expect(interactions).toContain('MessageFlags.Ephemeral');
    expect(interactions).toContain('await assertManager(interaction, accountId);');
    expect(interactions).toContain('vacct_mgr_user:payout:${accountId}');
    expect(interactions).toContain('vacct_mgr_move:wb:${accountId}');
    expect(interactions).toContain('vacct_mgr_move:bw:${accountId}');
  });
});
