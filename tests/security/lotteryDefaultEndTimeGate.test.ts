import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'dashboard-ui/src/components/economy/LotteryPanel.tsx'), 'utf8');

describe('lottery default end-time gate', () => {
  it('rounds the default future time to minute precision before rendering datetime-local', () => {
    expect(source).toContain('function roundUpToMinute');
    expect(source).toContain('function defaultLotteryEndLocal');
    expect(source).toContain('roundUpToMinute(new Date(Date.now() + DEFAULT_END_DELAY_MS))');
  });
});
