import type { Client, Guild, GuildBasedChannel } from 'discord.js';
import { ChannelType } from 'discord.js';
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
const CONTENT_SYNC_INTERVAL_MS = 60 * 60 * 1000; // 60 min
const CONTENT_STALE_AFTER_MS = 50 * 60 * 1000; // Sync, wenn aelter als 50 min

export interface ChannelSnapshot {
  name: string;
  type: string;
  parent?: string | null;
}

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
  channels: ChannelSnapshot[] | null;
  rulesText: string | null;
  contentSyncedAt: Date | null;
  aiPersonaOverride: string | null;
  aiBrief: string | null;
  aiBriefAt: Date | null;
  serverCreatedAt: Date | null;
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
    channels: Array.isArray(row.channelsJson) ? (row.channelsJson as ChannelSnapshot[]) : null,
    rulesText: row.rulesText ?? null,
    contentSyncedAt: row.contentSyncedAt ?? null,
    aiPersonaOverride: row.aiPersonaOverride ?? null,
    aiBrief: row.aiBrief ?? null,
    aiBriefAt: row.aiBriefAt ?? null,
    serverCreatedAt: row.serverCreatedAt ?? null,
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
      serverCreatedAt: guild.createdAt ?? null,
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
        serverCreatedAt: data.serverCreatedAt,
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

// ---------------------------------------------------------------------------
// Phase 7: Channels & Rules Auto-Sync (alle 60 min)
// ---------------------------------------------------------------------------

function channelTypeLabel(t: ChannelType): string {
  switch (t) {
    case ChannelType.GuildText: return 'text';
    case ChannelType.GuildVoice: return 'voice';
    case ChannelType.GuildCategory: return 'category';
    case ChannelType.GuildAnnouncement: return 'news';
    case ChannelType.GuildStageVoice: return 'stage';
    case ChannelType.GuildForum: return 'forum';
    case ChannelType.GuildMedia: return 'media';
    case ChannelType.PublicThread:
    case ChannelType.PrivateThread:
    case ChannelType.AnnouncementThread: return 'thread';
    default: return 'other';
  }
}

function snapshotChannels(guild: Guild): ChannelSnapshot[] {
  const out: ChannelSnapshot[] = [];
  // Sortiere Categories zuerst, dann Kanaele in Position-Reihenfolge.
  const channels = Array.from(guild.channels.cache.values()).sort((a, b) => {
    const ap = (a as any).position ?? 0;
    const bp = (b as any).position ?? 0;
    return ap - bp;
  });
  for (const ch of channels) {
    if (!('name' in ch) || !ch.name) continue;
    // Threads ausblenden, das blaeht den Snapshot zu sehr auf.
    if ([ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread].includes(ch.type)) continue;
    const parent = (ch as any).parent?.name ?? null;
    out.push({
      name: ch.name.slice(0, 60),
      type: channelTypeLabel(ch.type),
      parent,
    });
    if (out.length >= 80) break; // Prompt-Schutz
  }
  return out;
}

async function snapshotRules(guild: Guild): Promise<string | null> {
  const parts: string[] = [];
  const rulesChannel: GuildBasedChannel | null = guild.rulesChannel ?? null;
  const candidates: GuildBasedChannel[] = [];
  if (rulesChannel) candidates.push(rulesChannel);
  // Fallback-Suche: Channels mit "regel" oder "rules" im Namen
  for (const ch of guild.channels.cache.values()) {
    if (!('name' in ch) || !ch.name) continue;
    if (ch === rulesChannel) continue;
    if (/regel|rules|verhalten|kodex/i.test(ch.name)) candidates.push(ch);
    if (candidates.length >= 3) break;
  }

  for (const ch of candidates) {
    try {
      // Channel-Topic
      const topic = (ch as any).topic as string | undefined;
      if (topic && topic.trim()) parts.push(`# ${ch.name}\n${topic.trim()}`);

      // Pinned Messages (max 5, je 800 Zeichen) – nur Text-Channels
      if ('messages' in ch && typeof (ch as any).messages?.fetchPinned === 'function') {
        const pins = await (ch as any).messages.fetchPinned().catch(() => null);
        if (pins) {
          let i = 0;
          for (const m of pins.values()) {
            const text = (m.content || '').trim();
            if (!text) continue;
            parts.push(text.slice(0, 800));
            if (++i >= 5) break;
          }
        }
      }
    } catch {
      /* darf fehlen */
    }
    if (parts.join('\n').length > 4000) break;
  }
  if (parts.length === 0) return null;
  return parts.join('\n\n').slice(0, 5000);
}

