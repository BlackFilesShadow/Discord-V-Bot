import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'dashboard-ui/src/components/economy/LotteryPanel.tsx'), 'utf8');

describe('lottery start button reason gate', () => {
  it('uses the same validation value for button disablement and visible feedback', () => {
    expect(source).toContain('Boolean(formValidation)');
    expect(source).toContain('{formValidation &&');
  });
});
