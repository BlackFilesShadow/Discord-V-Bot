import fs from 'node:fs';
import path from 'node:path';

const ui = fs.readFileSync(path.join(__dirname, '..', '..', 'dashboard-ui/src/components/economy/LotteryPanel.tsx'), 'utf8');

describe('lottery visible validation gate', () => {
  it('never leaves the start button disabled without rendering a reason', () => {
    expect(ui).toContain('const formValidation =');
    expect(ui).toContain('disabled={create.isPending || current.isError || history.isError || channels.isLoading || channels.isError || Boolean(formValidation)}');
    expect(ui).toContain('{formValidation && <p');
  });
});
