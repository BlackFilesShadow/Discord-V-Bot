/**
 * Konsolen-tauglicher Discord <-> DayZ-Link-Service.
 *
 * Der alte Ingame-Chat-Challenge-Flow wird nicht mehr benoetigt. Ein Spieler
 * weist seine Identitaet ueber den exakten PSN-/Xbox-/DayZ-Spielernamen nach.
 * Der Bot loest diesen Namen gegen die kanonischen PlayerSessions des
 * ausgewaehlten Nitrado-Servers auf, ermittelt daraus die DayZ-GUID/gameId und
 * erlaubt den normalen Link erst nach mindestens 5 Minuten nachgewiesener
 * Spielzeit.
 *
 * Persistiert wird weiterhin ausschliesslich der HMAC der DayZ-GUID. Damit
 * bleibt die bestehende Reward-/Economy-Aufloesung kompatibel und der Klartext
 * der GUID muss nicht dauerhaft in GameIdentityLink gespeichert werden.
 */

import { identityHash } from './identity';

export const MIN_LINK_PLAYTIME_SECONDS = 5 * 60;

export interface LinkScope {
  guildId: string;
  nitradoConnId: string;
}

export interface GameIdentityRow {
  userDiscordId: string;
  identityHash: string | null;
  status: 'PENDING' | 'VERIFIED' | 'UNLINKED';
  challengeCode: string | null;
  challengeExpiresAt: Date | null;
  verifiedAt?: Date | null;
}

export interface LinkClient {
  gameIdentityLink: {
    findFirst: (args: unknown) => Promise<GameIdentityRow | null>;
    upsert: (args: { where: Record<string, unknown>; create: Record<string, unknown>; update: Record<string, unknown> }) => Promise<unknown>;
    updateMany: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => Promise<{ count: number }>;
  };
}

export interface PlayerSessionLinkRow {
  id: string;
  gameId: string;
  playerName: string | null;
  connectedAt: Date | null;
  disconnectedAt: Date | null;
  durationSeconds: number;
  status: 'OPEN' | 'CLOSED';
  createdAt?: Date;
  updatedAt?: Date;
}

export interface VerifiedLinkRow extends GameIdentityRow {
  verifiedAt?: Date | null;
}

export interface SessionLinkClient extends LinkClient {
  gameIdentityLink: LinkClient['gameIdentityLink'] & {
    findMany: (args: unknown) => Promise<VerifiedLinkRow[]>;
  };
  playerSession: {
    findMany: (args: unknown) => Promise<PlayerSessionLinkRow[]>;
  };
}

export interface ResolvedPlayerIdentity {
  playerName: string;
  gameId: string;
  playedSeconds: number;
  knownGameIds: string[];
}

export interface LinkDetails {
  userDiscordId: string;
  playerName: string | null;
  gameId: string | null;
  verifiedAt: Date | null;
}

export type PlayerNameLinkFailureReason =
  | 'PLAYER_NOT_SEEN'
  | 'AMBIGUOUS_PLAYER_NAME'
  | 'PLAYTIME_TOO_SHORT'
  | 'PLAYER_NAME_TAKEN'
  | 'IDENTITY_TAKEN'
  | 'USER_ALREADY_LINKED';

export type PlayerNameLinkResult =
  | {
      ok: true;
      alreadyLinked: boolean;
      playerName: string;
      gameId: string;
      playedSeconds: number;
    }
  | {
      ok: false;
      reason: PlayerNameLinkFailureReason;
      playerName: string;
      playedSeconds?: number;
      requiredSeconds?: number;
    };

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';
}

function normalizePlayerName(value: string): string {
  return value.trim();
}

export function isValidPlayerName(value: string): boolean {
  const name = normalizePlayerName(value);
  return name.length >= 1 && name.length <= 64 && !/[\r\n\t]/.test(name);
}

