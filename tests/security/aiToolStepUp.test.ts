import { AiToolStepUpService, type AiToolStepUpBinding } from '../../src/security/aiToolStepUp';

const secret = '0123456789abcdef0123456789abcdef-strong-step-up-secret';
const baseBinding: AiToolStepUpBinding = {
  actorDiscordId: '234567890123456789',
  guildId: '123456789012345678',
  nitradoConnId: 'c123456789012345678901234',
  toolName: 'nitrado.restart',
  argumentsDigest: 'a'.repeat(64),
};

describe('AI-18 one-shot step-up grants', () => {
  test('valid grant is exact-scope bound and can be consumed only once', () => {
    let now = 1_800_000_000_000;
    const service = new AiToolStepUpService(secret, () => now);
    const token = service.issue({
      binding: baseBinding,
      confirmedByUser: true,
      source: 'DISCORD_INTERACTION',
      ttlMs: 60_000,
    });

    expect(service.verifyAndConsume(token, baseBinding)).toBe(true);
    expect(service.verifyAndConsume(token, baseBinding)).toBe(false);
    now += 1;
  });

  test.each([
    ['actor', { actorDiscordId: '345678901234567890' }],
    ['guild', { guildId: '456789012345678901' }],
    ['gameserver', { nitradoConnId: 'c987654321098765432109876' }],
    ['tool', { toolName: 'nitrado.stop' }],
    ['arguments', { argumentsDigest: 'b'.repeat(64) }],
  ])('rejects %s mismatch without consuming the original grant', (_label, override) => {
    const service = new AiToolStepUpService(secret, () => 1_800_000_000_000);
    const token = service.issue({ binding: baseBinding, confirmedByUser: true, source: 'DASHBOARD_REAUTH' });
    expect(service.verifyAndConsume(token, { ...baseBinding, ...override })).toBe(false);
    expect(service.verifyAndConsume(token, baseBinding)).toBe(true);
  });

  test('expired grant is rejected', () => {
    let now = 1_800_000_000_000;
    const service = new AiToolStepUpService(secret, () => now);
    const token = service.issue({ binding: baseBinding, confirmedByUser: true, source: 'WEBAUTHN', ttlMs: 1_000 });
    now += 1_001;
    expect(service.verifyAndConsume(token, baseBinding)).toBe(false);
  });

  test('tampering with token body or signature is rejected', () => {
    const service = new AiToolStepUpService(secret, () => 1_800_000_000_000);
    const token = service.issue({ binding: baseBinding, confirmedByUser: true, source: 'DISCORD_INTERACTION' });
    const [body, signature] = token.split('.');
    const replacement = signature.endsWith('A') ? 'B' : 'A';
    const tamperedSignature = `${signature.slice(0, -1)}${replacement}`;

    expect(service.verifyAndConsume(`${body}A.${signature}`, baseBinding)).toBe(false);
    expect(service.verifyAndConsume(`${body}.${tamperedSignature}`, baseBinding)).toBe(false);
    expect(service.verifyAndConsume(token, baseBinding)).toBe(true);
  });

  test('rejects weak server secret and invalid binding', () => {
    expect(() => new AiToolStepUpService('short')).toThrow(/32 bytes/);
    const service = new AiToolStepUpService(secret);
    expect(() => service.issue({
      binding: { ...baseBinding, guildId: 'not-a-guild' },
      confirmedByUser: true,
      source: 'DISCORD_INTERACTION',
    })).toThrow(/Invalid AI tool step-up binding/);
  });
});
