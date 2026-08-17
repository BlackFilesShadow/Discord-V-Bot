import { identityHash } from '../../src/modules/linking/identity';
import { resolveVerifiedGameIdentityRecognition } from '../../src/modules/ai/userRecognition';

const SECRET = 'ai-17-test-secret-with-enough-entropy';

function client(args?: {
  links?: Array<{ identityHash: string | null; verifiedAt: Date | null }>;
  sessions?: Array<{ gameId: string; playerName: string | null; connectedAt: Date | null; createdAt: Date }>;
}) {
  return {
    gameIdentityLink: {
      findMany: jest.fn().mockResolvedValue(args?.links ?? []),
    },
    playerSession: {
      findMany: jest.fn().mockResolvedValue(args?.sessions ?? []),
    },
  };
}

describe('AI-17 verified user recognition', () => {
  it('resolves only the exact guild + gameserver + Discord user scope', async () => {
    const hash = identityHash('dayz-guid-1', SECRET);
    const db = client({
      links: [{ identityHash: hash, verifiedAt: new Date('2026-08-17T08:00:00Z') }],
      sessions: [{
        gameId: 'dayz-guid-1',
        playerName: 'Void_Architect',
        connectedAt: new Date('2026-08-17T07:00:00Z'),
        createdAt: new Date('2026-08-17T07:00:00Z'),
      }],
    });

    await expect(resolveVerifiedGameIdentityRecognition(db, {
      guildId: 'guild-a',
      nitradoConnId: 'conn-2',
      userDiscordId: 'user-9',
      identitySecret: SECRET,
    })).resolves.toEqual({
      state: 'VERIFIED',
      guildId: 'guild-a',
      nitradoConnId: 'conn-2',
      userDiscordId: 'user-9',
      playerName: 'Void_Architect',
      verifiedAt: new Date('2026-08-17T08:00:00Z'),
    });

    expect(db.gameIdentityLink.findMany).toHaveBeenCalledWith({
      where: {
        guildId: 'guild-a',
        nitradoConnId: 'conn-2',
        userDiscordId: 'user-9',
        status: 'VERIFIED',
        identityHash: { not: null },
        unlinkedAt: null,
      },
      select: { identityHash: true, verifiedAt: true },
      take: 2,
    });
    expect(db.playerSession.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { guildId: 'guild-a', nitradoConnId: 'conn-2' },
    }));
  });

  it('does not recognize pending, unlinked, foreign or absent links because the query is VERIFIED exact-scope only', async () => {
    const db = client();
    await expect(resolveVerifiedGameIdentityRecognition(db, {
      guildId: 'guild-a', nitradoConnId: 'conn-1', userDiscordId: 'user-1', identitySecret: SECRET,
    })).resolves.toBeNull();
    expect(db.playerSession.findMany).not.toHaveBeenCalled();
  });

  it('fails closed if more than one active exact-scope link is returned', async () => {
    const db = client({
      links: [
        { identityHash: identityHash('guid-1', SECRET), verifiedAt: new Date() },
        { identityHash: identityHash('guid-2', SECRET), verifiedAt: new Date() },
      ],
    });
    await expect(resolveVerifiedGameIdentityRecognition(db, {
      guildId: 'guild-a', nitradoConnId: 'conn-1', userDiscordId: 'user-1', identitySecret: SECRET,
    })).resolves.toBeNull();
    expect(db.playerSession.findMany).not.toHaveBeenCalled();
  });

  it('never exposes gameId, identityHash or challenge data in its recognition result', async () => {
    const hash = identityHash('secret-guid', SECRET);
    const db = client({
      links: [{ identityHash: hash, verifiedAt: null }],
      sessions: [{ gameId: 'secret-guid', playerName: 'PlayerOne', connectedAt: null, createdAt: new Date() }],
    });
    const result = await resolveVerifiedGameIdentityRecognition(db, {
      guildId: 'g', nitradoConnId: 'n', userDiscordId: 'u', identitySecret: SECRET,
    });
    expect(result).toMatchObject({ state: 'VERIFIED', playerName: 'PlayerOne' });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('secret-guid');
    expect(serialized).not.toContain(hash);
    expect(serialized).not.toMatch(/challenge/i);
  });

  it('keeps verified recognition even when no session can safely reconstruct a display name', async () => {
    const db = client({ links: [{ identityHash: identityHash('guid-1', SECRET), verifiedAt: null }] });
    await expect(resolveVerifiedGameIdentityRecognition(db, {
      guildId: 'g', nitradoConnId: 'n', userDiscordId: 'u', identitySecret: SECRET,
    })).resolves.toMatchObject({ state: 'VERIFIED', playerName: null });
  });

  it('rejects incomplete scope or a missing identity secret without touching the DB', async () => {
    const db = client();
    await expect(resolveVerifiedGameIdentityRecognition(db, {
      guildId: '', nitradoConnId: 'n', userDiscordId: 'u', identitySecret: SECRET,
    })).resolves.toBeNull();
    await expect(resolveVerifiedGameIdentityRecognition(db, {
      guildId: 'g', nitradoConnId: 'n', userDiscordId: 'u', identitySecret: '',
    })).resolves.toBeNull();
    expect(db.gameIdentityLink.findMany).not.toHaveBeenCalled();
  });
});
