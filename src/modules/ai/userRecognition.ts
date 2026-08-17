import { identityHash } from '../linking/identity';

export interface AiRecognitionClient {
  gameIdentityLink: {
    findMany: (args: unknown) => Promise<Array<{
      identityHash: string | null;
      verifiedAt: Date | null;
    }>>;
  };
  playerSession: {
    findMany: (args: unknown) => Promise<Array<{
      gameId: string;
      playerName: string | null;
      connectedAt: Date | null;
      createdAt: Date;
    }>>;
  };
}

export interface VerifiedGameIdentityRecognition {
  state: 'VERIFIED';
  guildId: string;
  nitradoConnId: string;
  userDiscordId: string;
  playerName: string | null;
  verifiedAt: Date | null;
}

/**
 * AI-17: Read-only recognition view on top of the canonical GameIdentityLink.
 *
 * Invariants:
 * - exact Guild + Gameserver + Discord user scope only
 * - VERIFIED and currently linked only
 * - more than one matching link fails closed
 * - identityHash/challengeCode/gameId are never returned to the AI layer
 * - PlayerSession is used only to recover the latest safe display name
 * - recognition is context data, never an authorization decision
 */
export async function resolveVerifiedGameIdentityRecognition(
  client: AiRecognitionClient,
  args: {
    guildId: string;
    nitradoConnId: string;
    userDiscordId: string;
    identitySecret: string;
  },
): Promise<VerifiedGameIdentityRecognition | null> {
  const guildId = args.guildId.trim();
  const nitradoConnId = args.nitradoConnId.trim();
  const userDiscordId = args.userDiscordId.trim();
  const identitySecret = args.identitySecret;
  if (!guildId || !nitradoConnId || !userDiscordId || !identitySecret) return null;

  const links = await client.gameIdentityLink.findMany({
    where: {
      guildId,
      nitradoConnId,
      userDiscordId,
      status: 'VERIFIED',
      identityHash: { not: null },
      unlinkedAt: null,
    },
    select: { identityHash: true, verifiedAt: true },
    take: 2,
  });

  // The DB has an exact-scope unique key, but fail closed as defense in depth
  // if corrupted/legacy data or a test double ever violates that invariant.
  if (links.length !== 1 || !links[0].identityHash) return null;
  const link = links[0];

  const sessions = await client.playerSession.findMany({
    where: { guildId, nitradoConnId },
    select: { gameId: true, playerName: true, connectedAt: true, createdAt: true },
    orderBy: [{ connectedAt: 'desc' }, { createdAt: 'desc' }],
    take: 5000,
  });

  // Reconstruct only a display name. Neither the clear gameId nor its HMAC is
  // returned. If no historical session can be mapped, the verified link itself
  // is still valid recognition, just without a player-name label.
  const matching = sessions.filter(session => identityHash(session.gameId, identitySecret) === link.identityHash);
  const latestNamed = matching.find(session => !!session.playerName?.trim());

  return {
    state: 'VERIFIED',
    guildId,
    nitradoConnId,
    userDiscordId,
    playerName: latestNamed?.playerName?.trim().slice(0, 64) || null,
    verifiedAt: link.verifiedAt ?? null,
  };
}
