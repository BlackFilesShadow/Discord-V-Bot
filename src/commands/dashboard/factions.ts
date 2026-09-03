/**
 * Faction-Commands (4 Stueck) inkl. Autocomplete.
 *
 * Fraktionen sind seit der Discord-only-Migration guildweit und NICHT an einen
 * Nitrado-Slot gebunden. Deshalb laufen alle Commands mit `guildOnly: true`.
 *
 * Join-Invarianten:
 * - pro Guild darf ein Discord-User nur in genau einer Fraktion sein;
 * - parallele /join-Aufrufe desselben Users werden per PostgreSQL Advisory-
 *   Transaction-Lock serialisiert;
 * - OPEN erzeugt MEMBER, REQUEST erzeugt PENDING, CLOSED blockiert;
 * - konfigurierte Fraktionsrolle wird nach erfolgreichem OPEN-Join synchronisiert.
 */

import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type AutocompleteInteraction,
  EmbedBuilder,
  MessageFlags,
  escapeMarkdown,
} from 'discord.js';
import type { Command } from '../../types';
import prisma from '../../database/prisma';
import { withGuildScope } from '../middleware/withGuildScope';
import { asGuildId } from '../../types/scope';
import { logAudit, logger } from '../../utils/logger';
import { emitGuildEvent } from '../../dashboard/socket/emitter';
import { buildStatusEmbed, type EmbedStatus } from '../../utils/statusEmbed';
import { vEmbed } from '../../utils/embedDesign';
import { assignFactionRole, postFactionEmbed, postFactionList, removeFactionRole } from '../../modules/factions/factionEmbed';

const FACTION_STATUS: Record<string, { label: string; emoji: string }> = {
  ACTIVE: { label: 'Aktiv', emoji: '🟢' },
  RECRUITING: { label: 'Rekrutiert', emoji: '🟡' },
  INACTIVE: { label: 'Inaktiv', emoji: '⚪' },
  ARCHIVED: { label: 'Archiviert', emoji: '⚫' },
};

function factionColor(hex: string | null | undefined): number {
  const m = hex ? /^#?([0-9a-fA-F]{6})$/.exec(hex.trim()) : null;
  return m ? parseInt(m[1], 16) : 0xdc2626;
}

/**
 * Die Slash-Commands aendern Mitgliedschaften direkt. Falls die dauerhafte
 * Fraktionspraesentation konfiguriert ist, muss sie denselben Datenstand ohne
 * Einfluss auf die zeitkritische Command-Antwort spiegeln.
 */
function refreshPersistentFactionEmbeds(
  client: ChatInputCommandInteraction['client'],
  guildId: string,
  factionId: string,
): void {
  void postFactionEmbed(client, factionId).catch(error => {
    logger.debug(`Faction-Embed nach Mitgliedschaftswechsel nicht aktualisiert (${factionId}): ${(error as Error).message}`);
  });
  void postFactionList(client, guildId).catch(error => {
    logger.debug(`Faction-Liste nach Mitgliedschaftswechsel nicht aktualisiert (${guildId}): ${(error as Error).message}`);
  });
}

async function statusReply(
  interaction: ChatInputCommandInteraction,
  status: EmbedStatus,
  title: string,
  opts: { description?: string; fields?: { name: string; value: string }[]; ephemeral?: boolean } = {},
): Promise<void> {
  const embed = buildStatusEmbed({
    status,
    title,
    description: opts.description,
    fields: opts.fields,
    footerText: 'V-Bot • Fraktionssystem',
  });
  const ephemeral = opts.ephemeral ?? true;
  if (ephemeral) {
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  } else {
    await interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
  }
}

async function autocompleteFactionNames(interaction: AutocompleteInteraction): Promise<void> {
  if (!interaction.guildId) { await interaction.respond([]); return; }
  let guildId;
  try { guildId = asGuildId(interaction.guildId); } catch { await interaction.respond([]); return; }
  const focused = interaction.options.getFocused().toString().slice(0, 60);
  const rows = await prisma.faction.findMany({
    where: {
      guildId,
      isActive: true,
      ...(focused ? { name: { startsWith: focused, mode: 'insensitive' as const } } : {}),
    },
    orderBy: { name: 'asc' },
    take: 25,
    select: { name: true },
  });
  await interaction.respond(rows.map(row => ({ name: row.name, value: row.name })));
}

