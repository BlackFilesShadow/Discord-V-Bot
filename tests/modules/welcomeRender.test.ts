/**
 * Welcome-Renderer und Versandlogik fuer normale Discord-Nachrichten.
 * {user} und {mention} sind echte Discord-Erwaehnungen im Nachrichtentext.
 */
import {
  countWelcomeGraphemes,
  MAX_WELCOME_CONTENT_LENGTH,
  MAX_WELCOME_TEMPLATE_GRAPHEMES,
  renderWelcomeMessage,
  sendWelcomeMessages,
  splitWelcomeContent,
} from '../../src/modules/welcome/welcomeManager';

const VARS = { user: '<@12345678901234567>', mention: '<@12345678901234567>', guild: 'Mein Server', memberCount: 128 };

describe('renderWelcomeMessage', () => {
  it('{user} rendert die Discord-Erwaehnung im normalen Nachrichtentext', () => {
    expect(renderWelcomeMessage('Willkommen {user}!', VARS)).toBe('Willkommen <@12345678901234567>!');
  });

  it('{mention} bleibt Alias fuer die Discord-Erwaehnung', () => {
    expect(renderWelcomeMessage('Hi {mention}', VARS)).toBe('Hi <@12345678901234567>');
  });

  it('Standardtext ersetzt {user}/{guild}/{count}', () => {
    expect(renderWelcomeMessage('Willkommen {user} auf {guild}! Nr. {count}.', VARS))
      .toBe('Willkommen <@12345678901234567> auf Mein Server! Nr. 128.');
  });

  it('{member_count} wird ebenfalls ersetzt', () => {
    expect(renderWelcomeMessage('{member_count} Mitglieder', VARS)).toBe('128 Mitglieder');
  });
});

describe('welcome length limits and safe splitting', () => {
  it('setzt das Template-Limit auf 4000 sichtbare Zeichen', () => {
    expect(MAX_WELCOME_TEMPLATE_GRAPHEMES).toBe(4000);
  });

  it('setzt normale Discord-Teile auf maximal 2000 Code-Units', () => {
    expect(MAX_WELCOME_CONTENT_LENGTH).toBe(2000);
  });

  it('zaehlt ein normales Emoji als ein sichtbares Zeichen', () => {
    expect(countWelcomeGraphemes('A🎉B')).toBe(3);
  });

  it('zaehlt ein verbundenes Familien-Emoji als ein Graphem', () => {
    expect(countWelcomeGraphemes('👨‍👩‍👧‍👦')).toBe(1);
  });

  it('laesst 2000 ASCII-Zeichen in einer Nachricht', () => {
    const chunks = splitWelcomeContent('a'.repeat(2000));
    expect(chunks).toEqual(['a'.repeat(2000)]);
  });

  it('teilt 2001 ASCII-Zeichen ohne Verlust', () => {
    const input = 'a'.repeat(2001);
    const chunks = splitWelcomeContent(input);
    expect(chunks.length).toBe(2);
    expect(chunks.every(c => c.length <= 2000)).toBe(true);
    expect(chunks.join('')).toBe(input);
  });

  it('teilt 4000 ASCII-Zeichen in exakt zwei Discord-Nachrichten', () => {
    const input = 'a'.repeat(4000);
    const chunks = splitWelcomeContent(input);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(2000);
    expect(chunks[1]).toHaveLength(2000);
    expect(chunks.join('')).toBe(input);
  });

  it('trennt ein Emoji nicht in der Mitte', () => {
    const input = `${'a'.repeat(1999)}🎉b`;
    const chunks = splitWelcomeContent(input);
    expect(chunks.join('')).toBe(input);
    expect(chunks.every(c => c.length <= 2000)).toBe(true);
    expect(chunks.some(c => c.includes('🎉'))).toBe(true);
  });

  it('trennt eine Discord-Erwaehnung nicht in der Mitte', () => {
    const mention = '<@12345678901234567>';
    const input = `${'a'.repeat(1990)} ${mention} Ende`;
    const chunks = splitWelcomeContent(input);
    expect(chunks.join('')).toBe(input);
    expect(chunks.some(c => c.includes(mention))).toBe(true);
    expect(chunks.filter(c => c.includes('<@')).every(c => c.includes(mention))).toBe(true);
  });

  it('trennt ein Custom-Emoji-Tag nicht in der Mitte', () => {
    const emoji = '<:party_blob:12345678901234567>';
    const input = `${'a'.repeat(1985)} ${emoji} Ende`;
    const chunks = splitWelcomeContent(input);
    expect(chunks.join('')).toBe(input);
    expect(chunks.some(c => c.includes(emoji))).toBe(true);
  });
});

function makeFakeChannel() {
  const payloads: unknown[] = [];
  const deleted: number[] = [];
  const channel = {
    send: async (payload: unknown) => {
      const index = payloads.push(payload) - 1;
      return {
        delete: async () => { deleted.push(index); },
      };
    },
  };
  return { channel, payloads, deleted };
}

describe('sendWelcomeMessages', () => {
  it('sendet ohne Medium nur normalen Content mit gezielt erlaubtem User-Ping', async () => {
    const { channel, payloads } = makeFakeChannel();
    await sendWelcomeMessages(channel as never, {
      text: 'Hallo <@12345678901234567>',
      mentionUserId: '12345678901234567',
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      content: 'Hallo <@12345678901234567>',
      allowedMentions: { users: ['12345678901234567'], parse: [] },
    });
    expect(payloads[0]).not.toHaveProperty('embeds');
  });

  it('sendet image_first wirklich vor dem Text', async () => {
    const { channel, payloads } = makeFakeChannel();
    await sendWelcomeMessages(channel as never, {
      text: 'Willkommen <@12345678901234567>',
      mediaUrl: 'https://example.com/welcome.png',
      mediaLayout: 'image_first',
      mentionUserId: '12345678901234567',
    });

    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toMatchObject({ content: 'https://example.com/welcome.png' });
    expect(payloads[1]).toMatchObject({ content: 'Willkommen <@12345678901234567>' });
  });

  it('sendet text_first wirklich vor dem Medium', async () => {
    const { channel, payloads } = makeFakeChannel();
    await sendWelcomeMessages(channel as never, {
      text: 'Willkommen <@12345678901234567>',
      mediaUrl: 'https://example.com/welcome.png',
      mediaLayout: 'text_first',
      mentionUserId: '12345678901234567',
    });

    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toMatchObject({ content: 'Willkommen <@12345678901234567>' });
    expect(payloads[1]).toMatchObject({ content: 'https://example.com/welcome.png' });
  });

  it('sendet 4000 ASCII-Zeichen ohne stilles Abschneiden in zwei Teilen', async () => {
    const { channel, payloads } = makeFakeChannel();
    const input = 'a'.repeat(4000);
    await sendWelcomeMessages(channel as never, { text: input });

    expect(payloads).toHaveLength(2);
    const combined = payloads.map(p => (p as { content: string }).content).join('');
    expect(combined).toBe(input);
    expect(payloads.every(p => (p as { content: string }).content.length <= 2000)).toBe(true);
  });
});
