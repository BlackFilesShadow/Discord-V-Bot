import {
  resolveVerifiedBanIdentityHash,
  matchesBanIdentifier,
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
});