export const factionCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('faction')
    .setDescription('Zeigt Details zu einer Fraktion dieses Discord-Servers.')
    .addStringOption(option => option
      .setName('name')
      .setDescription('Fraktionsname')
      .setRequired(true)
      .setAutocomplete(true)
      .setMaxLength(60)) as SlashCommandBuilder,
  autocomplete: autocompleteFactionNames,
  execute: withGuildScope({ guildOnly: true }, async (interaction, scope) => {
    const name = interaction.options.getString('name', true).trim();
    const faction = await prisma.faction.findUnique({
      where: { guildId_name: { guildId: scope.guildId, name } },
      include: { _count: { select: { members: true } } },
    });
    if (!faction) {
      await statusReply(interaction, 'ERROR', 'Fraktion nicht gefunden', { description: 'Die gewuenschte Fraktion konnte auf diesem Discord-Server nicht gefunden werden.' });
      return;
    }

    const status = FACTION_STATUS[faction.status] ?? FACTION_STATUS.ACTIVE;
    const embed = vEmbed(factionColor(faction.color))
      .setAuthor({ name: `${interaction.guild?.name ?? 'Server'} • Fraktionsuebersicht` })
      .setTitle(`🏴 ${faction.name}`)
      .setFooter({ text: 'V-Bot • Fraktion' })
      .setTimestamp();
    if (faction.description) embed.setDescription(faction.description.slice(0, 1500));
    if (faction.leaderDiscordId) embed.addFields({ name: '👑 Fraktionsfuehrer', value: `<@${faction.leaderDiscordId}>`, inline: false });
    if (faction.deputyDiscordId) embed.addFields({ name: '🛡️ Stellvertretung', value: `<@${faction.deputyDiscordId}>`, inline: false });
    if (faction.treasurerDiscordId) embed.addFields({ name: '💰 Schatzmeister', value: `<@${faction.treasurerDiscordId}>`, inline: false });
    embed.addFields(
      { name: '👥 Mitglieder', value: String(faction._count.members), inline: false },
      { name: `${status.emoji} Status`, value: status.label, inline: false },
    );
    if (faction.roleId) embed.addFields({ name: '🏷️ Fraktionsrolle', value: `<@&${faction.roleId}>`, inline: false });
    if (faction.flagUrl && /^https?:\/\//i.test(faction.flagUrl)) embed.setThumbnail(faction.flagUrl);
    if (faction.bannerUrl && /^https?:\/\//i.test(faction.bannerUrl)) embed.setImage(faction.bannerUrl);
    await interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
  }),
};

export const factionsCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('factions')
    .setDescription('Listet alle aktiven Fraktionen dieses Discord-Servers.'),
  execute: withGuildScope({ guildOnly: true }, async (interaction, scope) => {
    const rows = await prisma.faction.findMany({
      where: { guildId: scope.guildId, isActive: true },
      orderBy: { name: 'asc' },
      include: { _count: { select: { members: true } } },
    });
    if (rows.length === 0) {
      await statusReply(interaction, 'INFO', 'Keine Fraktionen vorhanden', { description: 'Auf diesem Discord-Server sind keine aktiven Fraktionen angelegt.' });
      return;
    }

    const embeds: EmbedBuilder[] = [];
    const PAGE_SIZE = 20;
    for (let offset = 0; offset < rows.length; offset += PAGE_SIZE) {
      const page = rows.slice(offset, offset + PAGE_SIZE);
      const pageNo = Math.floor(offset / PAGE_SIZE) + 1;
      const pageCount = Math.ceil(rows.length / PAGE_SIZE);
      const blocks = page.map(row => {
        const status = FACTION_STATUS[row.status] ?? FACTION_STATUS.ACTIVE;
        return `${status.emoji} **${escapeMarkdown(row.name)}**\n👥 ${row._count.members} Mitglieder`;
      }).join('\n\n');
      embeds.push(vEmbed(0xdc2626)
        .setTitle(`🏴 Fraktionen${pageCount > 1 ? ` · ${pageNo}/${pageCount}` : ''}`)
        .setDescription(blocks)
        .setFooter({ text: `V-Bot • ${rows.length} aktive Fraktionen` })
        .setTimestamp());
    }

    for (let index = 0; index < embeds.length; index += 10) {
      const chunk = embeds.slice(index, index + 10);
      if (index === 0) {
        await interaction.reply({ embeds: chunk, allowedMentions: { parse: [] } });
      } else {
        await interaction.followUp({ embeds: chunk, allowedMentions: { parse: [] } });
      }
    }
  }),
};

