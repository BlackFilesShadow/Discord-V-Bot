/**
 * Phase 3 — Faction-Commands (4 Stueck) inkl. Autocomplete.
 *
 * Fraktionen sind pro (Guild + Slot) angelegt. Lookup via Name (UNIQUE).
 * Beitritt respektiert `joinPolicy`: OPEN/REQUEST/CLOSED.
 */

import {
  SlashCommandBuilder, ChatInputCommandInteraction, AutocompleteInteraction, EmbedBuilder, MessageFlags,
} from 'discord.js';
import type { Command } from '../../types';
import prisma from '../../database/prisma';
import { withGuildScope } from '../middleware/withGuildScope';
import { asGuildId } from '../../types/scope';
import { logAudit } from '../../utils/logger';
import { emitGuildEvent } from '../../dashboard/socket/emitter';

async function reply(i: ChatInputCommandInteraction, content: string, ephemeral = true): Promise<void> {
  if (ephemeral) await i.reply({ content, flags: MessageFlags.Ephemeral });
  else await i.reply({ content });
}

/**
 * Autocomplete-Helper: liefert Fraktionsnamen, die dem Eingabe-Prefix
 * entsprechen — gescoped auf aktuelle Guild + active slot.
 */
async function autocompleteFactionNames(i: AutocompleteInteraction): Promise<void> {
  if (!i.guildId) { await i.respond([]); return; }
  let guildId;
  try { guildId = asGuildId(i.guildId); } catch { await i.respond([]); return; }
  const slot = await prisma.nitradoConnection.findFirst({
    where: { guildId, status: 'ACTIVE' }, orderBy: { slot: 'asc' }, select: { id: true },
  });
  if (!slot) { await i.respond([]); return; }
  const focused = i.options.getFocused().toString().slice(0, 60);
  const rows = await prisma.faction.findMany({
    where: {
      guildId, nitradoConnId: slot.id, isActive: true,
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
      where: { guildId_nitradoConnId_name: { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId!, name } },
      include: { _count: { select: { members: true } } },
    });
    if (!f) { await reply(i, 'Fraktion nicht gefunden.'); return; }
    const e = new EmbedBuilder()
      .setTitle(f.name)
      .addFields(
        { name: 'Leader', value: f.leaderDiscordId ? `<@${f.leaderDiscordId}>` : '_offen_', inline: true },
        { name: 'Treasurer', value: f.treasurerDiscordId ? `<@${f.treasurerDiscordId}>` : '_offen_', inline: true },
        { name: 'Mitglieder', value: String(f._count.members), inline: true },
        { name: 'Beitritt', value: f.joinPolicy, inline: true },
      );
    if (f.flagUrl && /^https?:\/\//i.test(f.flagUrl)) e.setThumbnail(f.flagUrl);
    if (f.bannerUrl && /^https?:\/\//i.test(f.bannerUrl)) e.setImage(f.bannerUrl);
    await i.reply({ embeds: [e] });
  }),
};

// ============================================================
// /factions — Liste
// ============================================================
export const factionsCommand: Command = {
  data: new SlashCommandBuilder().setName('factions').setDescription('Listet aktive Fraktionen.'),
  execute: withGuildScope({}, async (i, scope) => {
    const rows = await prisma.faction.findMany({
      where: { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId!, isActive: true },
      orderBy: { name: 'asc' },
      include: { _count: { select: { members: true } } },
      take: 50,
    });
    if (rows.length === 0) { await reply(i, '_keine Fraktionen_'); return; }
    const lines = rows.map(r => `**${r.name}** — ${r._count.members} Mitglieder (${r.joinPolicy})`).join('\n');
    const e = new EmbedBuilder().setTitle(`Fraktionen (${rows.length})`).setDescription(lines.slice(0, 4000));
    await i.reply({ embeds: [e] });
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
      where: { guildId_nitradoConnId_name: { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId!, name } },
    });
    if (!f || !f.isActive) { await reply(i, 'Fraktion nicht gefunden oder inaktiv.'); return; }
    if (f.joinPolicy === 'CLOSED') { await reply(i, 'Diese Fraktion ist geschlossen.'); return; }

    // Existing membership in this guild?
    const existing = await prisma.factionMember.findFirst({
      where: {
        userDiscordId: scope.actorDiscordId,
        faction: { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId! },
      },
    });
    if (existing) { await reply(i, 'Du bist bereits in einer Fraktion. `/leave` zuerst.'); return; }

    const role = f.joinPolicy === 'OPEN' ? 'MEMBER' : 'PENDING';
    await prisma.factionMember.create({
      data: { factionId: f.id, userDiscordId: scope.actorDiscordId, role },
    });
    logAudit('FACTION_JOIN', 'FACTION', { guildId: scope.guildId, factionId: f.id, user: scope.actorDiscordId, role });
    emitGuildEvent(scope.guildId, { type: 'faction.changed', payload: { guildId: scope.guildId, factionId: f.id } });
    await reply(i, role === 'MEMBER' ? `Du bist **${f.name}** beigetreten.` : `Anfrage gestellt fuer **${f.name}**.`);
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
        faction: { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId! },
      },
      include: { faction: true },
    });
    if (!member) { await reply(i, 'Du bist in keiner Fraktion.'); return; }
    await prisma.factionMember.deleteMany({
      where: { id: member.id, faction: { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId! } },
    });
    // Discord-Rolle entfernen, falls die Fraktion eine zugewiesene Rolle hat.
    if (member.faction.roleId && i.client) {
      const { removeFactionRole } = await import('../../modules/factions/factionEmbed.js');
      await removeFactionRole(i.client, scope.guildId, scope.actorDiscordId, member.faction.roleId).catch(() => {});
    }
    logAudit('FACTION_LEAVE', 'FACTION', { guildId: scope.guildId, factionId: member.factionId, user: scope.actorDiscordId });
    emitGuildEvent(scope.guildId, { type: 'faction.changed', payload: { guildId: scope.guildId, factionId: member.factionId } });
    await reply(i, `Du hast **${member.faction.name}** verlassen.`);
  }),
};
