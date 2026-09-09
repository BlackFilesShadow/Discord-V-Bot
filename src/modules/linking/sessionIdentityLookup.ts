import type { Prisma } from '@prisma/client';
import { identityHash } from './identity';

export interface IdentitySessionRow {
  id: string;
  gameId: string;
  playerName: string | null;
  connectedAt: Date | null;
  createdAt: Date;
}

export interface IdentitySessionLookupClient {
  playerSession: {
    findMany: (args: Prisma.PlayerSessionFindManyArgs) => Promise<IdentitySessionRow[]>;
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

function isNewerSession(candidate: IdentitySessionRow, current: IdentitySessionRow): boolean {
  const candidateConnected = candidate.connectedAt?.getTime() ?? candidate.createdAt.getTime();
  const currentConnected = current.connectedAt?.getTime() ?? current.createdAt.getTime();
  if (candidateConnected !== currentConnected) return candidateConnected > currentConnected;
  const candidateCreated = candidate.createdAt.getTime();
  const currentCreated = current.createdAt.getTime();
  if (candidateCreated !== currentCreated) return candidateCreated > currentCreated;
  return candidate.id.localeCompare(current.id) > 0;
}

async function readIdentitySessionPage(
  client: IdentitySessionLookupClient,
  scope: IdentitySessionScope,
  afterId: string | null,
  take: number,
): Promise<IdentitySessionRow[]> {
  return client.playerSession.findMany({
    where: {
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
      ...(afterId ? { id: { gt: afterId } } : {}),
    },
    select: { id: true, gameId: true, playerName: true, connectedAt: true, createdAt: true },
    orderBy: { id: 'asc' },
    take,
  });
}

/**
 * Scans scoped PlayerSession history with immutable-id keyset pagination and
 * returns the newest non-empty display name belonging to the linked identity.
 * The old fixed take:5000 could hide older identities, while OFFSET pagination
 * could shift under concurrent inserts. Keyset pages cannot skip pre-existing
 * later rows; a newly inserted lower-key row is picked up on the next scan.
 */
export async function findLatestIdentityPlayerName(
  client: IdentitySessionLookupClient,
  scope: IdentitySessionScope,
  targetIdentityHash: string,
  identitySecret: string,
  requestedPageSize = DEFAULT_PAGE_SIZE,
): Promise<string | null> {
  const take = pageSize(requestedPageSize);
  let afterId: string | null = null;
  let latest: IdentitySessionRow | null = null;
  for (;;) {
    const rows = await readIdentitySessionPage(client, scope, afterId, take);
    for (const row of rows) {
      const playerName = row.playerName?.trim();
      if (!playerName || identityHash(row.gameId, identitySecret) !== targetIdentityHash) continue;
      if (!latest || isNewerSession(row, latest)) latest = row;
    }
    if (rows.length < take) return latest?.playerName?.trim() || null;
    afterId = rows[rows.length - 1].id;
  }
}

/**
 * Collects every historical display name belonging to one verified identity.
 * This is intentionally exhaustive: Goodbye whitelist cleanup must not classify
 * a linked user as NOT_LINKED merely because their relevant session is older
 * than a global history prefix. Only one bounded keyset page is retained in
 * memory at a time.
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
  let afterId: string | null = null;
  for (;;) {
    const rows = await readIdentitySessionPage(client, scope, afterId, take);
    for (const row of rows) {
      const playerName = row.playerName?.trim();
      if (!playerName) continue;
      if (identityHash(row.gameId, identitySecret) === targetIdentityHash) names.add(playerName);
    }
    if (rows.length < take) return names;
    afterId = rows[rows.length - 1].id;
  }
}
