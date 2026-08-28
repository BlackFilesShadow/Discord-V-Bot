import fs from 'node:fs';
import path from 'node:path';

const ui = fs.readFileSync(path.join(__dirname, '..', '..', 'dashboard-ui/src/components/economy/VirtualAccountsControlPanel.tsx'), 'utf8');

describe('virtual account delete UI failure gate', () => {
  it('reports deletion success only from onSuccess and surfaces backend errors from onError', () => {
    expect(ui).toContain('const remove = useMutation({');
    expect(ui).toContain('onSuccess: result =>');
    expect(ui).toContain('onError: (error: Error) =>');
    expect(ui).toContain('setMessage({ ok: false, text: error.message })');
  });
});
