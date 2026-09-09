import { identityHash } from './identity';

export interface IdentitySessionRow {
  gameId: string;
  playerName: string | null;
  connectedAt: Date | null;
  createdAt: Date;
}

export interface IdentitySessionLookupClient {
  playerSession: {
    findMany: (args: unknown) => Promise<IdentitySessionRow[]>;
  };
}

export interface IdentitySessionScope {
  guildId: string;
  nitradoConnId: string;
}

const DEFAULT_PAGE_SIZE = 1000;
const MAX_PAGE_SIZE = 5000;

function pageSize(value: number): number {
  return Math.max(1, Math.min(MAX_PAGE_SIZE, Math.trunc(value)));
}

/**
 * Scans scoped PlayerSession history in stable pages and returns the latest
 * non-empty display name belonging to the linked identity. The old fixed
 * take:5000 made older, still-valid users lose their display-name recognition
 * once a busy server accumulated more than 5,000 newer sessions.
 */
export async function findLatestIdentityPlayerName(
  client: IdentitySessionLookupClient,
  scope: IdentitySessionScope,
  targetIdentityHash: string,
  identitySecret: string,
  requestedPageSize = DEFAULT_PAGE_SIZE,
): Promise<string | null> {
  const take = pageSize(requestedPageSize);
  for (let skip = 0; ; skip += take) {
    const rows = await client.playerSession.findMany({
      where: { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId },
      select: { gameId: true, playerName: true, connectedAt: true, createdAt: true },
      orderBy: [{ connectedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      skip,
      take,
    });
    for (const row of rows) {
      if (!row.playerName?.trim()) continue;
      if (identityHash(row.gameId, identitySecret) === targetIdentityHash) return row.playerName.trim();
    }
    if (rows.length < take) return null;
  }
}

/**
 * Collects every historical display name belonging to one verified identity.
 * This is intentionally exhaustive: Goodbye whitelist cleanup must not classify
 * a linked user as NOT_LINKED merely because their relevant session is older
 * than a global history prefix. Only one page is retained in memory at a time.
 */
export async function collectIdentityPlayerNames(
  client: IdentitySessionLookupClient,
  scope: IdentitySessionScope,
  targetIdentityHash: string,
  identitySecret: string,
  requestedPageSize = DEFAULT_PAGE_SIZE,
): Promise<Set<string>> {
  const take = pageSize(requestedPageSize);
  const names = new Set<string>();
  for (let skip = 0; ; skip += take) {
    const rows = await client.playerSession.findMany({
      where: { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId },
      select: { gameId: true, playerName: true, connectedAt: true, createdAt: true },
      orderBy: [{ connectedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      skip,
      take,
    });
    for (const row of rows) {
      const playerName = row.playerName?.trim();
      if (!playerName) continue;
      if (identityHash(row.gameId, identitySecret) === targetIdentityHash) names.add(playerName);
    }
    if (rows.length < take) return names;
  }
}
