import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(
  path.resolve(process.cwd(), 'src/commands/dashboard/economy.ts'),
  'utf8',
);

function block(start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`Block not found: ${start} -> ${end}`);
  return source.slice(from, to);
}

describe('Economy embed presentation contract', () => {
  it('/balance keeps actor semantics by default and switches only for an explicitly selected user', () => {
    const balance = block('export const balanceCommand', 'export const payCommand');

    expect(balance).toContain(".setName('user')");
    expect(balance).toContain('.setRequired(false)');
    expect(balance).toContain("const selectedUser = i.options.getUser('user');");
    expect(balance).toContain('const targetUser = selectedUser ?? i.user;');
    expect(balance).toContain('const targetUserId = selectedUser ? asUserDiscordId(selectedUser.id) : scope.actorDiscordId;');
    expect(balance).toContain('const acc = await getAccountOrZero(scope.guildId, connId, targetUserId);');
    expect(balance).toContain('compactDescription(`▣ Balance · <@${targetUser.id}>`');
    expect(balance).toContain('`Cash: **${fmt(acc.walletBalance)} ${cfg.emoji}**`');
    expect(balance).toContain('`Bank: **${fmt(acc.bankBalance)} ${cfg.emoji}**`');
    expect(balance).toContain('`Total: **${fmt(total)} ${cfg.emoji}**`');
    expect(balance).toContain('await embedReply(i, e, false);');
  });

  it('does not change the established economy mutation calls or their actor scope', () => {
    const pay = block('export const payCommand', 'export const adminPayCommand');
    const deposit = block('export const depositCommand', 'export const withdrawCommand');
    const withdraw = block('export const withdrawCommand', 'export const transferCommand');
    const transfer = block('export const transferCommand', 'export const bankCommand');

    expect(pay).toContain('fromUserId: scope.actorDiscordId');
    expect(pay).toContain('toUserId: asUserDiscordId(target.id)');
    expect(pay).toContain('amount: betrag');
    expect(pay).toContain('ephemeral: false');

    expect(deposit).toContain('await deposit(scope.guildId, connId, scope.actorDiscordId, amount);');
    expect(withdraw).toContain('await withdraw(scope.guildId, connId, scope.actorDiscordId, amount);');
    expect(transfer).toContain('fromUserId: scope.actorDiscordId');
    expect(transfer).toContain('toUserId: asUserDiscordId(target.id)');
    expect(transfer).toContain('amount });');
  });

  it('uses the configured currency and the compact bank/reference structure', () => {
    const deposit = block('export const depositCommand', 'export const withdrawCommand');
    const withdraw = block('export const withdrawCommand', 'export const transferCommand');
    const bank = source.slice(source.indexOf('export const bankCommand'));

    expect(source).not.toContain('`${fmt(amount)} $`');
    expect(deposit).toContain('Eingezahlt: **${fmt(amount)} ${cfg.emoji}**');
    expect(deposit).toContain('Bank: **${fmt(acc.bankBalance)} ${cfg.emoji}**');
    expect(deposit).toContain('Cash: **${fmt(acc.walletBalance)} ${cfg.emoji}**');
    expect(withdraw).toContain('Abgehoben: **${fmt(amount)} ${cfg.emoji}**');
    expect(withdraw).toContain('Cash: **${fmt(acc.walletBalance)} ${cfg.emoji}**');
    expect(withdraw).toContain('Bank: **${fmt(acc.bankBalance)} ${cfg.emoji}**');
    expect(bank).toContain('compactDescription(`▣ Bank · <@${i.user.id}>`');
  });
});
