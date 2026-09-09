from pathlib import Path

# ---------------------------------------------------------------------------
# 1) Goodbye snapshot: use the same exhaustive identity evidence principle as
# the actual Leave whitelist saga. The old take:5000 could show NOT_LINKED for
# a valid older identity on a busy server.
# ---------------------------------------------------------------------------
goodbye = Path('src/modules/welcome/goodbyeStatus.ts')
text = goodbye.read_text(encoding='utf-8')
text = text.replace(
    "import { identityHash } from '../linking/identity';",
    "import { collectIdentityPlayerNames } from '../linking/sessionIdentityLookup';",
    1,
)
old = """    const [sessions, whitelistEntries, connection] = await Promise.all([
      prisma.playerSession.findMany({
        where: { guildId, nitradoConnId: link.nitradoConnId },
        select: { gameId: true, playerName: true },
        orderBy: { connectedAt: 'desc' },
        take: 5000,
      }),
      prisma.whitelistEntry.findMany({
        where: { guildId, nitradoConnId: link.nitradoConnId, syncState: 'SYNCED' },
        select: { gameId: true },
      }),
      prisma.nitradoConnection.findFirst({
        where: { id: link.nitradoConnId, guildId },
        select: { alias: true },
      }),
    ]);
    const linkedSessionNames = new Set(sessions.flatMap(session =>
      identityHash(session.gameId, config.security.encryptionKey) === link.identityHash && session.playerName?.trim()
        ? [session.playerName.trim().toLocaleLowerCase('en-US')]
        : [],
    ));
"""
new = """    const [identityNames, whitelistEntries, connection] = await Promise.all([
      collectIdentityPlayerNames(
        prisma,
        { guildId, nitradoConnId: link.nitradoConnId },
        link.identityHash,
        config.security.encryptionKey,
      ),
      prisma.whitelistEntry.findMany({
        where: { guildId, nitradoConnId: link.nitradoConnId, syncState: 'SYNCED' },
        select: { gameId: true },
      }),
      prisma.nitradoConnection.findFirst({
        where: { id: link.nitradoConnId, guildId },
        select: { alias: true },
      }),
    ]);
    const linkedSessionNames = new Set(
      [...identityNames].map(name => name.toLocaleLowerCase('en-US')),
    );
"""
if new not in text:
    if old not in text:
        raise SystemExit('goodbye 5000-session anchor missing')
    text = text.replace(old, new, 1)
goodbye.write_text(text, encoding='utf-8')

# ---------------------------------------------------------------------------
# 2) Leave-cleanup whitelist job history: the old newest-1000 prefix could miss
# an older still-relevant ADD/REMOVE job and therefore fail to neutralize/scrub
# it. Keep identical ordering/logic and remove only the total cap.
# ---------------------------------------------------------------------------
leave = Path('src/modules/moderation/leaveCleanupWhitelist.ts')
text = leave.read_text(encoding='utf-8')
text = text.replace(
"""    select: { id: true, operation: true, status: true, payload: true, attempts: true, updatedAt: true },
    orderBy: { createdAt: 'desc' },
    take: 1000,
  }) as Promise<ScopedJob[]>;""",
"""    select: { id: true, operation: true, status: true, payload: true, attempts: true, updatedAt: true },
    orderBy: { createdAt: 'desc' },
  }) as Promise<ScopedJob[]>;""",
1,
)
leave.write_text(text, encoding='utf-8')

# ---------------------------------------------------------------------------
# 3) Whitelist remote-intent safety: 500 simultaneous active leave sagas was a
# silent prefix. Removing the cap keeps fail-closed authorization semantics but
# prevents a valid cleanup from becoming unverifiable solely due to population.
# ---------------------------------------------------------------------------
intent = Path('src/modules/nitrado/whitelistIntent.ts')
text = intent.read_text(encoding='utf-8')
text = text.replace(
"""    },
    select: { discordId: true, details: true },
    take: 500,
  });
  const activeDiscordIds""",
"""    },
    select: { discordId: true, details: true },
  });
  const activeDiscordIds""",
1,
)
intent.write_text(text, encoding='utf-8')

