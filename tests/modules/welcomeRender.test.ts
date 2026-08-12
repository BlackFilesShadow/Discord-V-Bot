/**
 * Welcome-Renderer:
 * {user} ist der lesbare Server-Anzeigename, {mention} bleibt die explizite
 * Discord-Erwaehnung. Zusaetzlich werden die sichtbare Zeichenzahl und die
 * finale Discord-Embed-Grenze abgesichert.
 */
import {
  assertWelcomeEmbedLength,
  countWelcomeGraphemes,
  MAX_WELCOME_EMBED_LENGTH,
  MAX_WELCOME_TEMPLATE_GRAPHEMES,
  renderWelcomeMessage,
} from '../../src/modules/welcome/welcomeManager';

const VARS = { user: 'Void_Architect', mention: '<@123>', guild: 'Mein Server', memberCount: 128 };

describe('renderWelcomeMessage', () => {
  it('{user} rendert den lesbaren Server-Anzeigenamen', () => {
    expect(renderWelcomeMessage('Willkommen {user}!', VARS)).toBe('Willkommen Void_Architect!');
  });

  it('{mention} bleibt die explizite Discord-Erwaehnung', () => {
    expect(renderWelcomeMessage('Hi {mention}', VARS)).toBe('Hi <@123>');
  });

  it('Standardtext ersetzt {user}/{guild}/{count}', () => {
    expect(renderWelcomeMessage('Willkommen {user} auf {guild}! Nr. {count}.', VARS))
      .toBe('Willkommen Void_Architect auf Mein Server! Nr. 128.');
  });

  it('{member_count} wird ebenfalls ersetzt', () => {
    expect(renderWelcomeMessage('{member_count} Mitglieder', VARS)).toBe('128 Mitglieder');
  });
});

describe('welcome length limits', () => {
  it('setzt das Template-Limit auf 4000 sichtbare Zeichen', () => {
    expect(MAX_WELCOME_TEMPLATE_GRAPHEMES).toBe(4000);
  });

  it('zaehlt ein normales Emoji als ein sichtbares Zeichen', () => {
    expect(countWelcomeGraphemes('A🎉B')).toBe(3);
  });

  it('zaehlt ein verbundenes Familien-Emoji als ein Graphem', () => {
    expect(countWelcomeGraphemes('👨‍👩‍👧‍👦')).toBe(1);
  });

  it('akzeptiert eine finale Embed-Beschreibung exakt am Discord-Limit', () => {
    expect(() => assertWelcomeEmbedLength('a'.repeat(MAX_WELCOME_EMBED_LENGTH))).not.toThrow();
  });

  it('lehnt eine finale Embed-Beschreibung oberhalb des Discord-Limits ab', () => {
    expect(() => assertWelcomeEmbedLength('a'.repeat(MAX_WELCOME_EMBED_LENGTH + 1)))
      .toThrow(/zu lang/i);
  });
});
