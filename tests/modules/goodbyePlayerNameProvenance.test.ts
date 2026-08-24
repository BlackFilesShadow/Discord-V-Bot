process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

const mockLinks = jest.fn();
const mockSessions = jest.fn();
const mockWhitelistEntries = jest.fn();
const mockConnection = jest.fn();

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    gameIdentityLink: { findMany: mockLinks },
    playerSession: { findMany: mockSessions },
    whitelistEntry: { findMany: mockWhitelistEntries },
    nitradoConnection: { findFirst: mockConnection },
  },
}));

import { config } from '../../src/config';
import { identityHash } from '../../src/modules/linking/identity';
import { initialGoodbyeCleanupSnapshot } from '../../src/modules/welcome/goodbyeStatus';

describe('Goodbye whitelisted player-name provenance', () => {
  it('shows only a SYNCED whitelist name that belongs to the VERIFIED GUID link', async () => {
    mockLinks.mockResolvedValue([{
      nitradoConnId: 'conn-1',
      identityHash: identityHash('guid-linked', config.security.encryptionKey),
    }]);
    mockSessions.mockResolvedValue([
      { gameId: 'guid-linked', playerName: 'VerifiedPlayer' },
      { gameId: 'guid-other', playerName: 'ForeignPlayer' },
      { gameId: 'guid-linked', playerName: 'OnlySeenInAdm' },
    ]);
    mockWhitelistEntries.mockResolvedValue([
      { gameId: 'VerifiedPlayer' },
      { gameId: 'ForeignPlayer' },
      { gameId: 'OnlyInWhitelist' },
    ]);
    mockConnection.mockResolvedValue({ alias: 'Chernarus' });

    const snapshot = await initialGoodbyeCleanupSnapshot('guild-1', 'discord-1');

    expect(mockWhitelistEntries).toHaveBeenCalledWith({
      where: { guildId: 'guild-1', nitradoConnId: 'conn-1', syncState: 'SYNCED' },
      select: { gameId: true },
    });
    expect(snapshot.servers).toEqual([expect.objectContaining({
      serverAlias: 'Chernarus',
      playerNames: ['VerifiedPlayer'],
      state: 'PENDING',
    })]);
  });
});
