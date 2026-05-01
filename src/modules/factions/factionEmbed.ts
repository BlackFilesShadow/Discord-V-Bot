/**
 * Faction-Embed-Push (analog zu modules/tickets/ticketSystem.ts).
 *
 * Verantwortlich fuer:
 *  - Auto-Publish des Fraktions-Embeds in `embedChannelId`
 *  - Auto-Update bei jeder Aenderung (Felder oder Mitgliederzahl)
 *  - Sauberes Entfernen beim Loeschen oder Channel-Wechsel
 *  - Speichert Discord-Message-ID in `Faction.embedMessageId`
 *
 * Mutex pro Faction-ID gegen parallele Posts (verhindert doppelte Embeds).
 */

import {
  AttachmentBuilder,
  EmbedBuilder,
  type Client,
  type GuildTextBasedChannel,
} from 'discord.js';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import prisma from '../../database/prisma';
import { logAudit, logger } from '../../utils/logger';

const postLocks = new Map<string, Promise<unknown>>();

const UPLOADS_BASE = path.resolve(process.cwd(), 'uploads', 'factions');

const STATUS_LABELS: Record<string, { label: string; emoji: string }> = {
  ACTIVE: { label: 'Aktiv', emoji: '🟢' },
  RECRUITING: { label: 'Rekrutiert', emoji: '🟡' },
  INACTIVE: { label: 'Inaktiv', emoji: '⚪' },
  ARCHIVED: { label: 'Archiviert', emoji: '⚫' },
};

const POLICY_LABELS: Record<string, string> = {
  OPEN: '🔓 Offen — direkter Beitritt',
  REQUEST: '✋ Bewerbung erforderlich',
  CLOSED: '🔒 Geschlossen — nur Einladung',
};

function parseColor(hex: string | null | undefined, fallback = 0xdc2626): number {
  if (!hex) return fallback;
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return fallback;
  return parseInt(m[1], 16);
}

interface FactionEmbedData {
  id: string;
  guildId: string;
  nitradoConnId: string;
  name: string;
  description: string | null;
  color: string | null;
  flagUrl: string | null;
  bannerUrl: string | null;
  leaderDiscordId: string | null;
  deputyDiscordId: string | null;
  treasurerDiscordId: string | null;
  status: string;
  joinPolicy: string;
  isActive: boolean;
  embedChannelId: string | null;
  embedMessageId: string | null;
  createdAt: Date;
  memberCount: number;
}

