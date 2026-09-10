import { feedConfigurationAction } from '../../src/modules/feeds/feedConfigurationPolicy';

describe('feedConfigurationAction', () => {
  it('deaktiviert einen wiederholt unerreichbaren Discord-Ziel-Channel erst nach drei Fehlern', () => {
    const error = new Error('Ziel-Channel ist nicht erreichbar.');
    expect(feedConfigurationAction(error, 1)).toBe('BACKOFF');
    expect(feedConfigurationAction(error, 2)).toBe('BACKOFF');
    expect(feedConfigurationAction(error, 3)).toBe('AUTO_DISABLE');
    expect(feedConfigurationAction(error, 8)).toBe('AUTO_DISABLE');
  });

  it('fasst Twitch-Credentialfehler niemals automatisch an', () => {
    const error = new Error('Twitch-Credentials fehlen');
    expect(feedConfigurationAction(error, 1)).toBe('BACKOFF');
    expect(feedConfigurationAction(error, 100)).toBe('BACKOFF');
  });

  it('laesst sonstige Fehler im normalen Backoff', () => {
    expect(feedConfigurationAction(new Error('temporärer Netzwerkfehler'), 100)).toBe('BACKOFF');
    expect(feedConfigurationAction(new Error('Gespeicherte Twitch-Quelle ist ungültig.'), 100)).toBe('BACKOFF');
  });
});
