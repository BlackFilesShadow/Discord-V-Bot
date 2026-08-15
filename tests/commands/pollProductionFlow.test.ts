import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'commands', 'user', 'poll.ts'), 'utf8');

describe('manual poll production flow', () => {
  it('verwendet fuer manuelles Beenden die atomare endPoll-Finalisierung mit Callback', () => {
    expect(source).toContain('await endPoll(pollId, interaction.guildId, async result => {');
    expect(source).not.toContain("data: { status: 'ENDED'");
  });

  it('leakt im globalen Poll-Fehlerweg keine interne Exception-Nachricht an Nutzer', () => {
    expect(source).toContain('Ein interner Fehler ist aufgetreten. Bitte versuche es erneut.');
    expect(source).not.toContain('setDescription(`❌ ${error');
    expect(source).not.toContain('setDescription(error.message');
  });

  it('behandelt den optionalen Rollen-Ping als best effort statt den Abschluss zurueckzurollen', () => {
    const start = source.indexOf('if (poll.notifyRoleId');
    expect(start).toBeGreaterThan(-1);
    const block = source.slice(start, source.indexOf('if (poll.messageId', start));
    expect(block).toContain('logger.warn');
    expect(block).not.toContain('throw new Error');
  });
});
