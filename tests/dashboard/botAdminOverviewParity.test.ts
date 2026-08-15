import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(
  path.resolve(process.cwd(), 'src/dashboard/routes/v2/botAdminCommandCenter.ts'),
  'utf8',
);

describe('Bot-Admin overview monitor parity', () => {
  it('prueft Storage nur konstant auf Existenz und Schreibbarkeit', () => {
    expect(source).toContain("botAdminCommandCenterRouter.get('/overview'");
    expect(source).toContain('await fs.access(config.upload.dir)');
    expect(source).toContain('await fs.access(config.upload.dir, 2)');
    expect(source).toContain('const uploadDir = { exists: false, writable: false }');
  });

  it('traversiert den Upload-Baum nicht rekursiv bei jedem Status-Read', () => {
    expect(source).not.toContain('fs.readdir(');
    expect(source).not.toContain('fs.stat(');
    expect(source).not.toContain("import path from 'node:path'");
    expect(source).not.toContain('uploadDir.bytes');
  });

  it('liefert nur verifizierte Text-/Announcement-Channels fuer die Guild-Feedback-Auswahl', () => {
    expect(source).toContain('channelOptions = guild.channels.cache');
    expect(source).toContain('channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement');
    expect(source).toContain('channelOptions,');
  });
});
