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

/**
 * Vollstaendiger Scope-Container, der durch jede Command-/Route-Handler
 * Pipeline durchgereicht wird. Nichts darf an Repos vorbei.
 */
export interface GuildScope {
  guildId: GuildId;
  nitradoConnId: NitradoConnId | null; // null = "Guild-only" (Tickets, Permissions)
  actorDiscordId: UserDiscordId;
  isOwner: boolean;
  permissions: ReadonlySet<PermissionScope>;
}

/**
 * Hardcoded Permission-Scopes. Owner hat implizit alle.
 * KEIN Free-Text — Scope-Strings sind Compile-Zeit-Konstanten.
 *
 * Sonderscope:
 *   `dashboard.access` — Allgemeiner Vollzugriff fuers Dashboard. Macht die Guild
 *   in der Dashboard-Liste sichtbar UND wirkt als Bypass fuer alle anderen
 *   delegierbaren Scopes (siehe `hasPermission`). NICHT-delegierbare Scopes
 *   (nitrado.manage, permissions.manage, dev.console) bleiben Owner-only.
 *
 *   `dashboard.view` — Reiner generischer Lesezugriff aufs Dashboard
 *   (GET /dashboard). Oeffnet KEINE Modul-Scopes automatisch — wer einzelne
 *   Module sehen will, braucht den jeweiligen `*.view`-Scope oder `dashboard.access`.
 */
export const PERMISSION_SCOPES = [
  'dashboard.access',   // ALL-ACCESS Bypass fuer alle delegierbaren Scopes
  'dashboard.view',     // Generischer Dashboard-Lesezugriff (oeffnet keine Module automatisch)
  'nitrado.manage',     // Token connect/disconnect — NIE delegierbar (Owner-only-hardcoded an Routen-Layer)
  'nitrado.view',       // Read-Only Nitrado-Daten ansehen (Snapshots, Settings, Files) — delegierbar
  'nitrado.write',      // Normale schreibende Nitrado-Aktionen (Whitelist-Sync etc.) — delegierbar, Write-Protection-gegated
  'nitrado.danger',     // Gefaehrliche Aktionen (Restart/Stop/Delete/File-Write/Config-Write) — NIE delegierbar
  'tickets.manage',
  'whitelist.view',
  'whitelist.manage',
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
  'permissions.manage', // NIE delegierbar
  'dev.console',        // NIE delegierbar
] as const;

export type PermissionScope = typeof PERMISSION_SCOPES[number];

/**
 * Permissions, die NICHT via /perm-add delegierbar sind — auch wenn jemand
 * sie in den DB-Grant einschmuggelt, blockt der Routen-Layer.
 */
export const NON_DELEGABLE_SCOPES: ReadonlySet<PermissionScope> = new Set([
  'nitrado.manage',
  'nitrado.danger',
  'permissions.manage',
  'dev.console',
]);

export function hasPermission(scope: GuildScope, perm: PermissionScope): boolean {
  if (scope.isOwner) return true;
  // Direkter Treffer (z. B. expliziter `tickets.manage`-Grant).
  if (scope.permissions.has(perm)) return true;
  // ALL-ACCESS Bypass: `dashboard.access` deckt alle Scopes ab — ausser den
  // nicht-delegierbaren (Nitrado-Token, Permissions-Verwaltung, Dev-Console).
  if (scope.permissions.has('dashboard.access') && !NON_DELEGABLE_SCOPES.has(perm)) {
    return true;
  }
  return false;
}
