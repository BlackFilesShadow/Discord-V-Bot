import fs from 'node:fs';
import path from 'node:path';

describe('AI provider runtime lifecycle architecture gate', () => {
  it('startet und stoppt die persistente Provider-Cooldown-Synchronisierung symmetrisch', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/modules/ai/runtime.ts'), 'utf8');
    expect(source).toContain("scheduleProviderCooldownSync, stopProviderCooldownSync");
    expect(source).toContain('await scheduleProviderCooldownSync();');
    expect(source).toContain('stopProviderCooldownSync();');
    expect(source.indexOf('await scheduleProviderCooldownSync();')).toBeLessThan(source.indexOf('bootstrapGuildAwareness(client)'));
  });
});
