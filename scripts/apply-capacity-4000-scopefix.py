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
    // Keep Guild + Gameserver scope explicit in both keyset branches. Besides
    // being easier to audit, this satisfies the repository's fail-closed scope
    // lint rule instead of hiding guildId inside an object spread.
    where: cursor ? {
      guildId: scope.guildId,
      nitradoConnId: connId,
      syncState: { not: 'PENDING_REMOVE' },
      OR: [
        { approvedAt: { lt: cursor.approvedAt } },
        { approvedAt: cursor.approvedAt, gameId: { gt: cursor.gameId } },
      ],
    } : {
      guildId: scope.guildId,
      nitradoConnId: connId,
      syncState: { not: 'PENDING_REMOVE' },
    },
"""
if new not in text:
    if old not in text:
        raise SystemExit('whitelist explicit scope anchor missing')
    text = text.replace(old, new, 1)
route.write_text(text, encoding='utf-8')
