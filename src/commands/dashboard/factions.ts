/**
 * Phase 3 — Faction-Commands (4 Stueck) inkl. Autocomplete.
 *
 * Fraktionen sind pro (Guild + Slot) angelegt. Lookup via Name (UNIQUE).
 * Beitritt respektiert `joinPolicy`: OPEN/REQUEST/CLOSED.
 */

import {
  SlashCommandBuilder, ChatInputCommandInteraction, AutocompleteInteraction, EmbedBuilder, MessageFlags, escapeMarkdown,
} from 'discord.js';
import type { Command } from '../../types';
import prisma from '../../database/prisma';
import { withGuildScope } from '../middleware/withGuildScope';
import { asGuildId } from '../../types/scope';
import { logAudit } from '../../utils/logger';
import { emitGuildEvent } from '../../dashboard/socket/emitter';
import { buildStatusEmbed, type EmbedStatus } from '../../utils/statusEmbed';

// Deutsche Statusbezeichnungen (§3.2) — nie rohe Enum-Werte anzeigen.
const FACTION_STATUS: Record<string, { label: string; emoji: string }> = {
  ACTIVE: { label: 'Aktiv', emoji: '🟢' },
  RECRUITING: { label: 'Rekrutiert', emoji: '🟡' },
  INACTIVE: { label: 'Inaktiv', emoji: '⚪' },
  ARCHIVED: { label: 'Archiviert', emoji: '⚫' },
};

function factionColor(hex: string | null | undefined): number {
  const m = hex ? /^#?([0-9a-fA-F]{6})$/.exec(hex.trim()) : null;
  return m ? parseInt(m[1], 16) : 0xdc2626; // Fallback dunkles Rot (§3.1)
}

async function statusReply(
  i: ChatInputCommandInteraction,
  status: EmbedStatus,
  title: string,
  opts: { description?: string; fields?: { name: string; value: string }[]; ephemeral?: boolean } = {},
): Promise<void> {
  const embed = buildStatusEmbed({ status, title, description: opts.description, fields: opts.fields, footerText: 'V-Bot • Fraktionssystem' });
  const ephemeral = opts.ephemeral ?? true;
  if (ephemeral) await i.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  else await i.reply({ embeds: [embed], allowedMentions: { parse: [] } });
}

/**
 * Autocomplete-Helper: liefert Fraktionsnamen, die dem Eingabe-Prefix
 * entsprechen — gescoped auf aktuelle Guild + active slot.
 */
async function autocompleteFactionNames(i: AutocompleteInteraction): Promise<void> {
  if (!i.guildId) { await i.respond([]); return; }
  let guildId;
  try { guildId = asGuildId(i.guildId); } catch { await i.respond([]); return; }
  const focused = i.options.getFocused().toString().slice(0, 60);
  const rows = await prisma.faction.findMany({
    where: {
      guildId, isActive: true,
      ...(focused ? { name: { startsWith: focused, mode: 'insensitive' as const } } : {}),
    },
    orderBy: { name: 'asc' }, take: 25, select: { name: true },
  });
  await i.respond(rows.map(r => ({ name: r.name, value: r.name })));
}