type JoinResult =
  | { kind: 'NOT_FOUND' }
  | { kind: 'CLOSED'; factionName: string }
  | { kind: 'ALREADY'; factionName: string }
  | { kind: 'JOINED'; factionId: string; factionName: string; role: 'MEMBER' | 'PENDING'; roleId: string | null };

async function joinFactionAtomic(guildId: string, userDiscordId: string, name: string): Promise<JoinResult> {
  return prisma.$transaction(async tx => {
    // Serialisiert alle Join-Versuche desselben Users in derselben Guild, auch
    // wenn zwei verschiedene Fraktionen gleichzeitig angefragt werden.
    await tx.$queryRawUnsafe(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      guildId,
      userDiscordId,
    );

    const faction = await tx.faction.findUnique({
      where: { guildId_name: { guildId, name } },
    });
    if (!faction || !faction.isActive) return { kind: 'NOT_FOUND' } as const;
    if (faction.joinPolicy === 'CLOSED') return { kind: 'CLOSED', factionName: faction.name } as const;

    const existing = await tx.factionMember.findFirst({
      where: {
        userDiscordId,
        faction: { guildId },
      },
      include: { faction: { select: { name: true } } },
    });
    if (existing) return { kind: 'ALREADY', factionName: existing.faction.name } as const;

    const role = faction.joinPolicy === 'OPEN' ? 'MEMBER' : 'PENDING';
    await tx.factionMember.create({ data: { factionId: faction.id, userDiscordId, role } });
    return {
      kind: 'JOINED',
      factionId: faction.id,
      factionName: faction.name,
      role,
      roleId: faction.roleId,
    } as const;
  });
}

export const joinCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('join')
    .setDescription('Tritt einer Fraktion bei oder stellt eine Beitrittsanfrage.')
    .addStringOption(option => option
      .setName('name')
      .setDescription('Fraktionsname')
      .setRequired(true)
      .setAutocomplete(true)
      .setMaxLength(60)) as SlashCommandBuilder,
  autocomplete: autocompleteFactionNames,
  execute: withGuildScope({ guildOnly: true }, async (interaction, scope) => {
    const name = interaction.options.getString('name', true).trim();
    const result = await joinFactionAtomic(String(scope.guildId), String(scope.actorDiscordId), name);

    if (result.kind === 'NOT_FOUND') {
      await statusReply(interaction, 'ERROR', 'Fraktion nicht gefunden', { description: 'Die gewuenschte Fraktion konnte nicht gefunden werden oder ist inaktiv.' });
      return;
    }
    if (result.kind === 'CLOSED') {
      await statusReply(interaction, 'ERROR', 'Fraktion geschlossen', { description: `**${escapeMarkdown(result.factionName)}** nimmt aktuell keine Beitritte an.` });
      return;
    }
    if (result.kind === 'ALREADY') {
      await statusReply(interaction, 'ERROR', 'Bereits Mitglied', { description: `Du bist bereits in **${escapeMarkdown(result.factionName)}**. Verlasse diese Fraktion zuerst mit \`/leave\`.` });
      return;
    }

    let roleSynced = true;
    if (result.role === 'MEMBER' && result.roleId) {
      try {
        await assignFactionRole(interaction.client, String(scope.guildId), String(scope.actorDiscordId), result.roleId);
      } catch (error) {
        roleSynced = false;
        logger.warn(`Faction-Role-Sync nach /join fehlgeschlagen: ${(error as Error).message}`);
        logAudit('FACTION_ROLE_SYNC_FAILED', 'FACTION', {
          guildId: scope.guildId,
          factionId: result.factionId,
          user: scope.actorDiscordId,
          roleId: result.roleId,
          operation: 'ADD',
        });
      }
    }

    logAudit('FACTION_JOIN', 'FACTION', {
      guildId: scope.guildId,
      factionId: result.factionId,
      user: scope.actorDiscordId,
      role: result.role,
      roleSynced,
    });
    refreshPersistentFactionEmbeds(interaction.client, String(scope.guildId), result.factionId);
    emitGuildEvent(scope.guildId, { type: 'faction.changed', payload: { guildId: scope.guildId, factionId: result.factionId } });

    if (result.role === 'MEMBER') {
      await statusReply(interaction, roleSynced ? 'SUCCESS' : 'INFO', roleSynced ? 'Fraktion beigetreten' : 'Beitritt gespeichert, Rollen-Sync offen', {
        description: roleSynced
          ? `Du bist der Fraktion **${escapeMarkdown(result.factionName)}** beigetreten.`
          : `Deine Mitgliedschaft in **${escapeMarkdown(result.factionName)}** ist gespeichert, aber die konfigurierte Discord-Rolle konnte nicht synchronisiert werden. Ein Admin sollte die Rollenberechtigung des Bots pruefen.`,
      });
    } else {
      await statusReply(interaction, 'INFO', 'Beitrittsanfrage gestellt', {
        description: `Deine Anfrage wurde fuer **${escapeMarkdown(result.factionName)}** gespeichert.`,
        fields: [{ name: '📨 Status', value: 'Wartet auf Entscheidung' }],
      });
    }
  }),
};

