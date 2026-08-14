/**
 * Sichere Zielauflösung für Server-Banns.
 *
 * Ein Ban-Command adressiert einen Discord-Nutzer. Gebannt wird intern jedoch
 * ausschließlich dessen bereits VERIFIED GameIdentityLink-HMAC. Rohe Game-IDs
 * werden hier weder benötigt noch zurückgegeben.
 */

export interface BanTargetScope {
  guildId: string;
  nitradoConnId: string;
}

export interface BanTargetClient {
  gameIdentityLink: {
    findFirst: (args: unknown) => Promise<{ identityHash: string | null } | null>;
  };
}

/**
 * Liefert den HMAC-Hash eines VERIFIED Links im exakten Guild+Slot-Scope.
 * PENDING/UNLINKED/fehlende Links ergeben null.
 */
export async function resolveVerifiedBanIdentityHash(
  client: BanTargetClient,
  scope: BanTargetScope,
  userDiscordId: string,
): Promise<string | null> {
  const row = await client.gameIdentityLink.findFirst({
    where: {
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
      userDiscordId,
      status: 'VERIFIED',
      identityHash: { not: null },
    },
    select: { identityHash: true },
  });

  return row?.identityHash ?? null;
}
