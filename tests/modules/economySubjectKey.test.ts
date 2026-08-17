import { economySubjectKey, replaceEconomySubject } from '../../src/modules/economy/subjectKey';

const SECRET = '0123456789abcdef0123456789abcdef';

describe('economySubjectKey', () => {
  it('is stable for the same guild and user without exposing the raw user id', () => {
    const first = economySubjectKey('guild-1', '111111111111111111', SECRET);
    const second = economySubjectKey('guild-1', '111111111111111111', SECRET);
    expect(first).toBe(second);
    expect(first).toMatch(/^es1_[a-f0-9]{32}$/);
    expect(first).not.toContain('111111111111111111');
  });

  it('separates the same user across guilds', () => {
    expect(economySubjectKey('guild-1', '111111111111111111', SECRET))
      .not.toBe(economySubjectKey('guild-2', '111111111111111111', SECRET));
  });

  it('rejects empty/control identifiers and short secrets', () => {
    expect(() => economySubjectKey('', 'u', SECRET)).toThrow(/guildId/);
    expect(() => economySubjectKey('g', 'u\n2', SECRET)).toThrow(/userDiscordId/);
    expect(() => economySubjectKey('g', 'u', 'short')).toThrow(/Secret/);
  });

  it('replaces legacy raw subjects deterministically inside immutable references', () => {
    expect(replaceEconomySubject('interest:g:n:d:USER', 'USER', 'es1_hash'))
      .toBe('interest:g:n:d:es1_hash');
    expect(replaceEconomySubject(null, 'USER', 'es1_hash')).toBeNull();
  });
});
