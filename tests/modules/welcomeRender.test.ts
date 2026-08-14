/**
 * Welcome-Renderer und Versandlogik fuer eine zusammenhaengende Discord-
 * Components-V2-Nachricht. {user}/{mention} bleiben echte User-Erwaehnungen.
 */
import { ComponentType, MessageFlags } from 'discord.js';
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

  it('{user} bleibt auch dann eine echte Mention, wenn ein Call-Site versehentlich einen Anzeigenamen als user liefert', () => {
    expect(renderWelcomeMessage('Hey {user}, willkommen!', {
      user: 'Eclipse_King',
      mention: '<@12345678901234567>',
      guild: 'Mein Server',
      memberCount: 3,
    })).toBe('Hey <@12345678901234567>, willkommen!');
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

  it('teilt TextDisplay-Inhalt konservativ bei maximal 2000 Code-Units', () => {
    expect(MAX_WELCOME_CONTENT_LENGTH).toBe(2000);
  });

  it('zaehlt ein normales Emoji als ein sichtbares Zeichen', () => {
    expect(countWelcomeGraphemes('A🎉B')).toBe(3);
  });

  it('zaehlt ein verbundenes Familien-Emoji als ein Graphem', () => {
    expect(countWelcomeGraphemes('👨‍👩‍👧‍👦')).toBe(1);
  });

  it('laesst 2000 ASCII-Zeichen in einer Komponente', () => {
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

  it('teilt 4000 ASCII-Zeichen in exakt zwei TextDisplay-Komponenten', () => {
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
  const channel = {
    send: async (payload: unknown) => {
      payloads.push(payload);
      return { delete: async () => undefined };
    },
  };
  return { channel, payloads };
}

function serializedComponents(payload: unknown): Array<Record<string, unknown>> {
  const raw = (payload as { components?: unknown[] }).components ?? [];
  return raw.map(component => {
    if (component && typeof component === 'object' && 'toJSON' in component && typeof (component as { toJSON?: unknown }).toJSON === 'function') {
      return (component as { toJSON: () => Record<string, unknown> }).toJSON();
    }
    return component as Record<string, unknown>;
  });
}

describe('sendWelcomeMessages', () => {
  it('sendet ohne Medium genau EINE Components-V2-Nachricht mit gezieltem User-Ping', async () => {
    const { channel, payloads } = makeFakeChannel();
    await sendWelcomeMessages(channel as never, {
      text: 'Hallo <@12345678901234567>',
      mentionUserId: '12345678901234567',
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { users: ['12345678901234567'], parse: [] },
    });
    expect(payloads[0]).not.toHaveProperty('content');
    expect(payloads[0]).not.toHaveProperty('embeds');

    const components = serializedComponents(payloads[0]);
    expect(components).toHaveLength(1);
    expect(components[0]).toMatchObject({
      type: ComponentType.TextDisplay,
      content: 'Hallo <@12345678901234567>',
    });
  });

  it('image_first rendert Medium und Text in genau EINER Nachricht in dieser Reihenfolge', async () => {
    const { channel, payloads } = makeFakeChannel();
    await sendWelcomeMessages(channel as never, {
      text: 'Willkommen <@12345678901234567>',
      mediaUrl: 'https://example.com/welcome.png',
      mediaLayout: 'image_first',
      mentionUserId: '12345678901234567',
    });

    expect(payloads).toHaveLength(1);
    const components = serializedComponents(payloads[0]);
    expect(components.map(c => c.type)).toEqual([
      ComponentType.MediaGallery,
      ComponentType.TextDisplay,
    ]);
    expect(components[0]).toMatchObject({
      items: [{ media: { url: 'https://example.com/welcome.png' } }],
    });
    expect(components[1]).toMatchObject({ content: 'Willkommen <@12345678901234567>' });
  });

  it('text_first rendert Text und Medium in genau EINER Nachricht in dieser Reihenfolge', async () => {
    const { channel, payloads } = makeFakeChannel();
    await sendWelcomeMessages(channel as never, {
      text: 'Willkommen <@12345678901234567>',
      mediaUrl: 'https://example.com/welcome.png',
      mediaLayout: 'text_first',
      mentionUserId: '12345678901234567',
    });

    expect(payloads).toHaveLength(1);
    const components = serializedComponents(payloads[0]);
    expect(components.map(c => c.type)).toEqual([
      ComponentType.TextDisplay,
      ComponentType.MediaGallery,
    ]);
    expect(components[0]).toMatchObject({ content: 'Willkommen <@12345678901234567>' });
    expect(components[1]).toMatchObject({
      items: [{ media: { url: 'https://example.com/welcome.png' } }],
    });
  });

  it('sendet 4000 ASCII-Zeichen ohne Abschneiden als zwei TextDisplays in EINER Nachricht', async () => {
    const { channel, payloads } = makeFakeChannel();
    const input = 'a'.repeat(4000);
    await sendWelcomeMessages(channel as never, { text: input });

    expect(payloads).toHaveLength(1);
    const components = serializedComponents(payloads[0]);
    expect(components).toHaveLength(2);
    expect(components.every(c => c.type === ComponentType.TextDisplay)).toBe(true);
    const combined = components.map(c => String(c.content ?? '')).join('');
    expect(combined).toBe(input);
    expect(components.every(c => String(c.content ?? '').length <= 2000)).toBe(true);
  });
});
