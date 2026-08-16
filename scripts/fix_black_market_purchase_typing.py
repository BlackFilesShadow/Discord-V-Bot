from pathlib import Path
p=Path('src/modules/economy/blackMarket.ts')
s=p.read_text(encoding='utf-8')
old='''async function existingPurchase(key: string): Promise<MarketPurchaseView | null> {\n  return prisma.economyMarketPurchase.findUnique({ where: { idempotencyKey: key } });\n}\n'''
new='''async function existingPurchase(key: string): Promise<MarketPurchaseView | null> {\n  const row = await prisma.economyMarketPurchase.findUnique({ where: { idempotencyKey: key } });\n  return row ? { ...row, sourcePocket: row.sourcePocket as EconomyPocket } : null;\n}\n'''
if old not in s: raise SystemExit('existingPurchase marker missing')
s=s.replace(old,new,1)
old2='''  return prisma.economyMarketPurchase.findMany({\n    where: { guildId: String(guildId), nitradoConnId: String(nitradoConnId) },\n    orderBy: { createdAt: 'desc' },\n    take: safeLimit,\n  });\n'''
new2='''  const rows = await prisma.economyMarketPurchase.findMany({\n    where: { guildId: String(guildId), nitradoConnId: String(nitradoConnId) },\n    orderBy: { createdAt: 'desc' },\n    take: safeLimit,\n  });\n  return rows.map(row => ({ ...row, sourcePocket: row.sourcePocket as EconomyPocket }));\n'''
if old2 not in s: raise SystemExit('list purchases marker missing')
p.write_text(s.replace(old2,new2,1),encoding='utf-8')
print('purchase typing fixed')