import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'dashboard-ui/src/components/economy/VirtualAccountsControlPanel.tsx'), 'utf8');

describe('virtual-account archive channel UI gate', () => {
  it('blocks same-channel configuration and requires archive selection for live integration', () => {
    expect(source).toContain("if (draft.channelId && !draft.archiveChannelId)");
    expect(source).toContain("if (draft.channelId && draft.archiveChannelId && draft.channelId === draft.archiveChannelId)");
    expect(source).toContain('channels.filter(channel => channel.id !== draft.channelId)');
  });
});
