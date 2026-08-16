from pathlib import Path

p = Path('src/modules/economy/blackMarket.ts')
s = p.read_text(encoding='utf-8')
old = '''        'INSERT INTO "EconomyMarketPurchase" ("id","idempotencyKey","listingId","guildId","nitradoConnId","vendorAccountId","userDiscordId","quantity","unitPrice","amount","createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,CURRENT_TIMESTAMP)',
        randomUUID(), key, args.listingId, String(args.guildId), String(args.nitradoConnId), preflight.vendorAccountId,
        String(args.userDiscordId), args.quantity, preflight.price, amount,
'''
new = '''        'INSERT INTO "EconomyMarketPurchase" ("id","idempotencyKey","listingId","guildId","nitradoConnId","vendorAccountId","userDiscordId","sourcePocket","quantity","unitPrice","amount","createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CURRENT_TIMESTAMP)',
        randomUUID(), key, args.listingId, String(args.guildId), String(args.nitradoConnId), preflight.vendorAccountId,
        String(args.userDiscordId), sourcePocket, args.quantity, preflight.price, amount,
'''
if old not in s:
    raise SystemExit('purchase insert marker missing')
p.write_text(s.replace(old, new, 1), encoding='utf-8')
print('sourcePocket purchase insert fixed')
