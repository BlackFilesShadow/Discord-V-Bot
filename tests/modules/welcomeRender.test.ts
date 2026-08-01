/**
 * Welcome-Renderer: die User-Markierung steht IM Text ({user}/{mention}),
 * es gibt keinen separaten Ping/kein bares Tag ueber dem Embed.
 */
import { renderWelcomeMessage } from '../../src/modules/welcome/welcomeManager';

const VARS = { user: '<@123>', mention: '<@123>', guild: 'Mein Server', memberCount: 128 };

describe('renderWelcomeMessage', () => {
  it('{user} rendert die Erwaehnung im Text', () => {
    expect(renderWelcomeMessage('Willkommen {user}!', VARS)).toBe('Willkommen <@123>!');
  });

  it('{mention} ist Alias fuer die Erwaehnung', () => {
    expect(renderWelcomeMessage('Hi {mention}', VARS)).toBe('Hi <@123>');
  });

  it('Standardtext ersetzt {user}/{guild}/{count}', () => {
    expect(renderWelcomeMessage('Willkommen {user} auf {guild}! Nr. {count}.', VARS))
      .toBe('Willkommen <@123> auf Mein Server! Nr. 128.');
  });

  it('{member_count} wird ebenfalls ersetzt', () => {
    expect(renderWelcomeMessage('{member_count} Mitglieder', VARS)).toBe('128 Mitglieder');
  });
});
