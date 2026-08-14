import { hashBanIdentifier, matchesBanIdentifier } from '../../src/modules/bans/banTarget';

const SECRET = '0'.repeat(64);

describe('direct server-ban identifier', () => {
  it('erzeugt ohne Discord-Link einen stabilen HMAC und kann denselben Identifier wiederfinden', () => {
    const hash = hashBanIdentifier('Player-123', SECRET);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(matchesBanIdentifier('Player-123', hash, SECRET)).toBe(true);
    expect(matchesBanIdentifier('Other-Player', hash, SECRET)).toBe(false);
  });

  it('trimmt nur aeussere Leerzeichen, damit Command und Worker denselben Hash verwenden', () => {
    const hash = hashBanIdentifier('  Player-123  ', SECRET);
    expect(matchesBanIdentifier('Player-123', hash, SECRET)).toBe(true);
  });
});
