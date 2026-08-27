process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

import { buildStructuredGoodbyeEmbed, type GoodbyeCleanupSnapshot } from '../../src/modules/welcome/goodbyeStatus';

const joinedAt = new Date('2026-01-10T08:00:00.000Z');
const leftAt = new Date('2026-08-24T10:15:30.000Z');

function embed(snapshot: GoodbyeCleanupSnapshot | null, cleanupEnabled = true) {
  return buildStructuredGoodbyeEmbed({
    discordName: 'DiscordNick',
    customMessage: 'Auf Wiedersehen!',
    joinedAt,
    leaveOccurredAt: leftAt,
    cleanupEnabled,
    cleanupSnapshot: snapshot,
  }).toJSON();
}

describe('structured Goodbye status embed', () => {
  it('renders one stable non-inline member block instead of the old shifted 3+2 field grid', () => {
    const json = embed(null, false);
    expect(json.timestamp).toBe(leftAt.toISOString());
    expect(json.fields).toHaveLength(1);
    expect(json.fields?.[0]).toMatchObject({ name: '👤 Mitglied', inline: false });
    expect(json.fields?.[0].value).toContain('**Discord:** DiscordNick');
    expect(json.fields?.[0].value).toContain('**Status:** Server verlassen');
    expect(json.fields?.[0].value).toContain('**Beigetreten:** 10. Januar 2026');
    expect(json.fields?.[0].value).toContain('**Ausgetreten:** 24. August 2026');
    expect(json.fields?.some(field => field.name.includes('Whitelist'))).toBe(false);
  });

  it('renders unknown join date fail-closed instead of inventing one', () => {
    const json = buildStructuredGoodbyeEmbed({
      discordName: 'DiscordNick',
      customMessage: '',
      joinedAt: null,
      leaveOccurredAt: leftAt,
      cleanupEnabled: false,
      cleanupSnapshot: null,
    }).toJSON();
    expect(json.fields?.[0].value).toContain('**Beigetreten:** Unbekannt');
  });

  it('renders a native mention only after the Discord user was explicitly resolved', () => {
    const snowflake = '4'.repeat(18);
    const unresolved = buildStructuredGoodbyeEmbed({
      discordName: 'DiscordNick',
      discordMention: `<@${snowflake}>`,
      discordMentionResolved: false,
      customMessage: '',
      joinedAt,
      leaveOccurredAt: leftAt,
      cleanupEnabled: false,
      cleanupSnapshot: null,
    }).toJSON();
    expect(unresolved.fields?.[0].value).toContain('**Discord:** DiscordNick');
    expect(JSON.stringify(unresolved)).not.toContain(snowflake);

    const resolved = buildStructuredGoodbyeEmbed({
      discordName: 'DiscordNick',
      discordMention: `<@${snowflake}>`,
      discordMentionResolved: true,
      customMessage: '',
      joinedAt,
      leaveOccurredAt: leftAt,
      cleanupEnabled: false,
      cleanupSnapshot: null,
    }).toJSON();
    expect(resolved.fields?.[0].value).toContain(`**Discord:** <@${snowflake}>`);
  });

  it('scrubs raw Discord snowflakes from every visible non-mention surface', () => {
    const snowflake = '5'.repeat(18);
    const json = buildStructuredGoodbyeEmbed({
      discordName: snowflake,
      discordMention: `<@${snowflake}>`,
      discordMentionResolved: false,
      customMessage: `Bye ${snowflake} und <@${snowflake}>`,
      joinedAt,
      leaveOccurredAt: leftAt,
      cleanupEnabled: true,
      cleanupSnapshot: {
        servers: [{
          nitradoConnId: 'conn-1',
          serverAlias: snowflake,
          playerNames: [snowflake],
          state: 'FAILED',
          error: `Fehler fuer ${snowflake}`,
        }],
      },
    }).toJSON();

    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain(snowflake);
    expect(serialized).toContain('Discord-Nutzer');
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