// ============================================================
// /faction <name> — Detailansicht
// ============================================================
export const factionCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('faction')
    .setDescription('Zeigt Details zu einer Fraktion.')
    .addStringOption(o => o.setName('name').setDescription('Fraktionsname').setRequired(true).setAutocomplete(true).setMaxLength(60)) as SlashCommandBuilder,
  autocomplete: autocompleteFactionNames,
  execute: withGuildScope({}, async (i, scope) => {
    const name = i.options.getString('name', true).trim();
    const f = await prisma.faction.findUnique({
      where: { guildId_name: { guildId: scope.guildId, name } },
      include: { _count: { select: { members: true } } },
    });
    if (!f) { await statusReply(i, 'ERROR', 'Fraktion nicht gefunden', { description: 'Die gewünschte Fraktion konnte nicht gefunden werden.' }); return; }
    const st = FACTION_STATUS[f.status] ?? FACTION_STATUS.ACTIVE;
    const e = new EmbedBuilder()
      .setAuthor({ name: `${i.guild?.name ?? 'Server'} • Fraktionsübersicht` })
      .setTitle(`🏴  ${f.name}`)
      .setColor(factionColor(f.color))
      .setFooter({ text: 'V-Bot • Fraktion' })
      .setTimestamp();
    if (f.leaderDiscordId) e.addFields({ name: '👑  Fraktionsführer', value: `<@${f.leaderDiscordId}>`, inline: false });
    if (f.deputyDiscordId) e.addFields({ name: '🛡️  Stellvertretung', value: `<@${f.deputyDiscordId}>`, inline: false });
    if (f.treasurerDiscordId) e.addFields({ name: '💰  Schatzmeister', value: `<@${f.treasurerDiscordId}>`, inline: false });
    e.addFields(
      { name: '👥  Mitglieder', value: String(f._count.members), inline: false },
      { name: `${st.emoji}  Status`, value: st.label, inline: false },
    );
    if (f.flagUrl && /^https?:\/\//i.test(f.flagUrl)) e.setThumbnail(f.flagUrl);
    if (f.bannerUrl && /^https?:\/\//i.test(f.bannerUrl)) e.setImage(f.bannerUrl);
    await i.reply({ embeds: [e], allowedMentions: { parse: [] } });
  }),
};

// ============================================================
// /factions — Liste
// ============================================================
export const factionsCommand: Command = {
  data: new SlashCommandBuilder().setName('factions').setDescription('Listet aktive Fraktionen.'),
  execute: withGuildScope({}, async (i, scope) => {
    const rows = await prisma.faction.findMany({
      where: { guildId: scope.guildId, isActive: true },
      orderBy: { name: 'asc' },
      include: { _count: { select: { members: true } } },
      take: 50,
    });
    if (rows.length === 0) { await statusReply(i, 'INFO', 'Keine Fraktionen vorhanden'); return; }
    const blocks = rows.map(r => {
      const st = FACTION_STATUS[r.status] ?? FACTION_STATUS.ACTIVE;
      return `${st.emoji}  **${escapeMarkdown(r.name)}**\n👥 ${r._count.members} Mitglieder`;
    }).join('\n\n');
    const e = new EmbedBuilder()
      .setTitle('🏴  Fraktionen')
      .setColor(0xdc2626)
      .setDescription(blocks.slice(0, 4000))
      .setFooter({ text: `V-Bot • ${rows.length} aktive Fraktionen` })
      .setTimestamp();
    await i.reply({ embeds: [e], allowedMentions: { parse: [] } });
  }),
};

// ============================================================
// /join <name>
// ============================================================
export const joinCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('join')
    .setDescription('Tritt einer Fraktion bei (oder stellt Anfrage).')
    .addStringOption(o => o.setName('name').setDescription('Fraktionsname').setRequired(true).setAutocomplete(true).setMaxLength(60)) as SlashCommandBuilder,
  autocomplete: autocompleteFactionNames,
  execute: withGuildScope({}, async (i, scope) => {
    const name = i.options.getString('name', true).trim();
    const f = await prisma.faction.findUnique({
      where: { guildId_name: { guildId: scope.guildId, name } },
    });
    if (!f || !f.isActive) { await statusReply(i, 'ERROR', 'Fraktion nicht gefunden', { description: 'Die gewünschte Fraktion konnte nicht gefunden werden oder ist inaktiv.' }); return; }
    if (f.joinPolicy === 'CLOSED') { await statusReply(i, 'ERROR', 'Fraktion geschlossen', { description: 'Diese Fraktion nimmt aktuell keine Beitritte an.' }); return; }

    // Existing membership in this guild?
    const existing = await prisma.factionMember.findFirst({
      where: {
        userDiscordId: scope.actorDiscordId,
        faction: { guildId: scope.guildId },
      },
    });
    if (existing) { await statusReply(i, 'ERROR', 'Bereits Mitglied', { description: 'Du bist bereits in einer Fraktion. Verlasse sie zuerst mit `/leave`.' }); return; }

    const role = f.joinPolicy === 'OPEN' ? 'MEMBER' : 'PENDING';
    await prisma.factionMember.create({
      data: { factionId: f.id, userDiscordId: scope.actorDiscordId, role },
    });
    logAudit('FACTION_JOIN', 'FACTION', { guildId: scope.guildId, factionId: f.id, user: scope.actorDiscordId, role });
    emitGuildEvent(scope.guildId, { type: 'faction.changed', payload: { guildId: scope.guildId, factionId: f.id } });
    if (role === 'MEMBER') {
      await statusReply(i, 'SUCCESS', 'Fraktion beigetreten', {
        description: `Du bist der Fraktion **${escapeMarkdown(f.name)}** beigetreten.`,
        fields: [{ name: '🏴 Fraktion', value: escapeMarkdown(f.name) }],
      });
    } else {
      await statusReply(i, 'INFO', 'Beitrittsanfrage gestellt', {
        description: `Deine Anfrage wurde an die Fraktion **${escapeMarkdown(f.name)}** übermittelt.`,
        fields: [
          { name: '🏴 Fraktion', value: escapeMarkdown(f.name) },
          { name: '📨 Status', value: 'Wartet auf Entscheidung' },
        ],
      });
    }
  }),
};

// ============================================================
// /leave
// ============================================================
export const leaveCommand: Command = {
  data: new SlashCommandBuilder().setName('leave').setDescription('Verlaesst deine aktuelle Fraktion (im aktiven Server).'),
  execute: withGuildScope({}, async (i, scope) => {
    const member = await prisma.factionMember.findFirst({
      where: {
        userDiscordId: scope.actorDiscordId,
        faction: { guildId: scope.guildId },
      },
      include: { faction: true },
    });
    if (!member) { await statusReply(i, 'ERROR', 'Keine Fraktion', { description: 'Du bist in keiner Fraktion.' }); return; }
    await prisma.factionMember.deleteMany({
      where: { id: member.id, faction: { guildId: scope.guildId } },
    });
    // Discord-Rolle entfernen, falls die Fraktion eine zugewiesene Rolle hat.
    if (member.faction.roleId && i.client) {
      const { removeFactionRole } = await import('../../modules/factions/factionEmbed.js');
      await removeFactionRole(i.client, scope.guildId, scope.actorDiscordId, member.faction.roleId).catch(() => {});
    }
    logAudit('FACTION_LEAVE', 'FACTION', { guildId: scope.guildId, factionId: member.factionId, user: scope.actorDiscordId });
    emitGuildEvent(scope.guildId, { type: 'faction.changed', payload: { guildId: scope.guildId, factionId: member.factionId } });
    await statusReply(i, 'SUCCESS', 'Fraktion verlassen', { description: `Du hast die Fraktion **${escapeMarkdown(member.faction.name)}** verlassen.` });
  }),
};
