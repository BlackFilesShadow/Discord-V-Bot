import {
  isGlobalBotAdminIdentity,
  isGlobalDeveloperIdentity,
  resolveBotOwnerId,
} from '../../src/security/privilegedIdentity';

describe('privileged global identities', () => {
  const owner = '123456789012345678';

  it('prefers BOT_OWNER_ID and accepts matching legacy alias', () => {
    expect(resolveBotOwnerId({ BOT_OWNER_ID: owner } as NodeJS.ProcessEnv)).toBe(owner);
    expect(resolveBotOwnerId({ BOT_OWNER_ID: owner, DISCORD_OWNER_ID: owner } as NodeJS.ProcessEnv)).toBe(owner);
  });

  it('rejects conflicting or malformed owner identities', () => {
    expect(() => resolveBotOwnerId({ BOT_OWNER_ID: owner, DISCORD_OWNER_ID: '223456789012345678' } as NodeJS.ProcessEnv)).toThrow(/widersprechen/);
    expect(() => resolveBotOwnerId({ BOT_OWNER_ID: 'owner-name' } as NodeJS.ProcessEnv)).toThrow(/Snowflake/);
  });

  it('keeps the canonical owner developer-eligible across DB role drift', () => {
    expect(isGlobalDeveloperIdentity(owner, 'DEVELOPER', owner)).toBe(true);
    expect(isGlobalDeveloperIdentity(owner, 'ADMIN', owner)).toBe(true);
    expect(isGlobalDeveloperIdentity(owner, 'USER', owner)).toBe(true);
    expect(isGlobalDeveloperIdentity('223456789012345678', 'DEVELOPER', owner)).toBe(false);
    expect(isGlobalDeveloperIdentity(owner, 'DEVELOPER', '')).toBe(false);
  });

  it('limits bot-admin identity to privileged DB roles or canonical owner', () => {
    expect(isGlobalBotAdminIdentity(owner, 'USER', owner)).toBe(true);
    expect(isGlobalBotAdminIdentity('223456789012345678', 'ADMIN', owner)).toBe(true);
    expect(isGlobalBotAdminIdentity('223456789012345678', 'SUPER_ADMIN', owner)).toBe(true);
    expect(isGlobalBotAdminIdentity('223456789012345678', 'DEVELOPER', owner)).toBe(true);
    expect(isGlobalBotAdminIdentity('223456789012345678', 'USER', owner)).toBe(false);
  });
});
