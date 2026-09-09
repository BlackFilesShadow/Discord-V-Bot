from pathlib import Path

route = Path('src/dashboard/routes/v2/whitelist.ts')
text = route.read_text(encoding='utf-8')
old = """  const limit = 1000;
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
"""
new = """  const limit = 1000;
  const rows = await prisma.whitelistEntry.findMany({
    // Keep the tenant scope as direct properties of the where object. The
    // repository's fail-closed scope lint intentionally requires guildId to be
    // statically visible here; only the keyset continuation predicate is
    // optional on the first page.
    where: {
      guildId: scope.guildId,
      nitradoConnId: connId,
      syncState: { not: 'PENDING_REMOVE' },
      OR: cursor ? [
        { approvedAt: { lt: cursor.approvedAt } },
        { approvedAt: cursor.approvedAt, gameId: { gt: cursor.gameId } },
      ] : undefined,
    },
"""
if new not in text:
    if old not in text:
        raise SystemExit('whitelist direct scope anchor missing')
    text = text.replace(old, new, 1)
route.write_text(text, encoding='utf-8')
