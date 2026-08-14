import {
  resolveVerifiedBanIdentityHash,
  type BanTargetClient,
} from '../../src/modules/bans/banTarget';

const SCOPE = { guildId: 'guild-a', nitradoConnId: 'slot-a' };

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