/**
 * Schreibt Channel-Liste + Rules-Text in das GuildProfile und aktualisiert den Cache.
 * Best-effort: Fehler werden geloggt, brechen aber nichts ab.
 */
export async function syncGuildContent(guild: Guild): Promise<void> {
  try {
    const channels = snapshotChannels(guild);
    const rulesText = await snapshotRules(guild);
    const row = await prisma.guildProfile.update({
      where: { guildId: guild.id },
      data: {
        channelsJson: channels as any,
        rulesText,
        contentSyncedAt: new Date(),
      },
    }).catch(async (e) => {
      // Falls noch kein Stammdatensatz existiert, erst Stammdaten anlegen.
      logger.warn('syncGuildContent: GuildProfile fehlt, lege an:', { guildId: guild.id, e: String(e) });
      await syncGuild(guild);
      return prisma.guildProfile.update({
        where: { guildId: guild.id },
        data: {
          channelsJson: channels as any,
          rulesText,
          contentSyncedAt: new Date(),
        },
      });
    });
    cache.set(guild.id, { profile: toLite(row), cachedAt: Date.now() });
    // Phase 8: deterministischen AI-Brief aktualisieren (kein LLM-Call)
    try {
      const { regenerateAiBrief } = await import('./guildKnowledge.js');
      await regenerateAiBrief(guild.id);
    } catch (e) {
      logger.warn('regenerateAiBrief fehlgeschlagen:', { guildId: guild.id, e: String(e) });
    }
    logger.info(`GuildAwareness: Content gesynct fuer ${guild.name} (${channels.length} Kanaele, Rules: ${rulesText ? 'ja' : 'nein'})`);
  } catch (e) {
    logger.warn('syncGuildContent fehlgeschlagen:', { guildId: guild.id, e: String(e) });
  }
}

let contentSyncTimer: NodeJS.Timeout | null = null;

/**
 * Startet die periodische Auto-Sync-Schleife (60 min).
 * Initialer Sync laeuft sofort bei Start, weitere Laeufe alle 60 min.
 * Pro Lauf werden nur Guilds mit veraltetem Snapshot (> 50 min) verarbeitet.
 */
export function startContentSyncLoop(client: Client): void {
  if (contentSyncTimer) return;
  const tick = async () => {
    const guilds = Array.from(client.guilds.cache.values());
    const now = Date.now();
    for (const g of guilds) {
      try {
        const cached = cache.get(g.id)?.profile;
        const last = cached?.contentSyncedAt?.getTime() ?? 0;
        if (now - last < CONTENT_STALE_AFTER_MS) continue;
        await syncGuildContent(g);
      } catch (e) {
        logger.warn(`Content-Sync-Tick Guild ${g.id} fehlgeschlagen:`, { e: String(e) });
      }
    }
  };
  // Erstlauf nach 30s (gibt clientReady Zeit), dann periodisch.
  setTimeout(() => { void tick(); }, 30_000).unref?.();
  contentSyncTimer = setInterval(() => { void tick(); }, CONTENT_SYNC_INTERVAL_MS);
  contentSyncTimer.unref?.();
  logger.info('GuildAwareness: Content-Sync-Loop gestartet (alle 60 min).');
}

export function stopContentSyncLoop(): void {
  if (contentSyncTimer) {
    clearInterval(contentSyncTimer);
    contentSyncTimer = null;
  }
}
