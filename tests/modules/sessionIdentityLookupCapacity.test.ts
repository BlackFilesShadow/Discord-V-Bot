import { identityHash } from '../../src/modules/linking/identity';
import {
  collectIdentityPlayerNames,
  findLatestIdentityPlayerName,
  type IdentitySessionLookupClient,
  type IdentitySessionRow,
} from '../../src/modules/linking/sessionIdentityLookup';

const SECRET = 'capacity-secret';

function row(index: number, gameId = `game-${index}`, name = `Player ${index}`): IdentitySessionRow {
  const createdAt = new Date(Date.UTC(2026, 8, 9, 20, 0, 0) - index * 1000);
  return { gameId, playerName: name, connectedAt: createdAt, createdAt };
}

function clientFor(rows: IdentitySessionRow[]) {
  const calls: Array<{ skip: number; take: number }> = [];
  const client: IdentitySessionLookupClient = {
    playerSession: {
      findMany: async (args: unknown) => {
        const query = args as { skip?: number; take?: number };
        const skip = query.skip ?? 0;
        const take = query.take ?? rows.length;
        calls.push({ skip, take });
        return rows.slice(skip, skip + take);
      },
    },
  };
  return { client, calls };
}

describe('identity session lookup capacity', () => {
  it('finds a linked player even when 6,000 newer server sessions precede it', async () => {
    const targetGameId = 'target-game-id';
    const rows = Array.from({ length: 6000 }, (_, index) => row(index));
    rows.push(row(6000, targetGameId, 'Target Player'));
    const { client, calls } = clientFor(rows);

    const name = await findLatestIdentityPlayerName(
      client,
      { guildId: 'g', nitradoConnId: 'n' },
      identityHash(targetGameId, SECRET),
      SECRET,
      1000,
    );

    expect(name).toBe('Target Player');
    expect(calls.length).toBe(7);
    expect(calls.at(-1)).toEqual({ skip: 6000, take: 1000 });
  });

  it('collects every alias for a linked identity across page boundaries without storing unrelated names', async () => {
    const targetGameId = 'target-game-id';
    const rows = Array.from({ length: 6500 }, (_, index) => row(index));
    rows[1200] = row(1200, targetGameId, 'Old Alias');
    rows[6200] = row(6200, targetGameId, 'Newest Alias');
    const { client } = clientFor(rows);

    const names = await collectIdentityPlayerNames(
      client,
      { guildId: 'g', nitradoConnId: 'n' },
      identityHash(targetGameId, SECRET),
      SECRET,
      1000,
    );

    expect(names).toEqual(new Set(['Old Alias', 'Newest Alias']));
  });
});
