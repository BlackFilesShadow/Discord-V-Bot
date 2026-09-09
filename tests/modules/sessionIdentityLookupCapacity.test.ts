import { identityHash } from '../../src/modules/linking/identity';
import {
  collectIdentityPlayerNames,
  findLatestIdentityPlayerName,
  type IdentitySessionLookupClient,
  type IdentitySessionRow,
} from '../../src/modules/linking/sessionIdentityLookup';

const SECRET = 'capacity-secret';

function row(index: number, gameId = `game-${index}`, name = `Player ${index}`, id = `session-${String(index).padStart(6, '0')}`): IdentitySessionRow {
  const createdAt = new Date(Date.UTC(2026, 8, 9, 20, 0, 0) - index * 1000);
  return { id, gameId, playerName: name, connectedAt: createdAt, createdAt };
}

function clientFor(input: IdentitySessionRow[]) {
  let rows = [...input].sort((a, b) => a.id.localeCompare(b.id));
  const calls: Array<{ afterId: string | null; take: number; usedSkip: boolean }> = [];
  const client: IdentitySessionLookupClient = {
    playerSession: {
      findMany: async (args: unknown) => {
        const query = args as { where?: { id?: { gt?: string } }; take?: number; skip?: number };
        const afterId = query.where?.id?.gt ?? null;
        const take = query.take ?? rows.length;
        calls.push({ afterId, take, usedSkip: query.skip !== undefined });
        const start = afterId === null ? 0 : rows.findIndex(item => item.id > afterId);
        if (start < 0) return [];
        return rows.slice(start, start + take);
      },
    },
  };
  return {
    client,
    calls,
    replaceRows(next: IdentitySessionRow[]) {
      rows = [...next].sort((a, b) => a.id.localeCompare(b.id));
    },
    currentRows() {
      return [...rows];
    },
  };
}

describe('identity session lookup capacity', () => {
  it('finds a linked player even when 6,000 unrelated server sessions precede it without OFFSET paging', async () => {
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
    expect(calls).toHaveLength(7);
    expect(calls.every(call => call.take === 1000)).toBe(true);
    expect(calls.every(call => call.usedSkip === false)).toBe(true);
    expect(calls[0].afterId).toBeNull();
    expect(calls.at(-1)?.afterId).toBe('session-005999');
  });

  it('collects every alias for a linked identity across keyset page boundaries without storing unrelated names', async () => {
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

  it('preserves the newest matching display name even though keyset scan order is by immutable id', async () => {
    const targetGameId = 'target-game-id';
    const older = row(100, targetGameId, 'Older Alias', 'a-session');
    const newer = row(10, targetGameId, 'Newest Alias', 'z-session');
    const { client } = clientFor([newer, older]);

    await expect(findLatestIdentityPlayerName(
      client,
      { guildId: 'g', nitradoConnId: 'n' },
      identityHash(targetGameId, SECRET),
      SECRET,
      1,
    )).resolves.toBe('Newest Alias');
  });

  it('does not shift pre-existing later pages when a lower id appears during a scan', async () => {
    const targetGameId = 'target-game-id';
    const initial = [
      row(4, 'other-1', 'Other 1', 'm-01'),
      row(3, 'other-2', 'Other 2', 'm-02'),
      row(2, targetGameId, 'Target Player', 'm-03'),
      row(1, 'other-4', 'Other 4', 'm-04'),
    ];
    let calls = 0;
    let rows = [...initial].sort((a, b) => a.id.localeCompare(b.id));
    const client: IdentitySessionLookupClient = {
      playerSession: {
        findMany: async (args: unknown) => {
          calls += 1;
          const query = args as { where?: { id?: { gt?: string } }; take?: number };
          const afterId = query.where?.id?.gt ?? null;
          if (calls === 2) {
            rows = [row(99, 'late-other', 'Late Other', 'a-late-row'), ...rows].sort((a, b) => a.id.localeCompare(b.id));
          }
          const start = afterId === null ? 0 : rows.findIndex(item => item.id > afterId);
          if (start < 0) return [];
          return rows.slice(start, start + (query.take ?? rows.length));
        },
      },
    };

    await expect(findLatestIdentityPlayerName(
      client,
      { guildId: 'g', nitradoConnId: 'n' },
      identityHash(targetGameId, SECRET),
      SECRET,
      2,
    )).resolves.toBe('Target Player');
  });
});
