import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('Lottery dashboard start regression', () => {
  const ui = read('dashboard-ui/src/components/economy/LotteryPanel.tsx');
  const e2e = read('dashboard-ui/e2e/lottery-authenticated-actions.spec.ts');

  it('provides a safe default end time instead of leaving an invisible invalid form', () => {
    expect(ui).toContain('defaultLotteryEndLocal');
    expect(ui).toContain("endsAt: defaultLotteryEndLocal()");
    expect(ui).toContain('roundUpToMinute');
  });

  it('keeps backend-equivalent 1-minute/30-day bounds and exposes the reason in the UI', () => {
    expect(ui).toContain('MIN_END_DELAY_MS = 60_000');
    expect(ui).toContain('MAX_END_DELAY_MS = 30 * 24 * 60 * 60 * 1000');
    expect(ui).toContain('formValidation');
    expect(ui).toContain('{formValidation && <p');
    expect(ui).toContain('Endzeit muss mindestens 1 Minute in der Zukunft liegen.');
    expect(ui).toContain('Endzeit darf maximal 30 Tage in der Zukunft liegen.');
  });

  it('retains the authenticated Playwright create/end contract', () => {
    expect(e2e).toContain("test('economy.manage erstellt und beendet eine Runde");
    expect(e2e).toContain("getByRole('button', { name: 'Lotterie starten', exact: true })");
    expect(e2e).toContain("mutationOf(state, 'create')");
    expect(e2e).toContain("mutationOf(state, 'end')");
  });
});
