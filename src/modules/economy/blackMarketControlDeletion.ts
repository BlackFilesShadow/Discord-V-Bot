import prisma from '../../database/prisma';
import type { GuildId, NitradoConnId, UserDiscordId } from '../../types/scope';
import { assertEconomyScopeReady } from './scopeMigration';
import type { VirtualAccountRawDb } from './virtualAccounts';

interface LockedListingRow {
  id: string;
  name: string;
}

function rawDb(client: unknown = prisma): VirtualAccountRawDb {
  return client as VirtualAccountRawDb;
}

export async function listHiddenMarketListingIds(args: {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
}): Promise<Set<string>> {
  await assertEconomyScopeReady(args.guildId, args.nitradoConnId);
  const rows = await rawDb().$queryRawUnsafe<Array<{ listingId: string }>>(
    'SELECT "listingId" FROM "EconomyMarketListingControlHidden" WHERE "guildId"=$1 AND "nitradoConnId"=$2',
    String(args.guildId),
    String(args.nitradoConnId),
  );
  return new Set(rows.map(row => row.listingId));
}

/**
 * Removes a market offer from every active/control surface while preserving the
 * listing row itself. Purchases keep their immutable listing FK and can still be
 * delivered/refunded/audited. Discord projection sync sees the listing as
 * inactive and removes any managed direct-buy message.
 */
export async function removeMarketListingFromControl(args: {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  listingId: string;
  actorDiscordId: UserDiscordId;
}): Promise<{ id: string; name: string; mode: 'CONTROL_HIDDEN' }> {
  await assertEconomyScopeReady(args.guildId, args.nitradoConnId);
  return prisma.$transaction(async tx => {
    const raw = rawDb(tx);
    const rows = await raw.$queryRawUnsafe<LockedListingRow[]>(
      'SELECT "id", "name" FROM "EconomyMarketListing" WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 LIMIT 1 FOR UPDATE',
      args.listingId,
      String(args.guildId),
      String(args.nitradoConnId),
    );
    const listing = rows[0];
    if (!listing) throw new Error('Schwarzmarkt-Angebot nicht gefunden.');

    const archived = await raw.$executeRawUnsafe(
      'UPDATE "EconomyMarketListing" SET "active"=FALSE, "archivedAt"=COALESCE("archivedAt", CURRENT_TIMESTAMP), "archivedByDiscordId"=COALESCE("archivedByDiscordId", $4), "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3',
      args.listingId,
      String(args.guildId),
      String(args.nitradoConnId),
      String(args.actorDiscordId),
    );
    if (archived !== 1) throw new Error('Schwarzmarkt-Angebot wurde parallel verändert; Entfernen abgebrochen.');

    const hidden = await raw.$executeRawUnsafe(
      'INSERT INTO "EconomyMarketListingControlHidden" ("listingId", "guildId", "nitradoConnId", "hiddenAt") VALUES ($1,$2,$3,CURRENT_TIMESTAMP) ON CONFLICT ("listingId") DO UPDATE SET "hiddenAt"=CURRENT_TIMESTAMP WHERE "EconomyMarketListingControlHidden"."guildId"=EXCLUDED."guildId" AND "EconomyMarketListingControlHidden"."nitradoConnId"=EXCLUDED."nitradoConnId"',
      args.listingId,
      String(args.guildId),
      String(args.nitradoConnId),
    );
    if (hidden !== 1) throw new Error('Schwarzmarkt-Angebot konnte nicht sicher aus der Verwaltung entfernt werden.');

    return { id: listing.id, name: listing.name, mode: 'CONTROL_HIDDEN' as const };
  });
}