export const leaveCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Verlaesst deine aktuelle Fraktion auf diesem Discord-Server.'),
  execute: withGuildScope({ guildOnly: true }, async (interaction, scope) => {
    const member = await prisma.factionMember.findFirst({
      where: {
        userDiscordId: scope.actorDiscordId,
        faction: { guildId: scope.guildId },
      },
      include: { faction: true },
    });
    if (!member) {
      await statusReply(interaction, 'ERROR', 'Keine Fraktion', { description: 'Du bist auf diesem Discord-Server in keiner Fraktion.' });
      return;
    }

    const deleted = await prisma.factionMember.deleteMany({
      where: { id: member.id, userDiscordId: scope.actorDiscordId, faction: { guildId: scope.guildId } },
    });
    if (deleted.count !== 1) {
      await statusReply(interaction, 'INFO', 'Mitgliedschaft bereits entfernt', { description: 'Deine Fraktionsmitgliedschaft war bereits nicht mehr aktiv.' });
      return;
    }

    let roleSynced = true;
    if (member.faction.roleId) {
      try {
        await removeFactionRole(interaction.client, String(scope.guildId), String(scope.actorDiscordId), member.faction.roleId);
      } catch (error) {
        roleSynced = false;
        logger.warn(`Faction-Role-Sync nach /leave fehlgeschlagen: ${(error as Error).message}`);
        logAudit('FACTION_ROLE_SYNC_FAILED', 'FACTION', {
          guildId: scope.guildId,
          factionId: member.factionId,
          user: scope.actorDiscordId,
          roleId: member.faction.roleId,
          operation: 'REMOVE',
        });
      }
    }

    logAudit('FACTION_LEAVE', 'FACTION', {
      guildId: scope.guildId,
      factionId: member.factionId,
      user: scope.actorDiscordId,
      roleSynced,
    });
    refreshPersistentFactionEmbeds(interaction.client, String(scope.guildId), member.factionId);
    emitGuildEvent(scope.guildId, { type: 'faction.changed', payload: { guildId: scope.guildId, factionId: member.factionId } });
    await statusReply(interaction, roleSynced ? 'SUCCESS' : 'INFO', roleSynced ? 'Fraktion verlassen' : 'Mitgliedschaft entfernt, Rollen-Sync offen', {
      description: roleSynced
        ? `Du hast **${escapeMarkdown(member.faction.name)}** verlassen.`
        : `Deine Mitgliedschaft in **${escapeMarkdown(member.faction.name)}** wurde entfernt, aber die Discord-Rolle konnte nicht automatisch entfernt werden.`,
    });
  }),
};
