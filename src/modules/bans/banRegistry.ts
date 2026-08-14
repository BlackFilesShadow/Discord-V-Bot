/**
 * Ban-Registry (Phase 7, BAN-001..005). Fuehrt Server-Banns als lokale
 * DB-Wahrheit. Gebannt wird die HMAC-Identitaet (kein Klartext-GUID).
 *
 * Die echte Nitrado-Durchsetzung erfolgt asynchron ueber die Server-Ban-Outbox
 * und den offiziellen Gameserver-Banlist-Endpoint. `appliedRemotely` ist dabei
 * ein bestaetigter Sync-Status, keine Wunschannahme.
 */

export interface BanEntry {
  active: boolean;
  expiresAt: Date | null;
}

/** Aktiver Bann = nicht aufgehoben UND nicht abgelaufen. */
export function isBanActive(entry: BanEntry | null, now: Date): boolean {
  if (!entry || !entry.active) return false;
  return entry.expiresAt === null || entry.expiresAt.getTime() > now.getTime();
}

export interface BanScope {
  guildId: string;
  nitradoConnId: string;
}

export interface BanClient {
  serverBanEntry: {
    findUnique: (args: unknown) => Promise<BanEntry | null>;
    upsert: (args: { where: Record<string, unknown>; create: Record<string, unknown>; update: Record<string, unknown> }) => Promise<unknown>;
    updateMany: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => Promise<{ count: number }>;
  };
}

export async function addBan(
  client: BanClient,
  scope: BanScope,
  args: { identityHash: string; gameLabel?: string | null; reason?: string | null; bannedByDiscordId: string; expiresAt?: Date | null },
  now: Date = new Date(),
): Promise<void> {
  const where = { guildId_nitradoConnId_identityHash: { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId, identityHash: args.identityHash } };
  await client.serverBanEntry.upsert({
    where,
    create: {
      guildId: scope.guildId, nitradoConnId: scope.nitradoConnId, identityHash: args.identityHash,
      gameLabel: args.gameLabel ?? null, reason: args.reason ?? null,
      bannedByDiscordId: args.bannedByDiscordId, bannedAt: now,
      expiresAt: args.expiresAt ?? null,
      active: true, appliedRemotely: false, liftedAt: null,
    },
    // Re-Ban: reaktivieren, Metadaten erneuern UND Remote-Status bewusst auf
    // unbestaetigt setzen. Der anschliessende ADD-Outbox-Job liest Nitrados
    // echte Banlist und repariert damit auch extern/manuell entstandenen Drift.
    update: {
      gameLabel: args.gameLabel ?? null, reason: args.reason ?? null,
      bannedByDiscordId: args.bannedByDiscordId, bannedAt: now,
      expiresAt: args.expiresAt ?? null,
      active: true, appliedRemotely: false, liftedAt: null,
    },
  });
}

export async function liftBan(
  client: BanClient,
  scope: BanScope,
  identityHash: string,
  now: Date = new Date(),
): Promise<boolean> {
  const r = await client.serverBanEntry.updateMany({
    where: { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId, identityHash, active: true },
    data: { active: false, liftedAt: now },
  });
  return r.count > 0;
}

/**
 * Hebt einen Bann ueber seine DB-ID auf, weiterhin strikt auf Guild+Slot
 * begrenzt. Das ist der Recovery-Pfad fuer unlinkte/relinkte Nutzer, deren
 * aktueller GameIdentityLink nicht mehr auf den urspruenglichen Hash zeigt.
 */
export async function liftBanById(
  client: BanClient,
  scope: BanScope,
  banId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const r = await client.serverBanEntry.updateMany({
    where: { id: banId, guildId: scope.guildId, nitradoConnId: scope.nitradoConnId, active: true },
    data: { active: false, liftedAt: now },
  });
  return r.count > 0;
}

export async function isBanned(
  client: BanClient,
  scope: BanScope,
  identityHash: string,
  now: Date = new Date(),
): Promise<boolean> {
  const entry = await client.serverBanEntry.findUnique({
    where: { guildId_nitradoConnId_identityHash: { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId, identityHash } },
  });
  return isBanActive(entry, now);
}

export interface BanListRow extends BanEntry {
  id: string;
  identityHash: string;
  reason: string | null;
  appliedRemotely: boolean;
}

export interface BanListClient {
  serverBanEntry: {
    findMany: (args: unknown) => Promise<BanListRow[]>;
  };
}

/**
 * Listet alles, was operativ sichtbar bleiben muss:
 * - lokal aktive, noch nicht abgelaufene Banns;
 * - JEDEN als remote angewendet markierten Bann, auch wenn er lokal bereits
 *   aufgehoben oder abgelaufen ist. So wird Remote-Drift nie unsichtbar.
 */
export async function listOperationalBans(
  client: BanListClient,
  scope: BanScope,
  now: Date = new Date(),
  take = 50,
): Promise<BanListRow[]> {
  return client.serverBanEntry.findMany({
    where: {
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
      OR: [
        { appliedRemotely: true },
        {
          active: true,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
      ],
    },
    orderBy: { updatedAt: 'desc' },
    take,
  });
}

export function banOperationalState(
  entry: BanEntry & { appliedRemotely: boolean },
  now: Date = new Date(),
): 'LOCAL_ONLY' | 'LOCAL_AND_REMOTE' | 'REMOTE_DRIFT' {
  const locallyActive = isBanActive(entry, now);
  if (!locallyActive && entry.appliedRemotely) return 'REMOTE_DRIFT';
  if (locallyActive && entry.appliedRemotely) return 'LOCAL_AND_REMOTE';
  return 'LOCAL_ONLY';
}

// ---- Capability-Abstraktion fuer Tests/Fallbacks ----

export interface BanEnforcementCapabilities {
  canApplyRemote: boolean;
}

export interface BanEnforcementProvider {
  capabilities(): BanEnforcementCapabilities;
  applyBan?(identityHash: string): Promise<boolean>;
  removeBan?(identityHash: string): Promise<boolean>;
}

/** Fallback/Test-Provider ohne Remote-Durchsetzung. Produktion nutzt die Outbox. */
export const localOnlyBanProvider: BanEnforcementProvider = {
  capabilities: () => ({ canApplyRemote: false }),
};
