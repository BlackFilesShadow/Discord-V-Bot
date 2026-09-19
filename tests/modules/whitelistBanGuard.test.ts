import { isWhitelistBlockedByActiveServerBan } from '../../src/modules/bans/whitelistBanGuard';
import { hashBanIdentifier } from '../../src/modules/bans/banTarget';
import { identityHash } from '../../src/modules/linking/identity';
import { config } from '../../src/config';
import type { BanClient } from '../../src/modules/bans/banRegistry';

const SCOPE = { guildId: 'guild-a', nitradoConnId: 'slot-a' };
// isWhitelistBlockedByActiveServerBan hasht intern mit config.security.encryptionKey --
// die Mocks muessen denselben Secret verwenden, sonst passen die Hashes nie zusammen.
const SECRET = config.security.encryptionKey;
const NOW = new Date('2026-01-01T00:00:00Z');

function makeClient(activeHash: string | null): BanClient {
  return {
    serverBanEntry: {
      findUnique: jest.fn(async (args: unknown) => {
        const where = (args as { where: { guildId_nitradoConnId_identityHash: { identityHash: string } } }).where
          .guildId_nitradoConnId_identityHash;
        if (activeHash && where.identityHash === activeHash) {
          return { active: true, expiresAt: null };
        }
        return null;
      }),
      upsert: jest.fn(),
      updateMany: jest.fn(),
    },
  };
}

describe('isWhitelistBlockedByActiveServerBan', () => {
  it('blockiert, wenn ein Bann case-exakt auf denselben (case-normalisierten) Hash zeigt', async () => {
    const client = makeClient(hashBanIdentifier('PlayerOne', SECRET));
    await expect(isWhitelistBlockedByActiveServerBan(client, SCOPE, 'PlayerOne', NOW)).resolves.toBe(true);
  });

  it('blockiert einen Bann unabhaengig von der Gross-/Kleinschreibung des Whitelist-Antrags', async () => {
    // Bann wurde fuer "PlayerOne" angelegt (nach dem Fix case-normalisiert gespeichert).
    const client = makeClient(hashBanIdentifier('PlayerOne', SECRET));

    await expect(isWhitelistBlockedByActiveServerBan(client, SCOPE, 'playerone', NOW)).resolves.toBe(true);
    await expect(isWhitelistBlockedByActiveServerBan(client, SCOPE, 'PLAYERONE', NOW)).resolves.toBe(true);
    await expect(isWhitelistBlockedByActiveServerBan(client, SCOPE, '  PlayerOne  ', NOW)).resolves.toBe(true);
  });

  it('blockiert weiterhin einen Legacy-Bann (vor der Normalisierung) bei exakter Neueingabe', async () => {
    // Simuliert einen vor dem Fix gespeicherten Hash: identityHash() direkt auf der Original-Schreibweise.
    const legacyHash = identityHash('PlayerOne', SECRET);
    const client = makeClient(legacyHash);

    await expect(isWhitelistBlockedByActiveServerBan(client, SCOPE, 'PlayerOne', NOW)).resolves.toBe(true);
  });

  it('lehnt nicht gebannte Identifier ab', async () => {
    const client = makeClient(hashBanIdentifier('PlayerOne', SECRET));
    await expect(isWhitelistBlockedByActiveServerBan(client, SCOPE, 'SomeoneElse', NOW)).resolves.toBe(false);
  });

  it('leerer Identifier ist nie blockiert', async () => {
    const client = makeClient(null);
    await expect(isWhitelistBlockedByActiveServerBan(client, SCOPE, '   ', NOW)).resolves.toBe(false);
  });
});
