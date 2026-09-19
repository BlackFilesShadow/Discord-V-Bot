import {
  resolveVerifiedBanIdentityHash,
  matchesBanIdentifier,
  hashBanIdentifier,
  candidateBanIdentifierHashes,
  type BanTargetClient,
} from '../../src/modules/bans/banTarget';
import { identityHash } from '../../src/modules/linking/identity';

const SCOPE = { guildId: 'guild-a', nitradoConnId: 'slot-a' };
const SECRET = 'ban-secret';

function makeClient(row: { identityHash: string | null } | null) {
  const findFirst = jest.fn(async (_args: unknown) => row);
  const client: BanTargetClient = { gameIdentityLink: { findFirst } };
  return { client, findFirst };
}

describe('resolveVerifiedBanIdentityHash', () => {
  it('liefert nur den gespeicherten HMAC-Hash zurueck', async () => {
    const hash = 'a'.repeat(64);
    const { client, findFirst } = makeClient({ identityHash: hash });

    await expect(resolveVerifiedBanIdentityHash(client, SCOPE, 'user-1')).resolves.toBe(hash);
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        guildId: SCOPE.guildId,
        nitradoConnId: SCOPE.nitradoConnId,
        userDiscordId: 'user-1',
        status: 'VERIFIED',
        identityHash: { not: null },
      },
      select: { identityHash: true },
    });
  });

  it('fehlender oder nicht aufloesbarer Link -> null', async () => {
    const missing = makeClient(null);
    await expect(resolveVerifiedBanIdentityHash(missing.client, SCOPE, 'user-1')).resolves.toBeNull();

    const noHash = makeClient({ identityHash: null });
    await expect(resolveVerifiedBanIdentityHash(noHash.client, SCOPE, 'user-1')).resolves.toBeNull();
  });
});

describe('matchesBanIdentifier', () => {
  it('akzeptiert nur den Klartext-Identifier, der zum gespeicherten HMAC gehoert', () => {
    const raw = '76561198000000000';
    const hash = identityHash(raw, SECRET);

    expect(matchesBanIdentifier(raw, hash, SECRET)).toBe(true);
    expect(matchesBanIdentifier('76561198000000001', hash, SECRET)).toBe(false);
  });

  it('lehnt ungueltige gespeicherte Hashes kontrolliert ab', () => {
    expect(matchesBanIdentifier('player', 'not-a-sha256', SECRET)).toBe(false);
  });

  it('erkennt einen neu (case-normalisiert) gespeicherten Bann unabhaengig von Gross-/Kleinschreibung', () => {
    const hash = hashBanIdentifier('PlayerOne', SECRET);

    expect(matchesBanIdentifier('PlayerOne', hash, SECRET)).toBe(true);
    expect(matchesBanIdentifier('playerone', hash, SECRET)).toBe(true);
    expect(matchesBanIdentifier('PLAYERONE', hash, SECRET)).toBe(true);
    expect(matchesBanIdentifier('  playerOne  ', hash, SECRET)).toBe(true);
    expect(matchesBanIdentifier('PlayerTwo', hash, SECRET)).toBe(false);
  });

  it('bleibt fuer Legacy-Hashes (vor der Normalisierung, exakte Schreibweise) verifizierbar', () => {
    // Simuliert einen vor diesem Fix gespeicherten Hash: identityHash() direkt
    // auf der Original-Schreibweise ohne Normalisierung.
    const legacyHash = identityHash('PlayerOne', SECRET);

    expect(matchesBanIdentifier('PlayerOne', legacyHash, SECRET)).toBe(true);
    // Eine andere Schreibweise kann fuer einen echten Legacy-Eintrag nicht
    // rekonstruiert werden (der Klartext ist nicht rueckgewinnbar) -- das ist
    // keine Regression, sondern der bereits vor dem Fix bestehende Zustand.
    expect(matchesBanIdentifier('playerone', legacyHash, SECRET)).toBe(false);
  });
});

describe('hashBanIdentifier', () => {
  it('normalisiert Gross-/Kleinschreibung und Whitespace vor dem Hashen', () => {
    expect(hashBanIdentifier('PlayerOne', SECRET)).toBe(hashBanIdentifier('playerone', SECRET));
    expect(hashBanIdentifier(' PlayerOne ', SECRET)).toBe(hashBanIdentifier('playerone', SECRET));
  });
});

describe('candidateBanIdentifierHashes', () => {
  it('liefert genau einen Kandidaten, wenn der Identifier bereits normalisiert ist', () => {
    expect(candidateBanIdentifierHashes('playerone', SECRET)).toHaveLength(1);
  });

  it('liefert canonical- und Legacy-Kandidaten fuer gemischte Schreibweise', () => {
    const candidates = candidateBanIdentifierHashes('PlayerOne', SECRET);
    expect(candidates).toHaveLength(2);
    expect(candidates).toContain(identityHash('playerone', SECRET));
    expect(candidates).toContain(identityHash('PlayerOne', SECRET));
  });
});