# ---------------------------------------------------------------------------
# 4) Whitelist dashboard: replace inaccessible hard-cap with stable keyset
# pagination. First-page shape remains backwards compatible; new clients can
# request every row through nextCursor.
# ---------------------------------------------------------------------------
route = Path('src/dashboard/routes/v2/whitelist.ts')
text = route.read_text(encoding='utf-8')
helper_anchor = """function isValidName(s: unknown): s is string {
  return typeof s === 'string' && NAME_RE.test(s.trim()) && s.trim().length >= 1;
}
"""
helper = helper_anchor + """
interface WhitelistPageCursor {
  approvedAt: string;
  gameId: string;
}

function encodeWhitelistCursor(value: { approvedAt: Date; gameId: string }): string {
  return Buffer.from(JSON.stringify({ approvedAt: value.approvedAt.toISOString(), gameId: value.gameId }), 'utf8').toString('base64url');
}

function decodeWhitelistCursor(value: unknown): { approvedAt: Date; gameId: string } | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length < 1 || value.length > 512) throw new Error('INVALID_CURSOR');
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<WhitelistPageCursor>;
    if (typeof parsed.approvedAt !== 'string' || typeof parsed.gameId !== 'string' || !isValidName(parsed.gameId)) throw new Error();
    const approvedAt = new Date(parsed.approvedAt);
    if (!Number.isFinite(approvedAt.getTime())) throw new Error();
    return { approvedAt, gameId: parsed.gameId.trim() };
  } catch {
    throw new Error('INVALID_CURSOR');
  }
}
"""
if 'function encodeWhitelistCursor' not in text:
    if helper_anchor not in text:
        raise SystemExit('whitelist cursor helper anchor missing')
    text = text.replace(helper_anchor, helper, 1)

old_get = """whitelistRouter.get('/', requireGuildPermission('whitelist.view'), async (req, res) => {
  const scope = req.guildScope!;
  const connId = await activeSlotId(scope, req.query.slot, res);
  if (!connId) return;
  // Stage 28: hard-cap with limit+1 probe; stable approvedAt + gameId order.
  const limit = 1000;
  const rows = await prisma.whitelistEntry.findMany({
    where: { guildId: scope.guildId, nitradoConnId: connId, syncState: { not: 'PENDING_REMOVE' } },
    orderBy: [{ approvedAt: 'desc' }, { gameId: 'asc' }],
    take: limit + 1,
  });
  const hasMore = rows.length > limit;
  const visible = rows.slice(0, limit);
  res.json({
    limit,
    hasMore,
    entries: visible.map(r => ({
      gameId: r.gameId,
      approvedBy: r.approvedByDiscordId,
      source: r.source,
      approvedAt: r.approvedAt,
      syncState: r.syncState,
      lastSyncedAt: r.lastSyncedAt,
    })),
  });
});
"""
new_get = """whitelistRouter.get('/', requireGuildPermission('whitelist.view'), async (req, res) => {
  const scope = req.guildScope!;
  const connId = await activeSlotId(scope, req.query.slot, res);
  if (!connId) return;

  let cursor: { approvedAt: Date; gameId: string } | null;
  try {
    cursor = decodeWhitelistCursor(req.query.cursor);
  } catch {
    res.status(400).json({ error: 'Ungueltiger Whitelist-Cursor.' });
    return;
  }

  const limit = 1000;
  const baseWhere = {
    guildId: scope.guildId,
    nitradoConnId: connId,
    syncState: { not: 'PENDING_REMOVE' as const },
  };
  const rows = await prisma.whitelistEntry.findMany({
    where: cursor ? {
      ...baseWhere,
      OR: [
        { approvedAt: { lt: cursor.approvedAt } },
        { approvedAt: cursor.approvedAt, gameId: { gt: cursor.gameId } },
      ],
    } : baseWhere,
    orderBy: [{ approvedAt: 'desc' }, { gameId: 'asc' }],
    take: limit + 1,
  });
  const hasMore = rows.length > limit;
  const visible = rows.slice(0, limit);
  const last = visible[visible.length - 1];
  res.json({
    limit,
    hasMore,
    nextCursor: hasMore && last ? encodeWhitelistCursor(last) : null,
    entries: visible.map(r => ({
      gameId: r.gameId,
      approvedBy: r.approvedByDiscordId,
      source: r.source,
      approvedAt: r.approvedAt,
      syncState: r.syncState,
      lastSyncedAt: r.lastSyncedAt,
    })),
  });
});
"""
if new_get not in text:
    if old_get not in text:
        raise SystemExit('whitelist hard-cap route anchor missing')
    text = text.replace(old_get, new_get, 1)
route.write_text(text, encoding='utf-8')