function sessionSeconds(session: PlayerSessionLinkRow, now: Date): number {
  if (session.status === 'OPEN' && session.connectedAt) {
    const live = Math.floor((now.getTime() - session.connectedAt.getTime()) / 1000);
    return Math.max(session.durationSeconds, Number.isFinite(live) ? Math.max(0, live) : 0);
  }
  return Math.max(0, session.durationSeconds);
}

/**
 * Loest einen exakten Spielernamen gegen die auf diesem Server beobachteten
 * Sessions auf. Mehrere unterschiedliche GUIDs fuer exakt denselben Namen auf
 * demselben Server werden fail-closed als mehrdeutig behandelt.
 */
export async function resolvePlayerIdentityByName(
  client: SessionLinkClient,
  scope: LinkScope,
  rawPlayerName: string,
  now: Date = new Date(),
): Promise<ResolvedPlayerIdentity | null | 'AMBIGUOUS'> {
  const playerName = normalizePlayerName(rawPlayerName);
  if (!isValidPlayerName(playerName)) return null;

  const namedSessions = await client.playerSession.findMany({
    where: { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId, playerName },
    orderBy: [{ connectedAt: 'desc' }, { createdAt: 'desc' }],
    take: 500,
  });
  if (namedSessions.length === 0) return null;

  const knownGameIds = [...new Set(namedSessions.map(session => session.gameId).filter(Boolean))];
  if (knownGameIds.length !== 1) return 'AMBIGUOUS';
  const gameId = knownGameIds[0];

  const identitySessions = await client.playerSession.findMany({
    where: { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId, gameId },
    orderBy: [{ connectedAt: 'desc' }, { createdAt: 'desc' }],
    take: 1000,
  });
  const playedSeconds = identitySessions.reduce((sum, session) => sum + sessionSeconds(session, now), 0);

  return { playerName, gameId, playedSeconds, knownGameIds };
}

async function conflictForHashes(
  client: SessionLinkClient,
  scope: LinkScope,
  userDiscordId: string,
  hashes: string[],
): Promise<GameIdentityRow | null> {
  if (hashes.length === 0) return null;
  return client.gameIdentityLink.findFirst({
    where: {
      guildId: scope.guildId,
      identityHash: { in: hashes },
      status: 'VERIFIED',
      NOT: { userDiscordId },
    },
  });
}

/**
 * Ein eingegebener Username darf innerhalb derselben Discord-Guild genau einem
 * Discord-Account gehoeren. Die persistente Link-Tabelle speichert absichtlich
 * keinen Klartext-GUID/Username; deshalb wird die Eindeutigkeit ueber alle in
 * PlayerSession beobachteten GUIDs dieses exakten Namens hergestellt.
 */
async function playerNameHashesAcrossGuild(
  client: SessionLinkClient,
  scope: LinkScope,
  playerName: string,
  secret: string,
): Promise<string[]> {
  const sessions = await client.playerSession.findMany({
    where: { guildId: scope.guildId, playerName },
    orderBy: [{ connectedAt: 'desc' }, { createdAt: 'desc' }],
    take: 5000,
  });
  return [...new Set(sessions.map(session => identityHash(session.gameId, secret)))];
}

