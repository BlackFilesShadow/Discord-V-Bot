/* eslint-disable local/no-unscoped-prisma-query -- Direct-buy resolution is explicitly guild, game-server, channel and message scoped. */
import { createHash } from 'node:crypto';
import prisma from '../../database/prisma';
import { asGuildId, asNitradoConnId, type GuildId, type NitradoConnId } from '../../types/scope';

interface DirectBuyContextRow {
  guildId: string;
  nitradoConnId: string;
  listingId: string;
  vendorAccountId: string;
  price: bigint;
  updatedAt: Date;
  channelId: string;
  messageId: string;
}

export interface MarketDirectBuyContext {
  guildId: GuildId;
  connId: NitradoConnId;
  listingId: string;
  vendorAccountId: string;
  price: bigint;
  updatedAt: Date;
  channelId: string;
  messageId: string;
  version: string;
}

export function marketDirectBuyVersion(listing: {
  id: string;
  vendorAccountId: string;
  price: bigint | string;
  updatedAt: Date | string;
}): string {
  const updatedAt = listing.updatedAt instanceof Date ? listing.updatedAt.toISOString() : new Date(listing.updatedAt).toISOString();
  return createHash('sha256')
    .update([
      listing.id,
      listing.vendorAccountId,
      listing.price.toString(),
      updatedAt,
    ].join('|'))
    .digest('hex')
    .slice(0, 12);
}

/**
 * Resolves only a currently managed direct-buy message. The join deliberately
 * binds the interaction to the listing, scope, configured direct-buy channel
 * and the exact Discord message created by the projection.
 */
export async function resolveManagedDirectBuyContext(args: {
  listingId: string;
  guildId: string | null;
  channelId: string | null;
  messageId: string;
}): Promise<MarketDirectBuyContext> {
  if (!args.guildId || !args.channelId) throw new Error('Direktkauf ist nur in einem Discord-Server verfügbar.');

  const rows = await prisma.$queryRawUnsafe<DirectBuyContextRow[]>(
    `SELECT
       l."guildId",
       l."nitradoConnId",
       l."id" AS "listingId",
       l."vendorAccountId",
       l."price",
       l."updatedAt",
       m."channelId",
       m."messageId"
     FROM "EconomyMarketDiscordMessage" m
     JOIN "EconomyMarketDiscordProjection" p
       ON p."id"=m."projectionId"
      AND p."guildId"=m."guildId"
      AND p."nitradoConnId"=m."nitradoConnId"
     JOIN "EconomyMarketListing" l
       ON l."id"=m."listingId"
      AND l."guildId"=m."guildId"
      AND l."nitradoConnId"=m."nitradoConnId"
     WHERE m."kind"='DIRECT_BUY'
       AND m."listingId"=$1
       AND m."guildId"=$2
       AND m."channelId"=$3
       AND m."messageId"=$4
       AND p."directBuyEnabled"=TRUE
       AND p."directBuyChannelId"=m."channelId"
       AND l."active"=TRUE
       AND l."archivedAt" IS NULL
     LIMIT 1`,
    args.listingId,
    args.guildId,
    args.channelId,
    args.messageId,
  );
  const row = rows[0];
  if (!row) throw new Error('Diese Direktkauf-Aktion ist veraltet oder nicht mehr freigegeben.');

  return {
    guildId: asGuildId(row.guildId),
    connId: asNitradoConnId(row.nitradoConnId),
    listingId: row.listingId,
    vendorAccountId: row.vendorAccountId,
    price: row.price,
    updatedAt: row.updatedAt,
    channelId: row.channelId,
    messageId: row.messageId,
    version: marketDirectBuyVersion({
      id: row.listingId,
      vendorAccountId: row.vendorAccountId,
      price: row.price,
      updatedAt: row.updatedAt,
    }),
  };
}