function buildEmbed(f: FactionEmbedData, attachmentNames: { flag?: string; banner?: string }): EmbedBuilder {
  const status = STATUS_LABELS[f.status] ?? STATUS_LABELS.ACTIVE;
  const policy = POLICY_LABELS[f.joinPolicy] ?? POLICY_LABELS.REQUEST;
  const created = `<t:${Math.floor(f.createdAt.getTime() / 1000)}:D>`;

  const e = new EmbedBuilder()
    .setAuthor({ name: 'V-BOT  •  FRAKTION' })
    .setTitle(`🏴  ${f.name}`)
    .setColor(parseColor(f.color))
    .setDescription(
      (f.description?.trim().slice(0, 1900))
      || '_Keine Beschreibung hinterlegt._',
    )
    .addFields(
      { name: '👑  Leitung',        value: f.leaderDiscordId    ? `<@${f.leaderDiscordId}>`    : '_offen_', inline: true },
      { name: '🛡️  Stellvertretung', value: f.deputyDiscordId    ? `<@${f.deputyDiscordId}>`    : '_offen_', inline: true },
      { name: '💰  Schatzmeister',   value: f.treasurerDiscordId ? `<@${f.treasurerDiscordId}>` : '_offen_', inline: true },
      { name: '👥  Mitglieder',      value: String(f.memberCount), inline: true },
      { name: `${status.emoji}  Status`, value: status.label,    inline: true },
      { name: '📨  Bewerbung',       value: policy,                inline: true },
      { name: '📅  Gegruendet',      value: created,               inline: false },
    )
    .setFooter({ text: 'High-End Faction-System  •  V-Bot' });

  if (attachmentNames.flag) e.setThumbnail(`attachment://${attachmentNames.flag}`);
  else if (f.flagUrl && /^https?:\/\//i.test(f.flagUrl)) e.setThumbnail(f.flagUrl);

  if (attachmentNames.banner) e.setImage(`attachment://${attachmentNames.banner}`);
  else if (f.bannerUrl && /^https?:\/\//i.test(f.bannerUrl)) e.setImage(f.bannerUrl);

  return e;
}

/**
 * Lokale Upload-Pfade (`/uploads/factions/...`) als Discord-Attachment einbinden,
 * damit das Embed auch bei nicht oeffentlich erreichbarem Bot funktioniert.
 */
async function buildAttachments(f: FactionEmbedData): Promise<{
  files: AttachmentBuilder[];
  names: { flag?: string; banner?: string };
}> {
  const files: AttachmentBuilder[] = [];
  const names: { flag?: string; banner?: string } = {};

  for (const kind of ['flag', 'banner'] as const) {
    const url = kind === 'flag' ? f.flagUrl : f.bannerUrl;
    if (!url || !url.startsWith('/uploads/factions/')) continue;
    const rel = url.replace(/^\//, '');
    const full = path.resolve(process.cwd(), rel);
    if (!full.startsWith(UPLOADS_BASE)) continue; // Path-Traversal-Schutz
    try {
      const buf = await fs.readFile(full);
      const filename = path.basename(full);
      files.push(new AttachmentBuilder(buf, { name: filename }));
      names[kind] = filename;
    } catch (e) {
      logger.warn(`Faction-Asset (${kind}) nicht ladbar: ${(e as Error).message}`);
    }
  }
  return { files, names };
}

async function loadFaction(factionId: string): Promise<FactionEmbedData | null> {
  // eslint-disable-next-line local/no-unscoped-prisma-query -- Modul wird nur intern aus geprueften Routen aufgerufen.
  const f = await prisma.faction.findUnique({
    where: { id: factionId },
    include: { _count: { select: { members: true } } },
  });
  if (!f) return null;
  return {
    id: f.id,
    guildId: f.guildId,
    nitradoConnId: f.nitradoConnId,
    name: f.name,
    description: f.description,
    color: f.color,
    flagUrl: f.flagUrl,
    bannerUrl: f.bannerUrl,
    leaderDiscordId: f.leaderDiscordId,
    deputyDiscordId: f.deputyDiscordId,
    treasurerDiscordId: f.treasurerDiscordId,
    status: f.status,
    joinPolicy: f.joinPolicy,
    isActive: f.isActive,
    embedChannelId: f.embedChannelId,
    embedMessageId: f.embedMessageId,
    createdAt: f.createdAt,
    memberCount: f._count.members,
  };
}

/**
 * Postet (oder aktualisiert) das Fraktions-Embed im konfigurierten Kanal.
 * - Wirft Error wenn `embedChannelId` fehlt oder Channel nicht erreichbar.
 * - Speichert die zurueckgelieferte Message-ID in `embedMessageId`.
 * - Mutex pro Faction-ID gegen parallele Aufrufe.
 */
export async function postFactionEmbed(client: Client, factionId: string): Promise<{ messageId: string; updated: boolean }> {
  const prev = postLocks.get(factionId);
  if (prev) { try { await prev; } catch { /* ignore */ } }

  const run = (async (): Promise<{ messageId: string; updated: boolean }> => {
    const f = await loadFaction(factionId);
    if (!f) throw new Error('Fraktion nicht gefunden.');

    // Effektiver Channel: Faction-spezifisch ODER System-Sammelkanal als Fallback.
    let targetChannelId = f.embedChannelId;
    if (!targetChannelId) {
       
      const cfg = await prisma.factionSystemConfig.findUnique({
        where: { guildId_nitradoConnId: { guildId: f.guildId, nitradoConnId: f.nitradoConnId } },
        select: { factionChannelId: true },
      });
      targetChannelId = cfg?.factionChannelId ?? null;
    }
    if (!targetChannelId) throw new Error('Kein Embed-Channel konfiguriert (weder Faction- noch System-Channel).');

    const channel = await client.channels.fetch(targetChannelId).catch(() => null);
    if (!channel || !channel.isTextBased() || channel.isDMBased()) {
      throw new Error('Embed-Channel nicht verfuegbar oder kein Text-Channel.');
    }
    const tch = channel as GuildTextBasedChannel;
    if (tch.guildId !== f.guildId) {
      throw new Error('Embed-Channel gehoert nicht zur richtigen Guild.');
    }

    const { files, names } = await buildAttachments(f);
    const embed = buildEmbed(f, names);

    let messageId = f.embedMessageId;
    let updated = false;
    if (messageId) {
      try {
        const existing = await tch.messages.fetch(messageId);
        await existing.edit({ embeds: [embed], components: [], files, attachments: [] });
        updated = true;
      } catch {
        messageId = null;
      }
    }
    if (!messageId) {
      const sent = await tch.send({ embeds: [embed], files, allowedMentions: { parse: [] } });
      messageId = sent.id;
    }

    // eslint-disable-next-line local/no-unscoped-prisma-query -- f.id stammt aus loadFaction (interne ID).
    await prisma.faction.update({
      where: { id: f.id },
      data: { embedMessageId: messageId },
    });

    logAudit(updated ? 'FACTION_EMBED_UPDATED' : 'FACTION_EMBED_POSTED', 'FACTION', {
      guildId: f.guildId, factionId: f.id, channelId: targetChannelId, messageId,
    });

    return { messageId, updated };
  })();

  postLocks.set(factionId, run);
  try {
    return await run;
  } finally {
    if (postLocks.get(factionId) === run) postLocks.delete(factionId);
  }
}

/**
 * Loescht das gepostete Fraktions-Embed. Idempotent.
 * Nullt `embedMessageId` in jedem Fall.
 */
export async function unpostFactionEmbed(client: Client, factionId: string): Promise<void> {
  // eslint-disable-next-line local/no-unscoped-prisma-query -- Modul wird nur intern aus geprueften Routen aufgerufen.
  const f = await prisma.faction.findUnique({
    where: { id: factionId },
    select: { id: true, guildId: true, nitradoConnId: true, embedChannelId: true, embedMessageId: true },
  });
  if (!f || !f.embedMessageId) {
    if (f && f.embedMessageId) {
      // eslint-disable-next-line local/no-unscoped-prisma-query -- f.id intern verifiziert.
      await prisma.faction.update({ where: { id: f.id }, data: { embedMessageId: null } }).catch(() => {});
    }
    return;
  }
  // Effektiver Channel: Faction-spezifisch ODER System-Sammelkanal als Fallback.
  let targetChannelId = f.embedChannelId;
  if (!targetChannelId) {
     
    const cfg = await prisma.factionSystemConfig.findUnique({
      where: { guildId_nitradoConnId: { guildId: f.guildId, nitradoConnId: f.nitradoConnId } },
      select: { factionChannelId: true },
    });
    targetChannelId = cfg?.factionChannelId ?? null;
  }
  try {
    if (targetChannelId) {
      const channel = await client.channels.fetch(targetChannelId).catch(() => null);
      if (channel && channel.isTextBased() && !channel.isDMBased()) {
        const msg = await (channel as GuildTextBasedChannel).messages.fetch(f.embedMessageId).catch(() => null);
        if (msg) await msg.delete().catch(() => {});
      }
    }
  } catch (e) {
    logger.warn(`unpostFactionEmbed ${f.id}: ${(e as Error).message}`);
  } finally {
    // eslint-disable-next-line local/no-unscoped-prisma-query -- f.id intern verifiziert.
    await prisma.faction.update({ where: { id: f.id }, data: { embedMessageId: null } }).catch(() => {});
    logAudit('FACTION_EMBED_UNPOSTED', 'FACTION', {
      guildId: f.guildId, factionId: f.id, channelId: targetChannelId,
    });
  }
}

// ============================================================================
// Uebersichts-Liste aller Fraktionen pro Slot (FactionSystemConfig)
// ============================================================================

const listLocks = new Map<string, Promise<unknown>>();

function listKey(guildId: string, nitradoConnId: string): string {
  return `${guildId}:${nitradoConnId}`;
}

function buildListEmbed(factions: Array<{
  name: string;
  status: string;
  joinPolicy: string;
  memberCount: number;
  color: string | null;
  leaderDiscordId: string | null;
}>): EmbedBuilder {
  const e = new EmbedBuilder()
    .setAuthor({ name: 'V-BOT  •  FRAKTIONS-UEBERSICHT' })
    .setTitle(`🏛️  Aktive Fraktionen  (${factions.length})`)
    .setColor(0xdc2626)
    .setFooter({ text: 'Automatische Liste  •  V-Bot Faction-System' })
    .setTimestamp(new Date());

  if (factions.length === 0) {
    e.setDescription('_Aktuell sind keine Fraktionen angelegt._');
    return e;
  }

  const lines: string[] = [];
  for (const f of factions) {
    const st = STATUS_LABELS[f.status] ?? STATUS_LABELS.ACTIVE;
    const policy = f.joinPolicy === 'OPEN' ? '🔓' : f.joinPolicy === 'CLOSED' ? '🔒' : '✋';
    const leader = f.leaderDiscordId ? ` — Leitung <@${f.leaderDiscordId}>` : '';
    lines.push(`${st.emoji}  **${f.name}**  ${policy}  · ${f.memberCount} Mitglieder${leader}`);
  }
  e.setDescription(lines.join('\n').slice(0, 4000));
  return e;
}

/**
 * Postet (oder aktualisiert) eine Uebersichts-Liste aller Fraktionen
 * eines Slots im konfigurierten `factionChannelId`. Mutex pro Slot.
 * Idempotent. No-op falls keine Config oder kein Channel.
 */
export async function postFactionList(client: Client, guildId: string, nitradoConnId: string): Promise<void> {
  const key = listKey(guildId, nitradoConnId);
  const prev = listLocks.get(key);
  if (prev) { try { await prev; } catch { /* ignore */ } }

  const run = (async (): Promise<void> => {
     
    const cfg = await prisma.factionSystemConfig.findUnique({
      where: { guildId_nitradoConnId: { guildId, nitradoConnId } },
    });
    if (!cfg || !cfg.factionChannelId) return;

    const channel = await client.channels.fetch(cfg.factionChannelId).catch(() => null);
    if (!channel || !channel.isTextBased() || channel.isDMBased()) {
      logger.warn(`postFactionList: Channel ${cfg.factionChannelId} nicht verfuegbar`);
      return;
    }
    const tch = channel as GuildTextBasedChannel;
    if (tch.guildId !== guildId) return;

     
    const factions = await prisma.faction.findMany({
      where: { guildId, nitradoConnId },
      include: { _count: { select: { members: true } } },
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
    });

    const embed = buildListEmbed(factions.map(f => ({
      name: f.name,
      status: f.status,
      joinPolicy: f.joinPolicy,
      memberCount: f._count.members,
      color: f.color,
      leaderDiscordId: f.leaderDiscordId,
    })));

    let messageId = cfg.listMessageId;
    if (messageId) {
      try {
        const existing = await tch.messages.fetch(messageId);
        await existing.edit({ embeds: [embed] });
      } catch {
        messageId = null;
      }
    }
    if (!messageId) {
      const sent = await tch.send({ embeds: [embed], allowedMentions: { parse: [] } });
      messageId = sent.id;
       
      await prisma.factionSystemConfig.update({
        where: { id: cfg.id },
        data: { listMessageId: messageId },
      });
    }

    logAudit('FACTION_LIST_REFRESHED', 'FACTION', {
      guildId, nitradoConnId, channelId: cfg.factionChannelId, messageId, count: factions.length,
    });
  })();

  listLocks.set(key, run);
  try {
    await run;
  } finally {
    if (listLocks.get(key) === run) listLocks.delete(key);
  }
}

/**
 * Loescht das Uebersichts-Embed (z.B. vor Channel-Wechsel). Idempotent.
 */
export async function unpostFactionList(client: Client, guildId: string, nitradoConnId: string): Promise<void> {
   
  const cfg = await prisma.factionSystemConfig.findUnique({
    where: { guildId_nitradoConnId: { guildId, nitradoConnId } },
  });
  if (!cfg || !cfg.factionChannelId || !cfg.listMessageId) {
    if (cfg && cfg.listMessageId) {
       
      await prisma.factionSystemConfig.update({ where: { id: cfg.id }, data: { listMessageId: null } }).catch(() => {});
    }
    return;
  }
  try {
    const channel = await client.channels.fetch(cfg.factionChannelId).catch(() => null);
    if (channel && channel.isTextBased() && !channel.isDMBased()) {
      const msg = await (channel as GuildTextBasedChannel).messages.fetch(cfg.listMessageId).catch(() => null);
      if (msg) await msg.delete().catch(() => {});
    }
  } finally {
     
    await prisma.factionSystemConfig.update({ where: { id: cfg.id }, data: { listMessageId: null } }).catch(() => {});
    logAudit('FACTION_LIST_UNPOSTED', 'FACTION', {
      guildId, nitradoConnId, channelId: cfg.factionChannelId,
    });
  }
}
