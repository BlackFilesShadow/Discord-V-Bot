import type { GuildId, NitradoConnId, UserDiscordId } from '../../types/scope';

/**
 * Phase 4 / SCOPE-001..003: kanonische Gameserver-Scope-Regeln.
 *
 * Neue Guilds duerfen maximal vier aktive Gameserver-Slots verwenden.
 * Historische Slot-5-Verbindungen werden NICHT automatisch geloescht: sie
 * bleiben als LEGACY_SLOT sichtbar und muessen bewusst migriert/aufgeloest
 * werden, bevor eine servergescopte Mutation darauf ausgefuehrt wird.
 */
export const MAX_GAME_SERVERS_PER_GUILD = 4;

export type GameServerSlotState = 'ACTIVE_SLOT' | 'LEGACY_SLOT';

export interface GameServerScope {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  slot: number;
  alias: string;
  slotState: GameServerSlotState;
}

export interface ServerUserScope extends GameServerScope {
  actorDiscordId: UserDiscordId;
}

export interface ScopeCandidate {
  id: NitradoConnId;
  slot: number;
  alias: string;
  status: string;
}

export type GameServerScopeResolution =
  | { kind: 'RESOLVED'; scope: ServerUserScope }
  | { kind: 'PROMPT_REQUIRED'; options: GameServerScope[] }
  | { kind: 'NO_SERVER' }
  | { kind: 'SERVER_NOT_FOUND' }
  | { kind: 'SERVER_INACTIVE' }
  | { kind: 'LEGACY_SLOT'; scope: ServerUserScope };

export function slotState(slot: number): GameServerSlotState {
  return Number.isInteger(slot) && slot >= 1 && slot <= MAX_GAME_SERVERS_PER_GUILD
    ? 'ACTIVE_SLOT'
    : 'LEGACY_SLOT';
}

function toScope(guildId: GuildId, candidate: ScopeCandidate): GameServerScope {
  return {
    guildId,
    nitradoConnId: candidate.id,
    slot: candidate.slot,
    alias: candidate.alias,
    slotState: slotState(candidate.slot),
  };
}

/**
 * Loest einen Gameserver-Scope ohne implizite "Slot 1"-Annahme auf.
 *
 * - explizit gewaehlter Server: exakt diesen validieren;
 * - genau ein aktiver, nicht-legacy Server: automatisch aufloesen;
 * - mehrere Server: PROMPT_REQUIRED statt zufaelliger/erster Auswahl;
 * - Slot > 4: LEGACY_SLOT, nie stillschweigend als normaler Scope behandeln.
 */
export function resolveOrPromptGameServerScope(args: {
  guildId: GuildId;
  actorDiscordId: UserDiscordId;
  connections: readonly ScopeCandidate[];
  requestedNitradoConnId?: NitradoConnId | null;
}): GameServerScopeResolution {
  const active = args.connections
    .filter((c) => c.status === 'ACTIVE')
    .sort((a, b) => a.slot - b.slot || a.id.localeCompare(b.id));

  if (args.requestedNitradoConnId) {
    const selected = args.connections.find((c) => c.id === args.requestedNitradoConnId);
    if (!selected) return { kind: 'SERVER_NOT_FOUND' };
    const scope: ServerUserScope = {
      ...toScope(args.guildId, selected),
      actorDiscordId: args.actorDiscordId,
    };
    if (selected.status !== 'ACTIVE') return { kind: 'SERVER_INACTIVE' };
    if (scope.slotState === 'LEGACY_SLOT') return { kind: 'LEGACY_SLOT', scope };
    return { kind: 'RESOLVED', scope };
  }

  const usable = active.filter((c) => slotState(c.slot) === 'ACTIVE_SLOT');
  if (usable.length === 0) {
    const legacy = active.find((c) => slotState(c.slot) === 'LEGACY_SLOT');
    if (legacy) {
      return {
        kind: 'LEGACY_SLOT',
        scope: { ...toScope(args.guildId, legacy), actorDiscordId: args.actorDiscordId },
      };
    }
    return { kind: 'NO_SERVER' };
  }

  if (usable.length === 1) {
    return {
      kind: 'RESOLVED',
      scope: { ...toScope(args.guildId, usable[0]), actorDiscordId: args.actorDiscordId },
    };
  }

  return {
    kind: 'PROMPT_REQUIRED',
    options: usable.map((c) => toScope(args.guildId, c)),
  };
}