# UI: useInfiniteQuery and a manual load-more control. Existing first-page API
# stubs remain valid because nextCursor is optional.
ui = Path('dashboard-ui/src/pages/ServerSlot.tsx')
text = ui.read_text(encoding='utf-8')
text = text.replace(
    "import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';",
    "import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';",
    1,
)
old_query = """  const entries = useQuery({
    queryKey: ['whitelist', guildId, slot],
    queryFn: () => api.get<{ entries: WhitelistEntry[] }>(`/api/v2/guilds/${guildId}/whitelist${qs}`),
  });
"""
new_query = """  const entries = useInfiniteQuery({
    queryKey: ['whitelist', guildId, slot],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api.get<{ entries: WhitelistEntry[]; hasMore?: boolean; nextCursor?: string | null }>(
      `/api/v2/guilds/${guildId}/whitelist${qs}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
    ),
    getNextPageParam: lastPage => lastPage.nextCursor ?? undefined,
  });
  const whitelistEntries = entries.data?.pages.flatMap(page => page.entries) ?? [];
"""
if new_query not in text:
    if old_query not in text:
        raise SystemExit('whitelist UI query anchor missing')
    text = text.replace(old_query, new_query, 1)
text = text.replace(
    "{entries.data?.entries.length === 0 && <p className=\"text-muted text-sm\">Keine Eintraege.</p>}",
    "{whitelistEntries.length === 0 && <p className=\"text-muted text-sm\">Keine Eintraege.</p>}",
    1,
)
text = text.replace(
    "{entries.data?.entries.map(e => (",
    "{whitelistEntries.map(e => (",
    1,
)
load_more_anchor = """            ))}
          </div>

          <div className=\"mt-6 pt-4 border-t border-border space-y-3\">"""
load_more = """            ))}
          </div>
          {entries.hasNextPage && (
            <Button
              size=\"sm\"
              variant=\"ghost\"
              className=\"mt-2\"
              disabled={entries.isFetchingNextPage}
              onClick={() => { void entries.fetchNextPage(); }}
            >
              {entries.isFetchingNextPage ? 'Lade weitere…' : 'Weitere Eintraege laden'}
            </Button>
          )}

          <div className=\"mt-6 pt-4 border-t border-border space-y-3\">"""
if "Weitere Eintraege laden" not in text:
    if load_more_anchor not in text:
        raise SystemExit('whitelist UI load-more anchor missing')
    text = text.replace(load_more_anchor, load_more, 1)
ui.write_text(text, encoding='utf-8')

# Keep the pagination inventory truthful.
matrix = Path('docs/dashboard-pagination-matrix.json')
if matrix.exists():
    text = matrix.read_text(encoding='utf-8')
    text = text.replace('"nextCursor": "none-hard-cap"', '"nextCursor": "approvedAt+gameId-keyset"', 1)
    matrix.write_text(text, encoding='utf-8')

# Static guards for remaining capacity regressions. Runtime helper behavior is
# covered separately by sessionIdentityLookupCapacity.test.ts.
test = Path('tests/modules/capacity4000DeepArchitecture.test.ts')
test.write_text("""import fs from 'node:fs';
import path from 'node:path';

const read = (relative: string): string => fs.readFileSync(path.join(process.cwd(), relative), 'utf8');

describe('4,000-player deep capacity guards', () => {
  it('whitelist dashboard exposes keyset pagination instead of an inaccessible hard cap', () => {
    const route = read('src/dashboard/routes/v2/whitelist.ts');
    const ui = read('dashboard-ui/src/pages/ServerSlot.tsx');
    const getRoute = route.split("whitelistRouter.get('/'")[1].split("whitelistRouter.post('/'")[0];
    expect(getRoute).toContain('nextCursor');
    expect(getRoute).toContain('approvedAt: { lt: cursor.approvedAt }');
    expect(getRoute).toContain('gameId: { gt: cursor.gameId }');
    expect(ui).toContain('useInfiniteQuery');
    expect(ui).toContain('Weitere Eintraege laden');
  });

  it('goodbye identity evidence and whitelist leave safety are not capped by global population prefixes', () => {
    const goodbye = read('src/modules/welcome/goodbyeStatus.ts');
    const leave = read('src/modules/moderation/leaveCleanupWhitelist.ts');
    const intent = read('src/modules/nitrado/whitelistIntent.ts');
    const goodbyeSection = goodbye.split('initialGoodbyeCleanupSnapshot')[1].split('editPersistedGoodbye')[0];
    const jobsSection = leave.split('async function listWhitelistJobs')[1].split('async function processLink')[0];
    const intentSection = intent.split('const leaveRequests =')[1].split('const activeDiscordIds')[0];

    expect(goodbyeSection).toContain('collectIdentityPlayerNames');
    expect(goodbyeSection).not.toContain('take: 5000');
    expect(jobsSection).not.toContain('take: 1000');
    expect(intentSection).not.toContain('take: 500');
  });
});
""", encoding='utf-8')
