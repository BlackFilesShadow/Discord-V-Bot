process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

import { buildStructuredGoodbyeEmbed, type GoodbyeCleanupSnapshot } from '../../src/modules/welcome/goodbyeStatus';

const leftAt = new Date('2026-08-24T10:15:30.000Z');
const DISCORD_ID = 'discord-test-user';

function embed(snapshot: GoodbyeCleanupSnapshot | null, cleanupEnabled = true, customMessage = 'Auf Wiedersehen!') {
  return buildStructuredGoodbyeEmbed({
    discordId: DISCORD_ID,
    discordName: 'DiscordNick',
    customMessage,
    leaveOccurredAt: leftAt,
    cleanupEnabled,
    cleanupSnapshot: snapshot,
  }).toJSON();
}

describe('structured Goodbye status embed', () => {
  it('always uses the fixed leave timestamp and mandatory identity/status/date/time fields', () => {
    const json = embed(null, false);
    expect(json.timestamp).toBe(leftAt.toISOString());
    expect(json.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Discord-Name', value: `<@${DISCORD_ID}>` }),
      expect.objectContaining({ name: 'Status', value: 'Server verlassen' }),
      expect.objectContaining({ name: 'Datum' }),
      expect.objectContaining({ name: 'Uhrzeit', value: expect.stringContaining('Europe/Berlin') }),
    ]));
    expect(json.fields?.some(field => field.name.includes('Whitelist'))).toBe(false);
  });

  it('keeps the Discord mention exclusively in the Discord-Name field even when the template contains it', () => {
    const json = embed(null, false, `<@${DISCORD_ID}>\nWir sehen uns!`);
    expect(json.description).toBe('Wir sehen uns!');
    expect(json.fields?.find(field => field.name === 'Discord-Name')?.value).toBe(`<@${DISCORD_ID}>`);
    expect(json.description).not.toContain(DISCORD_ID);
  });

  it.each([
    ['PENDING', 0xeab308, 'Wartet'],
    ['RUNNING', 0xeab308, 'läuft'],
    ['RETRY', 0xf97316, 'Erneuter Versuch'],
    ['CONFIRMED', 0x16a34a, 'remote bestätigt'],
    ['FAILED', 0xdc2626, 'endgültig fehlgeschlagen'],
    ['NOT_LINKED', 0x6b7280, 'Nicht eindeutig'],
  ] as const)('maps %s truthfully to color and wording', (state, color, wording) => {
    const json = embed({ servers: [{
      nitradoConnId: 'conn-1', serverAlias: 'Server 1', playerNames: state === 'NOT_LINKED' ? [] : ['PlayerOne'], state,
      ...(state === 'CONFIRMED' ? { confirmedAt: '2026-08-24T10:16:30.000Z' } : {}),
    }] });
    expect(json.color).toBe(color);
    expect(json.fields?.find(field => field.name.includes('Whitelist'))?.value).toContain(wording);
    expect(json.timestamp).toBe(leftAt.toISOString());
  });

  it('shows separate multi-server outcomes and never paints partial success green', () => {
    const json = embed({ servers: [
      { nitradoConnId: 'a', serverAlias: 'Server A', playerNames: ['Player'], state: 'CONFIRMED', confirmedAt: '2026-08-24T10:16:30.000Z' },
      { nitradoConnId: 'b', serverAlias: 'Server B', playerNames: ['Player'], state: 'FAILED', error: 'Remote-Fehler' },
    ] });
    const status = json.fields?.find(field => field.name.includes('Whitelist'))?.value ?? '';
    expect(json.color).toBe(0xdc2626);
    expect(status).toContain('Server A');
    expect(status).toContain('Server B');
    expect(status).toContain('Remote-Fehler');
  });
});