async function persistVerifiedLink(
  client: SessionLinkClient,
  scope: LinkScope,
  userDiscordId: string,
  gameId: string,
  secret: string,
  now: Date,
): Promise<{ ok: true; alreadyLinked: boolean } | { ok: false; reason: 'IDENTITY_TAKEN' | 'USER_ALREADY_LINKED' }> {
  const hash = identityHash(gameId, secret);

  const currentUserLink = await client.gameIdentityLink.findFirst({
    where: {
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
      userDiscordId,
      status: 'VERIFIED',
    },
  });
  if (currentUserLink?.identityHash === hash) return { ok: true, alreadyLinked: true };
  if (currentUserLink) return { ok: false, reason: 'USER_ALREADY_LINKED' };

  // Eine DayZ-GUID darf innerhalb derselben Discord-Guild nicht von zwei
  // verschiedenen Discord-Accounts beansprucht werden, auch nicht auf
  // unterschiedlichen Nitrado-Slots.
  const identityOwner = await client.gameIdentityLink.findFirst({
    where: { guildId: scope.guildId, identityHash: hash, status: 'VERIFIED', NOT: { userDiscordId } },
  });
  if (identityOwner) return { ok: false, reason: 'IDENTITY_TAKEN' };

  try {
    await client.gameIdentityLink.upsert({
      where: {
        guildId_nitradoConnId_userDiscordId: {
          guildId: scope.guildId,
          nitradoConnId: scope.nitradoConnId,
          userDiscordId,
        },
      },
      create: {
        guildId: scope.guildId,
        nitradoConnId: scope.nitradoConnId,
        userDiscordId,
        identityHash: hash,
        status: 'VERIFIED',
        verifiedAt: now,
        challengeCode: null,
        challengeExpiresAt: null,
      },
      update: {
        identityHash: hash,
        status: 'VERIFIED',
        verifiedAt: now,
        unlinkedAt: null,
        challengeCode: null,
        challengeExpiresAt: null,
      },
    });
    return { ok: true, alreadyLinked: false };
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, reason: 'IDENTITY_TAKEN' };
    throw error;
  }
}

async function linkResolvedIdentity(
  client: SessionLinkClient,
  scope: LinkScope,
  userDiscordId: string,
  resolved: ResolvedPlayerIdentity,
  secret: string,
  now: Date,
  requireFiveMinutes: boolean,
): Promise<PlayerNameLinkResult> {
  if (requireFiveMinutes && resolved.playedSeconds < MIN_LINK_PLAYTIME_SECONDS) {
    return {
      ok: false,
      reason: 'PLAYTIME_TOO_SHORT',
      playerName: resolved.playerName,
      playedSeconds: resolved.playedSeconds,
      requiredSeconds: MIN_LINK_PLAYTIME_SECONDS,
    };
  }

  const nameHashes = await playerNameHashesAcrossGuild(client, scope, resolved.playerName, secret);
  const nameOwner = await conflictForHashes(client, scope, userDiscordId, nameHashes);
  if (nameOwner) {
    return { ok: false, reason: 'PLAYER_NAME_TAKEN', playerName: resolved.playerName };
  }

  const persisted = await persistVerifiedLink(client, scope, userDiscordId, resolved.gameId, secret, now);
  if (!persisted.ok) {
    return { ok: false, reason: persisted.reason, playerName: resolved.playerName };
  }

  return {
    ok: true,
    alreadyLinked: persisted.alreadyLinked,
    playerName: resolved.playerName,
    gameId: resolved.gameId,
    playedSeconds: resolved.playedSeconds,
  };
}

/** Normaler User-Link: PlayerSession muss existieren und >= 5 Minuten belegen. */
export async function linkByPlayerName(
  client: SessionLinkClient,
  scope: LinkScope,
  userDiscordId: string,
  playerName: string,
  secret: string,
  now: Date = new Date(),
): Promise<PlayerNameLinkResult> {
  const resolved = await resolvePlayerIdentityByName(client, scope, playerName, now);
  if (!resolved) return { ok: false, reason: 'PLAYER_NOT_SEEN', playerName: normalizePlayerName(playerName) };
  if (resolved === 'AMBIGUOUS') return { ok: false, reason: 'AMBIGUOUS_PLAYER_NAME', playerName: normalizePlayerName(playerName) };
  return linkResolvedIdentity(client, scope, userDiscordId, resolved, secret, now, true);
}

/** Admin-Force-Link: umgeht ausschliesslich die 5-Minuten-Sperre. */
export async function forceLinkByPlayerName(
  client: SessionLinkClient,
  scope: LinkScope,
  userDiscordId: string,
  playerName: string,
  secret: string,
  now: Date = new Date(),
): Promise<PlayerNameLinkResult> {
  const resolved = await resolvePlayerIdentityByName(client, scope, playerName, now);
  if (!resolved) return { ok: false, reason: 'PLAYER_NOT_SEEN', playerName: normalizePlayerName(playerName) };
  if (resolved === 'AMBIGUOUS') return { ok: false, reason: 'AMBIGUOUS_PLAYER_NAME', playerName: normalizePlayerName(playerName) };
  return linkResolvedIdentity(client, scope, userDiscordId, resolved, secret, now, false);
}

