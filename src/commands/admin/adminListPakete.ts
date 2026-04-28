import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
  MessageFlags,
} from 'discord.js';
import { Prisma } from '@prisma/client';
import { Command } from '../../types';
import prisma from '../../database/prisma';
import { formatBytes } from '../../utils/embedDesign';

/**
 * /admin-list-pakete — Alle Pakete und Inhalte (GUID, Metadaten, Validierungsstatus).
 * Developer-Bereich: Übersicht aller Pakete und Inhalte.
 */
const adminListPaketeCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('admin-list-pakete')
    .setDescription('Alle Pakete und ihre Inhalte anzeigen')
    .addStringOption(opt =>
      opt
        .setName('status')
        .setDescription('Nach Status filtern')
        .setRequired(false)
        .addChoices(
          { name: 'Alle', value: 'ALL' },
          { name: 'Aktiv', value: 'ACTIVE' },
          { name: 'Quarantäne', value: 'QUARANTINED' },
          { name: 'Gelöscht', value: 'DELETED' },
          { name: 'Validierung', value: 'VALIDATING' },
        )
    )
    .addUserOption(opt =>
      opt.setName('user').setDescription('Pakete eines bestimmten Users').setRequired(false)
    )
    .addIntegerOption(opt =>
      opt.setName('seite').setDescription('Seitenzahl').setRequired(false).setMinValue(1)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) as SlashCommandBuilder,
  adminOnly: true,

  execute: async (interaction: ChatInputCommandInteraction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const statusFilter = interaction.options.getString('status') || 'ALL';
    const targetUser = interaction.options.getUser('user');
    const page = interaction.options.getInteger('seite') || 1;
    const perPage = 10;

    const where: Prisma.PackageWhereInput = {};
    if (statusFilter !== 'ALL') {
      where.status = statusFilter as Prisma.PackageWhereInput['status'];
    }
    if (targetUser) {
      const dbUser = await prisma.user.findUnique({ where: { discordId: targetUser.id } });
      if (dbUser) {
        where.userId = dbUser.id;
      } else {
        await interaction.editReply({ content: '❌ User nicht in der Datenbank gefunden.' });
        return;
      }
    }

    const [packages, total] = await Promise.all([
      prisma.package.findMany({
        where,
        skip: (page - 1) * perPage,
        take: perPage,
        orderBy: { createdAt: 'desc' },
        include: {
          user: true,
          _count: { select: { files: true, downloads: true } },
        },
      }),
      prisma.package.count({ where }),
    ]);

    const totalPages = Math.ceil(total / perPage);

    if (packages.length === 0) {
      await interaction.editReply({ content: '❌ Keine Pakete gefunden.' });
      return;
    }

    const lines = packages.map((p, i: number) => {
      const idx = (page - 1) * perPage + i + 1;
      const sizeStr = formatBytes(Number(p.totalSize));
      const statusEmoji = p.status === 'ACTIVE' ? '🟢' : p.status === 'QUARANTINED' ? '🟡' : p.status === 'DELETED' ? '🔴' : '🔵';
      return `**${idx}.** ${statusEmoji} **${p.name}** von <@${p.user.discordId}>\n` +
        `   GUID: \`${p.id}\` | Status: \`${p.status}\`\n` +
        `   Dateien: ${p._count.files} | Größe: ${sizeStr} | Downloads: ${p._count.downloads}\n` +
        `   Erstellt: ${p.createdAt.toLocaleDateString('de-DE')}`;
    });

    const embed = new EmbedBuilder()
      .setTitle(`📦 Paketübersicht (${statusFilter})`)
      .setDescription(lines.join('\n\n'))
      .setColor(0x2ecc71)
      .setFooter({ text: `Seite ${page}/${totalPages} • ${total} Pakete gesamt` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },
};

export default adminListPaketeCommand;
