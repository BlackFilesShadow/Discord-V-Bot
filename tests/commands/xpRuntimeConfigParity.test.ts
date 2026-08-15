import fs from 'node:fs';
import path from 'node:path';

function read(rel: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');
}

describe('XP runtime config parity', () => {
  const message = read('src/events/messageCreate.ts');
  const voice = read('src/events/voiceStateUpdate.ts');

  it('behandelt 0 bei Message-XP, Cooldown und Multiplikator als echten konfigurierten Wert', () => {
    expect(message).toContain('xpConfig?.xpCooldownSeconds ?? 60');
    expect(message).toContain('xpConfig?.messageXpMin ?? 15');
    expect(message).toContain('xpConfig?.messageXpMax ?? 25');
    expect(message).toContain('xpConfig?.levelMultiplier ?? 1.0');
    expect(message).not.toContain('xpConfig?.xpCooldownSeconds || 60');
    expect(message).not.toContain('xpConfig?.messageXpMin || 15');
    expect(message).not.toContain('xpConfig?.messageXpMax || 25');
    expect(message).not.toContain('xpConfig?.levelMultiplier || 1.0');
  });

  it('verwendet dieselbe nullish-Semantik im Voice-XP-Pfad', () => {
    expect(voice).toContain('xpConfig?.xpCooldownSeconds ?? 60');
    expect(voice).toContain('xpConfig?.voiceXpPerMinute ?? 2');
    expect(voice).toContain('xpConfig?.levelMultiplier ?? 1.0');
  });
});
