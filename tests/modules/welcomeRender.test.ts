/**
 * Welcome-Renderer: Doppel-Tag-Fix.
 * {user} = Anzeigename (Klartext, KEIN Ping), {mention} = optionale Erwaehnung.
 * Der eigentliche Ping liegt separat im content -> kein doppeltes Tag.
 */
import { renderWelcomeMessage } from '../../src/modules/welcome/welcomeManager';

const VARS = { user: 'MaxMustermann', mention: '<@123>', guild: 'Mein Server', memberCount: 128 };

describe('renderWelcomeMessage', () => {
  it('{user} rendert als Klartext-Name ohne Mention', () => {
    const out = renderWelcomeMessage('Willkommen {user}!', VARS);
    expect(out).toBe('Willkommen MaxMustermann!');
    expect(out).not.toContain('<@');
  });

  it('{mention} rendert die Erwaehnung nur wenn explizit verwendet', () => {
    expect(renderWelcomeMessage('Hi {mention}', VARS)).toBe('Hi <@123>');
  });

  it('Standardtext mit {user}/{guild}/{count} erzeugt keinen Ping', () => {
    const out = renderWelcomeMessage('Willkommen {user} auf {guild}! Nr. {count}.', VARS);
    expect(out).toBe('Willkommen MaxMustermann auf Mein Server! Nr. 128.');
    expect(out).not.toMatch(/<@!?\d+>/);
  });

  it('{member_count} wird ebenfalls ersetzt', () => {
    expect(renderWelcomeMessage('{member_count} Mitglieder', VARS)).toBe('128 Mitglieder');
  });
});
