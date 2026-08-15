import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
  EmbedBuilder,
  escapeMarkdown,
} from 'discord.js';
import { Command } from '../../types';
import prisma from '../../database/prisma';
import { buildStatusEmbed } from '../../utils/statusEmbed';

/**
 * /fraktionen — deutschsprachige guildweite Fraktionsuebersicht.
 *
 * Fraktionen sind seit der Discord-only-Migration bewusst NICHT mehr nach
 * Nitrado-Slots getrennt. Dieser Command bleibt als deutsche Uebersicht neben
 * /factions bestehen, rendert aber dieselbe kanonische Guild-Wahrheit.
 */
const STATUS_EMOJI: Record<string, string> = {
  ACTIVE: '🟢',
  RECRUITING: '🟡',
  INACTIVE: '⚪',
  ARCHIVED: '⚫',
};

const POLICY_EMOJI: Record<string, string> = {
  OPEN: '🔓',
  REQUEST: '✋',
  CLOSED: '🔒',
};

const fraktionenCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('fraktionen')
    .setDescription('Zeigt alle Fraktionen dieses Discord-Servers.')
    .setDMPermission(false),

  execute: async (interaction: ChatInputCommandInteraction) => {
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({
        embeds: [buildStatusEmbed({
          status: 'ERROR',
          title: 'Server erforderlich',
          description: 'Dieser Befehl ist nur auf Discord-Servern verfuegbar.',
          footerText: 'V-Bot • Fraktionssystem',
        })],
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const factions = await prisma.faction.findMany({
      where: { guildId },
      include: { _count: { select: { members: true } } },
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
    });

    if (factions.length === 0) {
      await interaction.editReply({
        embeds: [buildStatusEmbed({
          status: 'INFO',
          title: 'Keine Fraktionen',
          description: 'Auf diesem Discord-Server sind keine Fraktionen angelegt.',
          footerText: 'V-Bot • Fraktionssystem',
        })],
        allowedMentions: { parse: [] },
      });
      return;
    }

    const embeds: EmbedBuilder[] = [];
    const PAGE_SIZE = 15;
    for (let offset = 0; offset < factions.length; offset += PAGE_SIZE) {
      const page = factions.slice(offset, offset + PAGE_SIZE);
      const pageNo = Math.floor(offset / PAGE_SIZE) + 1;
      const pages = Math.ceil(factions.length / PAGE_SIZE);
      const lines = page.map(f => {
        const st = STATUS_EMOJI[f.status] ?? '⚪';
        const pol = POLICY_EMOJI[f.joinPolicy] ?? '';
        const leader = f.leaderDiscordId ? ` · Leitung <@${f.leaderDiscordId}>` : '';
        const role = f.roleId ? ` · <@&${f.roleId}>` : '';
        return `${st} **${escapeMarkdown(f.name)}** ${pol}\n👥 ${f._count.members} Mitglieder${leader}${role}`;
      });

      embeds.push(new EmbedBuilder()
        .setAuthor({ name: 'V-BOT • FRAKTIONEN' })
        .setTitle(`🏛️ Fraktionen auf ${interaction.guild?.name ?? 'diesem Server'}${pages > 1 ? ` · ${pageNo}/${pages}` : ''}`)
        .setColor(0xdc2626)
        .setDescription(lines.join('\n\n').slice(0, 4096))
        .setFooter({ text: `${factions.length} Fraktion(en) insgesamt • Discord-weit` })
        .setTimestamp());
    }

    for (let index = 0; index < embeds.length; index += 10) {
      const chunk = embeds.slice(index, index + 10);
      if (index === 0) {
        await interaction.editReply({ embeds: chunk, allowedMentions: { parse: [] } });
      } else {
        await interaction.followUp({ embeds: chunk, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      }
    }
  },
};

export default fraktionenCommand;
