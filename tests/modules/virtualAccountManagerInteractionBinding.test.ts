import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

describe('virtual-account manager interaction binding', () => {
  const interactions = read('src/modules/economy/virtualAccountInteractions.ts');
  const composite = read('src/events/interactionCreateComposite.ts');

  it('routes every manager component to the specialized account-bound handler', () => {
    expect(composite).toContain("i.customId.startsWith('vacct_mgr:')");
    expect(composite).toContain("i.customId.startsWith('vacct_mgr_move:')");
    expect(composite).toContain("i.customId.startsWith('vacct_mgr_order:')");
    expect(composite).toContain("i.customId.startsWith('vacct_mgr_sel:')");
    expect(composite).toContain("i.customId.startsWith('vacct_mgr_user:')");
  });

  it('binds payout to an account-selected Discord member instead of accepting a mention or ID', () => {
    expect(interactions).toContain('new UserSelectMenuBuilder()');
    expect(interactions).toContain('vacct_mgr_user:payout:${accountId}');
    expect(interactions).toContain('vacct_mgr_modal:payout:${accountId}:${target}');
    expect(interactions).toContain('const [, operation, accountId, selectedTarget] = interaction.customId.split');
    expect(interactions).toContain('await assertManager(interaction, accountId);');
    expect(interactions).toContain('await ensureHumanGuildMember(interaction, target);');
    expect(interactions).not.toContain('Empfänger (Mention oder Discord-ID)');
    expect(interactions).not.toContain('function parseDiscordId');
  });

  it('rechecks manager authorization before payout, removal and pocket transfers', () => {
    expect(interactions).toContain('const scope = await assertManager(interaction, accountId);');
    expect(interactions).toContain('safePayoutVirtualAccountToUser({');
    expect(interactions).toContain('safeRemoveVirtualAccountAmount({');
    expect(interactions).toContain('safeTransferVirtualPocket({');
  });
});