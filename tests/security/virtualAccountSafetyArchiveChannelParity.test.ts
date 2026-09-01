import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('virtual-account safety route archive-channel parity', () => {
  const safety = read('src/dashboard/routes/v2/economyVirtualAccountTreasurySafety.ts');
  const v2 = read('src/dashboard/routes/v2.ts');

  it('keeps the authoritative safety router ahead of the general control router', () => {
    expect(v2.indexOf('economyVirtualAccountTreasurySafetyRouter'))
      .toBeLessThan(v2.indexOf('economyVirtualAccountControlRouter'));
  });

  it('validates live and archive channels together on the shadowing create/update handlers', () => {
    expect(safety).toContain('async function validateAccountChannels(');
    expect(safety).toContain('validateNormalTextChannel(guildId, body.channelId)');
    expect(safety).toContain('validateNormalTextChannel(guildId, body.archiveChannelId)');
    expect(safety).toContain("if (channelId && !archiveChannelId) throw new Error('Fuer eine Discord-Integration ist ein separater Archiv-Kanal erforderlich.')");
    expect(safety).toContain("if (channelId && archiveChannelId && channelId === archiveChannelId)");
  });

  it('forwards and returns archiveChannelId instead of silently dropping the selected archive channel', () => {
    expect(safety).toContain('archiveChannelId: metadata?.archiveChannelId ?? null');
    expect((safety.match(/const \{ channelId, archiveChannelId \} = await validateAccountChannels/g) ?? []).length).toBe(2);
    expect((safety.match(/\n\s+archiveChannelId,\n/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
