import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src/modules/economy/virtualAccountDiscord.ts'), 'utf8');

describe('virtual account archive thread parent gate', () => {
  it('creates and validates transaction threads against archiveChannel, not the live channel', () => {
    expect(source).toContain('archiveChannel.threads.create({');
    expect(source).toContain('existingThread.parentId !== archiveChannel.id');
    expect(source).toContain('metadata.archiveChannelId');
  });
});
