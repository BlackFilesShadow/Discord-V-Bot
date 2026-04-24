import type { Client, Guild } from 'discord.js';
import prisma from '../../database/prisma';
import { logger } from '../../utils/logger';

/**
 * Guild-Awareness (Phase 6, Teil A).
 *
 * Haelt pro Guild eine kompakte Stammdaten-Zeile in der DB (`GuildProfile`)
 * und einen schnellen Memory-Cache. Wird genutzt, damit der Bot weiss,
 * AUF WELCHEM Server er gerade spricht, ohne pro Anfrage Discord zu fragen.
 *
 * Lifecycle:
 * - `bootstrapGuildAwareness(client)` beim Bot-Start: alle Guilds einmal syncen.
 * - `syncGuild(guild)` bei guildCreate / guildUpdate / nach Owner-Wechsel.
 * - `getGuildProfile(guildId)` liest aus Cache (Fallback DB) – fuer den AI-Prompt.
 *
 * Stale-Schutz: wenn der Cache aelter als CACHE_TTL_MS ist, wird beim
 * Lesen ein Soft-Reload aus der DB gemacht.
 */

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min

export interface GuildProfileLite {
  guildId: string;
  name: string;
  ownerId: string | null;
  ownerName: string | null;
  memberCount: number;
  channelCount: number;
  roleCount: number;
  preferredLocale: string | null;
  description: string | null;
  features: string[] | null;
  lastSyncedAt: Date;
}

const cache = new Map<string, { profile: GuildProfileLite; cachedAt: number }>();

function toLite(row: any): GuildProfileLite {
  return {
    guildId: row.guildId,
    name: row.name,
    ownerId: row.ownerId ?? null,
    ownerName: row.ownerName ?? null,
    memberCount: row.memberCount ?? 0,
    channelCount: row.channelCount ?? 0,
    roleCount: row.roleCount ?? 0,
    preferredLocale: row.preferredLocale ?? null,
    description: row.description ?? null,
    features: Array.isArray(row.features) ? (row.features as string[]) : null,
    lastSyncedAt: row.lastSyncedAt ?? new Date(),
  };
}

/**
 * Holt aktuelle Stammdaten von Discord, schreibt sie in die DB und in den Cache.
 */
export async function syncGuild(guild: Guild): Promise<GuildProfileLite | null> {
  try {
    let ownerName: string | null = null;
    try {
      const owner = await guild.fetchOwner({ cache: true });
      ownerName = owner?.user?.username ?? null;
    } catch {
      /* darf fehlen */
    }
    const data = {
      guildId: guild.id,
      name: guild.name,
      ownerId: guild.ownerId ?? null,
      ownerName,
      memberCount: guild.memberCount ?? 0,
      channelCount: guild.channels.cache.size,
      roleCount: guild.roles.cache.size,
      iconUrl: guild.iconURL() ?? null,
      preferredLocale: guild.preferredLocale ?? null,
      description: guild.description ?? null,
      features: (guild.features as unknown as string[]) ?? [],
      lastSyncedAt: new Date(),
    };

    const row = await prisma.guildProfile.upsert({
      where: { guildId: guild.id },
      create: data,
      update: {
        name: data.name,
        ownerId: data.ownerId,
        ownerName: data.ownerName,
        memberCount: data.memberCount,
        channelCount: data.channelCount,
        roleCount: data.roleCount,
        iconUrl: data.iconUrl,
        preferredLocale: data.preferredLocale,
        description: data.description,
        features: data.features,
        lastSyncedAt: data.lastSyncedAt,
      },
    });

    const lite = toLite(row);
    cache.set(guild.id, { profile: lite, cachedAt: Date.now() });
    return lite;
  } catch (e) {
    logger.warn('GuildAwareness.syncGuild fehlgeschlagen:', { guildId: guild.id, e: String(e) });
    return null;
  }
}

/**
 * Liefert das gecachte Profil. Bei Cache-Miss / Stale: DB-Reload.
 */
export async function getGuildProfile(guildId: string): Promise<GuildProfileLite | null> {
  const hit = cache.get(guildId);
  if (hit && Date.now() - hit.cachedAt < CACHE_TTL_MS) return hit.profile;

  try {
    const row = await prisma.guildProfile.findUnique({ where: { guildId } });
    if (!row) return hit?.profile ?? null;
    const lite = toLite(row);
    cache.set(guildId, { profile: lite, cachedAt: Date.now() });
    return lite;
  } catch (e) {
    logger.warn('GuildAwareness.getGuildProfile DB-Fehler:', { guildId, e: String(e) });
    return hit?.profile ?? null;
  }
}

/**
 * Beim Bot-Start: alle aktuellen Guilds einmalig syncen.
 */
export async function bootstrapGuildAwareness(client: Client): Promise<void> {
  const guilds = Array.from(client.guilds.cache.values());
  if (guilds.length === 0) return;
  let ok = 0;
  for (const g of guilds) {
    const r = await syncGuild(g);
    if (r) ok += 1;
  }
  logger.info(`GuildAwareness: ${ok}/${guilds.length} Guilds gesynct.`);
}

/**
 * Phase 6, Teil C: Schutz vor Cross-Guild-Datenlecks.
 *
 * Wirft, wenn eine Datenzeile zu einer anderen Guild gehoert als erwartet.
 * Datensaetze ohne `guildId` (Legacy) werden toleriert, weil ein hartes
 * Werfen sonst alte Records unbrauchbar macht. Solche Faelle werden geloggt.
 */
export function assertGuildScope(
  expectedGuildId: string | null | undefined,
  actualGuildId: string | null | undefined,
  resourceLabel: string,
): void {
  if (!expectedGuildId) return; // DM / Kontext ohne Guild: kein Check noetig
  if (actualGuildId == null) {
    // Legacy-Record ohne guildId – nur Warnung, nicht hart blockieren.
    logger.warn(`assertGuildScope: ${resourceLabel} ohne guildId, erwartet ${expectedGuildId}`);
    return;
  }
  if (expectedGuildId !== actualGuildId) {
    throw new Error(
      `Cross-Guild-Zugriff verhindert: ${resourceLabel} gehoert zu Guild ${actualGuildId}, erwartet ${expectedGuildId}`,
    );
  }
}

/** Nur fuer Tests / Hot-Reload. */
export function _clearGuildAwarenessCache(): void {
  cache.clear();
}
