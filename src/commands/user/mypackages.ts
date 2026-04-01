import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { Command } from '../../types';
import prisma from '../../database/prisma';

/**
 * /mypackages Command (Sektion 2):
 * - Übersicht, Suche und Verwaltung aller eigenen Pakete/Dateien
 * - Filter, Sortierung, Bulk-Operationen
 * - Soft-Delete, Restore
 */
const mypackagesCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('mypackages')
    .setDescription('Verwalte deine eigenen Pakete')
    .addSubcommand(sub =>
      sub.setName('list').setDescription('Alle deine Pakete anzeigen')
        .addStringOption(opt =>
          opt.setName('filter').setDescription('Filter: name, status').setRequired(false)
        )
        .addStringOption(opt =>
          opt.setName('sortierung').setDescription('Sortierung')
          .setRequired(false)
          .addChoices(
            { name: 'Neueste zuerst', value: 'newest' },
            { name: 'Älteste zuerst', value: 'oldest' },
            { name: 'Größte zuerst', value: 'biggest' },
            { name: 'Name A-Z', value: 'name_asc' },
          )
        )
    )
    .addSubcommand(sub =>
      sub.setName('info').setDescription('Details zu einem Paket')
        .addStringOption(opt =>
          opt.setName('paketname').setDescription('Name des Pakets').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('delete').setDescription('Paket löschen (Soft-Delete)')
        .addStringOption(opt =>
          opt.setName('paketname').setDescription('Name des Pakets').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('restore').setDescription('Gelöschtes Paket wiederherstellen')
        .addStringOption(opt =>
          opt.setName('paketname').setDescription('Name des Pakets').setRequired(true)
        )
    ),

  execute: async (interaction: ChatInputCommandInteraction) => {
    await interaction.deferReply({ ephemeral: true });

    const dbUser = await prisma.user.findUnique({
      where: { discordId: interaction.user.id },
    });

    if (!dbUser) {
      await interaction.editReply({ content: '❌ Du bist nicht registriert.' });
      return;
    }

    const subcommand = interaction.options.getSubcommand();

    switch (subcommand) {
      case 'list':
        await handleList(interaction, dbUser.id);
        break;
      case 'info':
        await handleInfo(interaction, dbUser.id);
        break;
      case 'delete':
        await handleDelete(interaction, dbUser.id);
        break;
      case 'restore':
        await handleRestore(interaction, dbUser.id);
        break;
    }
  },
};

async function handleList(interaction: ChatInputCommandInteraction, userId: string) {
  const filter = interaction.options.getString('filter') || undefined;
  const sortierung = interaction.options.getString('sortierung') || 'newest';

  let orderBy: any;
  switch (sortierung) {
    case 'oldest': orderBy = { createdAt: 'asc' }; break;
    case 'biggest': orderBy = { totalSize: 'desc' }; break;
    case 'name_asc': orderBy = { name: 'asc' }; break;
    default: orderBy = { createdAt: 'desc' };
  }

  const packages = await prisma.package.findMany({
    where: {
      userId,
      isDeleted: false,
      ...(filter ? { name: { contains: filter, mode: 'insensitive' as const } } : {}),
    },
    orderBy,
    include: { _count: { select: { files: true, downloads: true } } },
  });

  if (packages.length === 0) {
    await interaction.editReply({ content: '📦 Du hast noch keine Pakete.' });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('📦 Deine Pakete')
    .setColor(0x0099ff)
    .setTimestamp()
    .setFooter({ text: `${packages.length} Paket(e) gefunden` });

  for (const pkg of packages.slice(0, 25)) {
    embed.addFields({
      name: `📦 ${pkg.name}`,
      value: [
        `📊 Dateien: ${pkg._count.files}`,
        `💾 Größe: ${formatBytes(Number(pkg.totalSize))}`,
        `📥 Downloads: ${pkg._count.downloads}`,
        `📅 Erstellt: ${pkg.createdAt.toLocaleDateString('de-DE')}`,
        `🔹 Status: ${pkg.status}`,
      ].join('\n'),
      inline: true,
    });
  }

  await interaction.editReply({ embeds: [embed] });
}

async function handleInfo(interaction: ChatInputCommandInteraction, userId: string) {
  const paketname = interaction.options.getString('paketname', true);

  const pkg = await prisma.package.findFirst({
    where: { userId, name: paketname },
    include: {
      files: {
        where: { isDeleted: false },
        orderBy: { createdAt: 'desc' },
      },
      _count: { select: { downloads: true } },
    },
  });

  if (!pkg) {
    await interaction.editReply({ content: `❌ Paket "${paketname}" nicht gefunden.` });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(`📦 Paket: ${pkg.name}`)
    .setColor(0x0099ff)
    .setTimestamp()
    .addFields(
      { name: '🆔 Paket-ID', value: pkg.id, inline: true },
      { name: '💾 Gesamtgröße', value: formatBytes(Number(pkg.totalSize)), inline: true },
      { name: '📥 Downloads', value: pkg._count.downloads.toString(), inline: true },
      { name: '📅 Erstellt', value: pkg.createdAt.toLocaleDateString('de-DE'), inline: true },
      { name: '🔹 Status', value: pkg.status, inline: true },
      { name: '🗑️ Gelöscht', value: pkg.isDeleted ? '✅ Ja' : '❌ Nein', inline: true },
    );

  if (pkg.description) {
    embed.setDescription(pkg.description);
  }

  // Dateien auflisten
  if (pkg.files.length > 0) {
    const fileList = pkg.files.slice(0, 15).map((f: any) =>
      `• **${f.originalName}** (${formatBytes(Number(f.fileSize))}) - ${f.validationStatus} ${f.isValid ? '✅' : '❌'}`
    ).join('\n');

    embed.addFields({ name: `📄 Dateien (${pkg.files.length})`, value: fileList, inline: false });
  }

  await interaction.editReply({ embeds: [embed] });
}

async function handleDelete(interaction: ChatInputCommandInteraction, userId: string) {
  const paketname = interaction.options.getString('paketname', true);
  const { deletePackage } = await import('../../modules/upload/uploadHandler');

  const pkg = await prisma.package.findFirst({
    where: { userId, name: paketname, isDeleted: false },
  });

  if (!pkg) {
    await interaction.editReply({ content: `❌ Paket "${paketname}" nicht gefunden.` });
    return;
  }

  await deletePackage(pkg.id, userId, false);

  await interaction.editReply({
    content: `🗑️ Paket "${paketname}" wurde gelöscht (Soft-Delete). Verwende \`/mypackages restore\` zum Wiederherstellen.`,
  });
}

async function handleRestore(interaction: ChatInputCommandInteraction, userId: string) {
  const paketname = interaction.options.getString('paketname', true);
  const { restorePackage } = await import('../../modules/upload/uploadHandler');

  const pkg = await prisma.package.findFirst({
    where: { userId, name: paketname, isDeleted: true },
  });

  if (!pkg) {
    await interaction.editReply({ content: `❌ Gelöschtes Paket "${paketname}" nicht gefunden.` });
    return;
  }

  await restorePackage(pkg.id);

  await interaction.editReply({
    content: `✅ Paket "${paketname}" wurde wiederhergestellt.`,
  });
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

export default mypackagesCommand;
