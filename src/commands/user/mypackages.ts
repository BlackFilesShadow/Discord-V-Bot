import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ComponentType,
} from 'discord.js';
import { Command } from '../../types';
import prisma from '../../database/prisma';
import { Colors, Brand, vEmbed, formatBytes } from '../../utils/embedDesign';
import { createBotEmbed } from '../../utils/embedUtil';

/**
 * /mypackages Command (Sektion 2):
 * - Übersicht, Suche und Verwaltung aller eigenen Pakete/Dateien
 * - Filter, Sortierung, Bulk-Operationen
 * - Soft-Delete, Restore
 * - Dropdown-basiertes Löschen einzelner Dateien
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
    )
    .addSubcommand(sub =>
      sub.setName('delete-file').setDescription('Einzelne Dateien aus deinen Paketen löschen (Dropdown)')
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
      case 'delete-file':
        await handleDeleteFile(interaction, dbUser.id);
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

    const fields = packages.slice(0, 25).map(pkg => ({
      name: `📦 ${pkg.name}`,
      value: [
        `📊 Dateien: ${pkg._count.files}`,
        `💾 Größe: ${formatBytes(Number(pkg.totalSize))}`,
        `📥 Downloads: ${pkg._count.downloads}`,
        `📅 Erstellt: ${pkg.createdAt.toLocaleDateString('de-DE')}`,
        `🔹 Status: ${pkg.status}`,
      ].join('\n'),
      inline: true,
    }));
    const embed = createBotEmbed({
      title: '📦 Deine Pakete',
      color: Colors.Primary,
      fields,
      footer: `${packages.length} Paket(e) ${Brand.dot} ${Brand.footerText}`,
      timestamp: true,
    });
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

  const embed = vEmbed(Colors.Primary)
    .setTitle(`📦  Paket: ${pkg.name}`)
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

/**
 * Dropdown-basiertes Löschen einzelner Dateien.
 * Hersteller wählt zuerst ein Paket, dann die Dateien zum Löschen.
 */
async function handleDeleteFile(interaction: ChatInputCommandInteraction, userId: string) {
  // Pakete des Users laden
  const packages = await prisma.package.findMany({
    where: { userId, isDeleted: false },
    include: {
      files: {
        where: { isDeleted: false },
        select: { id: true, originalName: true, fileSize: true },
      },
    },
    take: 25,
    orderBy: { createdAt: 'desc' },
  });

  const packagesWithFiles = packages.filter(p => p.files.length > 0);

  if (packagesWithFiles.length === 0) {
    await interaction.editReply({ content: '📦 Du hast keine Pakete mit Dateien.' });
    return;
  }

  // Schritt 1: Paket-Dropdown
  const pkgSelect = new StringSelectMenuBuilder()
    .setCustomId('myfiles_pkg_select')
    .setPlaceholder('📦 Paket auswählen...')
    .addOptions(
      packagesWithFiles.map(pkg =>
        new StringSelectMenuOptionBuilder()
          .setLabel(pkg.name)
          .setDescription(`${pkg.files.length} Datei(en)`)
          .setValue(pkg.id)
          .setEmoji('📦')
      )
    );

  const pkgRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(pkgSelect);

  const embed = new EmbedBuilder()
    .setTitle('🗑️ Datei löschen')
    .setDescription('Wähle zuerst ein Paket, dann die Datei(en) zum Löschen.')
    .setColor(0xff6600)
    .setTimestamp();

  const response = await interaction.editReply({ embeds: [embed], components: [pkgRow] });

  const pkgCollector = response.createMessageComponentCollector({
    componentType: ComponentType.StringSelect,
    time: 120_000,
  });

  pkgCollector.on('collect', async (pkgInteraction) => {
    if (pkgInteraction.customId !== 'myfiles_pkg_select') return;

    const selectedPkgId = pkgInteraction.values[0];
    const pkg = packagesWithFiles.find(p => p.id === selectedPkgId);

    if (!pkg || pkg.files.length === 0) {
      await pkgInteraction.update({
        embeds: [new EmbedBuilder().setTitle('❌ Keine Dateien').setColor(0xff0000)],
        components: [],
      });
      return;
    }

    // Schritt 2: Datei-Dropdown (Mehrfachauswahl)
    const fileSelect = new StringSelectMenuBuilder()
      .setCustomId('myfiles_file_select')
      .setPlaceholder('📄 Datei(en) zum Löschen auswählen...')
      .setMinValues(1)
      .setMaxValues(Math.min(pkg.files.length, 25))
      .addOptions(
        pkg.files.slice(0, 25).map(file =>
          new StringSelectMenuOptionBuilder()
            .setLabel(file.originalName)
            .setDescription(`${formatBytes(Number(file.fileSize))}`)
            .setValue(file.id)
            .setEmoji('📄')
        )
      );

    const fileRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(fileSelect);

    const fileEmbed = new EmbedBuilder()
      .setTitle(`🗑️ Dateien löschen — ${pkg.name}`)
      .setDescription(`Wähle eine oder mehrere Dateien zum Löschen.\n**${pkg.files.length} Datei(en)** vorhanden.`)
      .setColor(0xff6600)
      .setTimestamp();

    const updateResponse = await pkgInteraction.update({ embeds: [fileEmbed], components: [fileRow] });

    const fileCollector = updateResponse.createMessageComponentCollector({
      componentType: ComponentType.StringSelect,
      time: 120_000,
    });

    fileCollector.on('collect', async (fileInteraction) => {
      if (fileInteraction.customId !== 'myfiles_file_select') return;

      const selectedFileIds = fileInteraction.values;
      const fs = await import('fs/promises');

      let deleted = 0;
      const deletedNames: string[] = [];

      for (const fileId of selectedFileIds) {
        const upload = await prisma.upload.findUnique({ where: { id: fileId } });
        if (!upload || upload.userId !== userId) continue;

        // Soft-Delete in DB
        await prisma.upload.update({
          where: { id: fileId },
          data: { isDeleted: true, deletedAt: new Date() },
        });

        // Datei vom Filesystem löschen
        try { await fs.unlink(upload.filePath); } catch { /* Datei existiert evtl. nicht mehr */ }

        // Paket-Statistiken aktualisieren
        await prisma.package.update({
          where: { id: upload.packageId },
          data: {
            fileCount: { decrement: 1 },
            totalSize: { decrement: upload.fileSize },
          },
        });

        deletedNames.push(upload.originalName);
        deleted++;
      }

      const { logAudit } = await import('../../utils/logger');
      logAudit('FILES_DELETED_BY_MANUFACTURER', 'UPLOAD', {
        userId,
        packageId: selectedPkgId,
        deletedFiles: deletedNames,
        count: deleted,
      });

      const doneEmbed = new EmbedBuilder()
        .setTitle('✅ Dateien gelöscht')
        .setDescription(
          `**${deleted} Datei(en)** aus **${pkg.name}** gelöscht:\n\n` +
          deletedNames.map(n => `• ~~${n}~~`).join('\n')
        )
        .setColor(0x00ff00)
        .setTimestamp();

      await fileInteraction.update({ embeds: [doneEmbed], components: [] });
    });

    fileCollector.on('end', async (_, reason) => {
      if (reason === 'time') {
        try { await interaction.editReply({ components: [] }); } catch {}
      }
    });

    pkgCollector.stop('collected');
  });

  pkgCollector.on('end', async (_, reason) => {
    if (reason === 'time') {
      try { await interaction.editReply({ components: [] }); } catch {}
    }
  });
}

export default mypackagesCommand;
