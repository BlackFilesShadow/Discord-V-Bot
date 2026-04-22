import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
} from 'discord.js';
import { Command } from '../../types';
import prisma from '../../database/prisma';

/**
 * /admin-list-users — Alle Nutzer/Hersteller (GUID, Status, Rechte, Historie).
 * Developer-Bereich: Übersicht aller Nutzer & Hersteller.
 */
const adminListUsersCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('admin-list-users')
    .setDescription('Alle Nutzer und Hersteller anzeigen')
    .addStringOption(opt =>
      opt
        .setName('filter')
        .setDescription('Filtere nach Rolle')
        .setRequired(false)
        .addChoices(
          { name: 'Alle', value: 'ALL' },
          { name: 'Hersteller', value: 'MANUFACTURER' },
          { name: 'Admins', value: 'ADMIN' },
          { name: 'Moderatoren', value: 'MODERATOR' },
          { name: 'Gesperrt', value: 'BANNED' },
          { name: 'Ausstehend', value: 'PENDING_VERIFICATION' },
        )
    )
    .addIntegerOption(opt =>
      opt.setName('seite').setDescription('Seitenzahl').setRequired(false).setMinValue(1)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) as SlashCommandBuilder,
  adminOnly: true,

  execute: async (interaction: ChatInputCommandInteraction) => {
    await interaction.deferReply({ ephemeral: true });

    const filter = interaction.options.getString('filter') || 'ALL';
    const page = interaction.options.getInteger('seite') || 1;
    const perPage = 15;

    const where: Record<string, unknown> = {};
    if (filter !== 'ALL') {
      if (filter === 'BANNED' || filter === 'PENDING_VERIFICATION') {
        where.status = filter;
      } else {
        where.role = filter;
      }
    }

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip: (page - 1) * perPage,
        take: perPage,
        orderBy: { createdAt: 'desc' },
        include: {
          _count: { select: { packages: true, uploads: true, downloads: true } },
        },
      }),
      prisma.user.count({ where }),
    ]);

    const totalPages = Math.ceil(total / perPage);

    if (users.length === 0) {
      await interaction.editReply({ content: '❌ Keine Nutzer gefunden.' });
      return;
    }

    const lines = users.map((u: any, i: number) => {
      const idx = (page - 1) * perPage + i + 1;
      const mfgBadge = u.isManufacturer ? '🏭' : '';
      return `**${idx}.** <@${u.discordId}> ${mfgBadge}\n` +
        `   GUID: \`${u.id}\`\n` +
        `   Rolle: \`${u.role}\` | Status: \`${u.status}\`\n` +
        `   Pakete: ${u._count.packages} | Uploads: ${u._count.uploads} | Downloads: ${u._count.downloads}`;
    });

    const embed = new EmbedBuilder()
      .setTitle(`👥 Nutzerübersicht (${filter})`)
      .setDescription(lines.join('\n\n'))
      .setColor(0x3498db)
      .setFooter({ text: `Seite ${page}/${totalPages} • ${total} Nutzer gesamt` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },
};

export default adminListUsersCommand;
