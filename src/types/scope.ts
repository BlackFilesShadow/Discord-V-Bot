/**
 * Branded Types fuer strikte Scope-Trennung (Phase 3.5 Isolation-Doktrin).
 *
 * Verhindert auf Compile-Zeit, dass irgendein roher `string` als guildId oder
 * nitradoConnId an scoped Repositories durchgereicht wird. Jeder Code-Pfad
 * MUSS explizit via `asGuildId(...)` / `asNitradoConnId(...)` taggen — was die
 * bewusste Stelle ist, an der ein Wert "scope-validiert" wird (Discord
 * Interaction, REST-Middleware, WS-Handshake).
 */

declare const GuildIdBrand: unique symbol;
declare const NitradoConnIdBrand: unique symbol;
declare const UserDiscordIdBrand: unique symbol;

export type GuildId = string & { readonly [GuildIdBrand]: true };
export type NitradoConnId = string & { readonly [NitradoConnIdBrand]: true };
export type UserDiscordId = string & { readonly [UserDiscordIdBrand]: true };

const SNOWFLAKE = /^\d{17,20}$/;
const CUID = /^c[a-z0-9]{24}$/; // Prisma cuid() format

export function asGuildId(raw: string): GuildId {
  if (!SNOWFLAKE.test(raw)) {
    throw new Error(`Invalid guildId snowflake: ${raw}`);
  }
  return raw as GuildId;
}

export function asUserDiscordId(raw: string): UserDiscordId {
  if (!SNOWFLAKE.test(raw)) {
    throw new Error(`Invalid userDiscordId snowflake: ${raw}`);
  }
  return raw as UserDiscordId;
}

export function asNitradoConnId(raw: string): NitradoConnId {
  if (!CUID.test(raw)) {
    throw new Error(`Invalid nitradoConnId cuid: ${raw}`);
  }
  return raw as NitradoConnId;
}

export interface GuildScope {
  guildId: GuildId;
  nitradoConnId: NitradoConnId | null;
  actorDiscordId: UserDiscordId;
  isOwner: boolean;
  permissions: ReadonlySet<PermissionScope>;
}

export const PERMISSION_SCOPES = [
  'commands.all',
  'dashboard.access',
  'dashboard.view',
  'nitrado.manage',
  'nitrado.view',
  'nitrado.write',
  'nitrado.keep-online',
  'nitrado.danger',
  'tickets.manage',
  'whitelist.view',
  'whitelist.manage',
  'bans.view',
  'bans.manage',
  'factions.view',
  'factions.manage',
  'economy.view',
  'economy.manage',
  'casino.view',
  'casino.manage',
  'killfeed.view',
  'killfeed.manage',
  'welcome.view',
  'welcome.manage',
  'embeds.view',
  'embeds.manage',
  'reactionroles.view',
  'reactionroles.manage',
  'feeds.view',
  'feeds.manage',
  'translate.view',
  'translate.manage',
  'permissions.manage',
  'dev.console',
] as const;

export type PermissionScope = typeof PERMISSION_SCOPES[number];

export const NON_DELEGABLE_SCOPES: ReadonlySet<PermissionScope> = new Set([
  'nitrado.manage',
  'nitrado.danger',
  'permissions.manage',
  'dev.console',
]);

/** Dashboard/REST-Aufloesung. `dashboard.access` ist nur hier ein All-Access-Bypass. */
export function hasPermission(scope: GuildScope, perm: PermissionScope): boolean {
  if (scope.isOwner) return true;
  if (scope.permissions.has(perm)) return true;
  if (scope.permissions.has('dashboard.access') && !NON_DELEGABLE_SCOPES.has(perm)) {
    return true;
  }
  return false;
}

/**
 * Discord-Command-Aufloesung.
 *
 * Wichtig: `dashboard.access` wird hier absichtlich NICHT als Bypass verwendet.
 * Ein Dashboard-Vollzugriff darf nicht stillschweigend privilegierte Slash-
 * Commands freischalten. Fuer Commands gelten nur:
 *  - Owner,
 *  - der explizite Ziel-Scope,
 *  - `commands.all` fuer delegierbare Ziel-Scopes.
 */
export function hasCommandPermission(scope: GuildScope, perm: PermissionScope): boolean {
  if (scope.isOwner) return true;
  if (scope.permissions.has(perm)) return true;
  return scope.permissions.has('commands.all') && !NON_DELEGABLE_SCOPES.has(perm);
}
