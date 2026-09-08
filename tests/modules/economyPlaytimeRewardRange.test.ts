import fs from 'node:fs';
import path from 'node:path';

const read = (relative: string): string => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');

describe('playtime reward range parity', () => {
  const backend = read('src/dashboard/routes/v2/economy.ts');
  const dashboard = read('dashboard-ui/src/pages/ServerSlotV3.tsx');

  test('uses the same safe 10^15 ceiling in canonical backend and V3 dashboard', () => {
    const max = 1_000_000_000_000_000;
    expect(max).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
    expect(backend).toContain('const PLAYTIME_REWARD_MAX = 1_000_000_000_000_000;');
    expect(backend).toContain('requestedPlaytime > PLAYTIME_REWARD_MAX');
    expect(backend).toContain('rule.baseAmount > BigInt(PLAYTIME_REWARD_MAX)');
    expect(dashboard).toContain('const MAX_REWARD = 1_000_000_000_000_000n;');
    expect(dashboard).toContain('const MAX_REWARD_NUMBER = Number(MAX_REWARD);');
    expect(dashboard).toContain('draft.playtimeRewardPer10Min <= MAX_REWARD_NUMBER');
    expect(dashboard).toContain('max={MAX_REWARD_NUMBER} value={draft.playtimeRewardPer10Min}');
    expect(dashboard).toContain('Math.min(MAX_REWARD_NUMBER, Math.trunc(Number(e.target.value) || 0))');
  });

  test('does not accidentally widen the independent start-balance limit', () => {
    expect(backend).toContain('b.startBalance <= 1_000_000_000');
    expect(dashboard).toContain('max={1_000_000_000} value={draft.startBalance}');
    expect(dashboard).toContain('Math.min(1_000_000_000, Math.trunc(Number(e.target.value) || 0))');
  });
});
