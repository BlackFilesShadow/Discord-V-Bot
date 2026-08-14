import type { Response } from 'express';
import prisma from '../../../database/prisma';
import {
  asNitradoConnId,
  type GuildId,
  type NitradoConnId,
  type UserDiscordId,
} from '../../../types/scope';
import {
  MAX_GAME_SERVERS_PER_GUILD,
  resolveOrPromptGameServerScope,
  type ScopeCandidate,
} from '../../../modules/nitrado/gameServerScope';

export type DashboardServerResolution =
  | { kind: 'RESOLVED'; nitradoConnId: NitradoConnId }
  | { kind: 'INVALID_SLOT' }
  | { kind: 'NO_SERVER' }
  | { kind: 'SERVER_NOT_FOUND'; slot?: number }
  | { kind: 'SERVER_INACTIVE'; slot?: number }
  | { kind: 'LEGACY_SLOT'; slot: number }
  | { kind: 'PROMPT_REQUIRED'; slots: number[] };

export interface DashboardServerCandidate {
  id: string;
  slot: number;
  alias: string;
  status: string;
  nitradoServerId: string | null;
}

/**
 * Gemeinsame REST-Auswahlregel fuer alle Dashboard-Module.
 * Kein Modul darf wieder einen `findFirst(orderBy: slot)`-Fallback einfuehren.
 */
export function selectDashboardGameServer(
  guildId: GuildId,
  actorDiscordId: UserDiscordId,
  candidates: readonly DashboardServerCandidate[],
  slotParam: unknown,
): DashboardServerResolution {
  const bound: ScopeCandidate[] = candidates
    .filter(c => typeof c.nitradoServerId === 'string' && c.nitradoServerId.length > 0)
    .map(c => ({ id: asNitradoConnId(c.id), slot: c.slot, alias: c.alias, status: c.status }));

  let requestedNitradoConnId: NitradoConnId | undefined;
  let requestedSlot: number | undefined;
  if (slotParam !== undefined) {
    if (typeof slotParam !== 'string' || !/^\d+$/.test(slotParam)) return { kind: 'INVALID_SLOT' };
    requestedSlot = Number(slotParam);
    if (!Number.isInteger(requestedSlot) || requestedSlot < 1 || requestedSlot > MAX_GAME_SERVERS_PER_GUILD) {
      return { kind: 'INVALID_SLOT' };
    }
    const selected = bound.find(c => c.slot === requestedSlot);
    if (!selected) return { kind: 'SERVER_NOT_FOUND', slot: requestedSlot };
    requestedNitradoConnId = selected.id;
  }

  const resolution = resolveOrPromptGameServerScope({
    guildId,
    actorDiscordId,
    connections: bound,
    requestedNitradoConnId,
  });

  switch (resolution.kind) {
    case 'RESOLVED':
      return { kind: 'RESOLVED', nitradoConnId: resolution.scope.nitradoConnId };
    case 'NO_SERVER':
      return { kind: 'NO_SERVER' };
    case 'SERVER_NOT_FOUND':
      return { kind: 'SERVER_NOT_FOUND', slot: requestedSlot };
    case 'SERVER_INACTIVE':
      return { kind: 'SERVER_INACTIVE', slot: requestedSlot };
    case 'LEGACY_SLOT':
      return { kind: 'LEGACY_SLOT', slot: resolution.scope.slot };
    case 'PROMPT_REQUIRED':
      return { kind: 'PROMPT_REQUIRED', slots: resolution.options.map(o => o.slot) };
  }
}

export async function resolveDashboardGameServer(
  guildId: GuildId,
  actorDiscordId: UserDiscordId,
  slotParam: unknown,
): Promise<DashboardServerResolution> {
  const candidates = await prisma.nitradoConnection.findMany({
    where: { guildId },
    select: { id: true, slot: true, alias: true, status: true, nitradoServerId: true },
    orderBy: [{ slot: 'asc' }, { id: 'asc' }],
  });
  return selectDashboardGameServer(guildId, actorDiscordId, candidates, slotParam);
}

export function sendDashboardServerResolutionError(
  res: Response,
  resolution: Exclude<DashboardServerResolution, { kind: 'RESOLVED' }>,
): void {
  switch (resolution.kind) {
    case 'INVALID_SLOT':
      res.status(400).json({ error: `slot muss eine Ganzzahl zwischen 1 und ${MAX_GAME_SERVERS_PER_GUILD} sein.` });
      return;
    case 'PROMPT_REQUIRED':
      res.status(409).json({ error: `Mehrere aktive Gameserver gefunden (${resolution.slots.join(', ')}). Bitte ?slot=1..${MAX_GAME_SERVERS_PER_GUILD} explizit angeben.` });
      return;
    case 'SERVER_NOT_FOUND':
      res.status(404).json({ error: resolution.slot ? `Slot ${resolution.slot} ist nicht als Gameserver gebunden.` : 'Gameserver nicht gefunden.' });
      return;
    case 'SERVER_INACTIVE':
      res.status(409).json({ error: resolution.slot ? `Slot ${resolution.slot} ist nicht aktiv.` : 'Gameserver ist nicht aktiv.' });
      return;
    case 'LEGACY_SLOT':
      res.status(409).json({ error: `Slot ${resolution.slot} ist ein Legacy-Slot. Maximal ${MAX_GAME_SERVERS_PER_GUILD} aktive Gameserver sind zulaessig.` });
      return;
    case 'NO_SERVER':
      res.status(404).json({ error: 'Kein aktiver Gameserver konfiguriert.' });
      return;
  }
}
