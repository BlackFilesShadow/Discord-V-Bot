/**
 * Welcome-Renderer:
 * {user} ist der lesbare Server-Anzeigename, {mention} bleibt die explizite
 * Discord-Erwaehnung. Dadurch erscheinen im Embed keine rohen User-IDs, wenn
 * die Welcome-Nachricht den empfohlenen {user}-Platzhalter verwendet.
 */
import { renderWelcomeMessage } from '../../src/modules/welcome/welcomeManager';

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
