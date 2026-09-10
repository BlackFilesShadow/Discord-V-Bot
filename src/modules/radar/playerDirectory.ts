import { Prisma } from '@prisma/client';
import prisma from '../../database/prisma';
import { isValidBattleyeGuid } from '../../utils/guid';

export interface RadarPlayerDirectoryEntry {
  gameId: string;
  playerName: string;
}

/**
 * Returns the latest non-empty display name for every gameserver identity in
 * the requested guild/server scope. Result size is bounded by unique players,
 * not by historical PlayerSession row count.
 */
export async function loadRadarPlayerDirectory(
  guildId: string,
  nitradoConnId: string,
): Promise<RadarPlayerDirectoryEntry[]> {
  const rows = await prisma.$queryRaw<Array<{
    gameId: string;
    playerName: string | null;
    updatedAt: Date;
    id: string;
  }>>(Prisma.sql`
    SELECT latest."gameId", latest."playerName", latest."updatedAt", latest."id"
      FROM (
        SELECT DISTINCT ON ("gameId")
               "gameId", "playerName", "updatedAt", "id"
          FROM "PlayerSession"
         WHERE "guildId" = ${guildId}
           AND "nitradoConnId" = ${nitradoConnId}
           AND "playerName" IS NOT NULL
         ORDER BY "gameId", "updatedAt" DESC, "id" DESC
      ) AS latest
     ORDER BY latest."updatedAt" DESC, latest."id" DESC
  `);

  return rows.flatMap(row => {
    const gameId = row.gameId.trim();
    const playerName = row.playerName?.trim();
    if (!playerName || !isValidBattleyeGuid(gameId)) return [];
    return [{ gameId, playerName }];
  });
}