export interface ResolveClient {
  gameIdentityLink: {
    findFirst: (args: unknown) => Promise<{ userDiscordId: string } | null>;
  };
}

/**
 * Loest eine Klartext-DayZ-GUID/gameId zum verifizierten Discord-User auf.
 * Diese Funktion ist die bestehende Bruecke fuer Rewards/Economy.
 */
export async function resolveVerifiedUser(
  client: ResolveClient,
  scope: LinkScope,
  gameId: string,
  secret: string,
): Promise<string | null> {
  const hash = identityHash(gameId, secret);
  const link = await client.gameIdentityLink.findFirst({
    where: {
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
      identityHash: hash,
      status: 'VERIFIED',
    },
  });
  return link?.userDiscordId ?? null;
}

/**
 * Soft-Unlink: Audit-Historie bleibt ueber den Datensatz erhalten, die aktive
 * Identitaet wird aber freigegeben. Das ist wichtig, damit ein bewusst
 * entkoppelter PSN-/Xbox-Account spaeter wieder korrekt verknuepft werden kann.
 */
export async function unlinkUser(
  client: LinkClient,
  scope: LinkScope,
  userDiscordId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const result = await client.gameIdentityLink.updateMany({
    where: {
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
      userDiscordId,
      status: { in: ['PENDING', 'VERIFIED'] },
    },
    data: {
      status: 'UNLINKED',
      identityHash: null,
      unlinkedAt: now,
      challengeCode: null,
      challengeExpiresAt: null,
    },
  });
  return result.count > 0;
}

/**
 * Loest verifizierte Links fuer Admin-Anzeige gegen die zuletzt bekannten
 * PlayerSessions auf. Die GUID wird nicht aus GameIdentityLink gelesen, sondern
 * nur zur Laufzeit aus der Session-Historie dem gespeicherten HMAC zugeordnet.
 */
export async function listVerifiedLinkDetails(
  client: SessionLinkClient,
  scope: LinkScope,
  secret: string,
  limit = 100,
): Promise<LinkDetails[]> {
  const links = await client.gameIdentityLink.findMany({
    where: { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId, status: 'VERIFIED' },
    orderBy: { verifiedAt: 'desc' },
    take: limit,
  });
  const sessions = await client.playerSession.findMany({
    where: { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId },
    orderBy: [{ connectedAt: 'desc' }, { createdAt: 'desc' }],
    take: 5000,
  });

  const byHash = new Map<string, PlayerSessionLinkRow>();
  for (const session of sessions) {
    const hash = identityHash(session.gameId, secret);
    if (!byHash.has(hash)) byHash.set(hash, session);
  }

  return links.map(link => {
    const session = link.identityHash ? byHash.get(link.identityHash) : undefined;
    return {
      userDiscordId: link.userDiscordId,
      playerName: session?.playerName ?? null,
      gameId: session?.gameId ?? null,
      verifiedAt: link.verifiedAt ?? null,
    };
  });
}

/** Lookup nach Discord-ID, exaktem Spielernamen oder aktueller GUID/gameId. */
export async function findVerifiedLinkDetails(
  client: SessionLinkClient,
  scope: LinkScope,
  secret: string,
  query: { userDiscordId?: string; identifier?: string },
): Promise<LinkDetails[]> {
  const all = await listVerifiedLinkDetails(client, scope, secret, 500);
  if (query.userDiscordId) return all.filter(row => row.userDiscordId === query.userDiscordId);
  const identifier = query.identifier?.trim();
  if (!identifier) return [];
  return all.filter(row => row.playerName === identifier || row.gameId === identifier);
}
