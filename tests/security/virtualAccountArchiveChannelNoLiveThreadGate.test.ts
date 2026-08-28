import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src/modules/economy/virtualAccountDiscord.ts'), 'utf8');

describe('virtual account live-channel thread gate', () => {
  it('never creates the transaction archive from the live channel object', () => {
    expect(source).toContain('archiveChannel.threads.create({');
    expect(source).not.toContain('const thread = await channel.threads.create({');
  });
});
