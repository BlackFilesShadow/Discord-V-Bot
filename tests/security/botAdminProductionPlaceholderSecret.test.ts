import { collectProductionEnvErrors, type EnvLike } from '../../src/utils/envValidation';

const OWNER_ID = '12345678901234567';
const PUBLIC_BOT_ADMIN_PLACEHOLDER = 'change_me_to_a_different_long_random_secret';

function baseEnv(overrides: EnvLike = {}): EnvLike {
  return {
    NODE_ENV: 'production',
    BOT_OWNER_ID: OWNER_ID,
    ...overrides,
  };
}

describe('Bot-Admin production placeholder secret guard', () => {
  it('rejects the public .env.example Bot Admin placeholder', () => {
    const errors = collectProductionEnvErrors(baseEnv({
      BOT_ADMIN_PASSWORD: PUBLIC_BOT_ADMIN_PLACEHOLDER,
    }));

    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining('BOT_ADMIN_PASSWORD'),
    ]));
    expect(errors.some(error => error.includes(PUBLIC_BOT_ADMIN_PLACEHOLDER))).toBe(true);
  });

  it('does not reject a non-placeholder Bot Admin password', () => {
    const errors = collectProductionEnvErrors(baseEnv({
      BOT_ADMIN_PASSWORD: 'unit-test-only-random-bot-admin-secret-7fc9fcd4',
    }));

    expect(errors).toEqual([]);
  });

  it('keeps missing BOT_ADMIN_PASSWORD out of the startup-fatal contract', () => {
    const errors = collectProductionEnvErrors(baseEnv());

    expect(errors).toEqual([]);
  });
});
