import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageFlags,
} from 'discord.js';
import { Prisma } from '@prisma/client';
import fs from 'fs/promises';
import { Command } from '../../types';
import prisma from '../../database/prisma';
import { Colors, Brand, vEmbed, formatBytes } from '../../utils/embedDesign';
import { createBotEmbed } from '../../utils/embedUtil';
import { deletePackage, restorePackage } from '../../modules/upload/uploadHandler';
import { logAudit, logger } from '../../utils/logger';
import { isInsideUploadRoot } from '../../utils/pathSafety';

const PAGE_SIZE = 25;

/**
 * /mypackages — eigener Herstellerbereich.
 *
 * - kanonischer Herstellerstatus wird zusaetzlich zum Dispatcher nochmals
 *   service-nah geprueft;
 * - List/Info/Paket- und Dateiauswahl werden vollstaendig paginiert;
 * - Einzeldatei-Loeschung ist auf userId + packageId + fileId gebunden;
 * - Datei-Soft-Delete + Paketstatistik werden in EINER Transaction committed;
 * - Paketstatistik wird aus verbleibenden aktiven Dateien neu berechnet und
 *   heilt damit auch alte Counter-Drifts.
 */
const mypackagesCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('mypackages')
    .setDescription('Verwalte deine eigenen Hersteller-Pakete')
    .addSubcommand(sub => sub.setName('list').setDescription('Alle deine Pakete anzeigen')
      .addStringOption(opt => opt.setName('filter').setDescription('Optional nach Paketname filtern').setRequired(false))
      .addStringOption(opt => opt.setName('sortierung').setDescription('Sortierung').setRequired(false).addChoices(
        { name: 'Neueste zuerst', value: 'newest' },
        { name: 'Aelteste zuerst', value: 'oldest' },
        { name: 'Groesste zuerst', value: 'biggest' },
        { name: 'Name A-Z', value: 'name_asc' },
      )))
    .addSubcommand(sub => sub.setName('info').setDescription('Details zu einem Paket')
      .addStringOption(opt => opt.setName('paketname').setDescription('Name des Pakets').setRequired(true)))
    .addSubcommand(sub => sub.setName('delete').setDescription('Paket ausblenden (Soft-Delete)')
      .addStringOption(opt => opt.setName('paketname').setDescription('Name des Pakets').setRequired(true)))
    .addSubcommand(sub => sub.setName('restore').setDescription('Soft-geloeschtes Paket wiederherstellen')
      .addStringOption(opt => opt.setName('paketname').setDescription('Name des Pakets').setRequired(true)))
    .addSubcommand(sub => sub.setName('delete-file').setDescription('Einzelne Dateien aus deinen Paketen loeschen')),
  manufacturerOnly: true,

  execute: async (interaction: ChatInputCommandInteraction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const dbUser = await prisma.user.findUnique({ where: { discordId: interaction.user.id } });
    if (!dbUser || dbUser.status !== 'ACTIVE' || !dbUser.isManufacturer || dbUser.role !== 'MANUFACTURER') {
      await interaction.editReply({
        embeds: [statusEmbed('ERROR', 'Kein aktiver Herstellerbereich', 'Dein Account ist nicht vollstaendig als aktiver Hersteller verifiziert.')],
        allowedMentions: { parse: [] },
      });
      return;
    }

    switch (interaction.options.getSubcommand()) {
      case 'list': await handleList(interaction, dbUser.id); break;
      case 'info': await handleInfo(interaction, dbUser.id); break;
      case 'delete': await handleDelete(interaction, dbUser.id); break;
      case 'restore': await handleRestore(interaction, dbUser.id); break;
      case 'delete-file': await handleDeleteFile(interaction, dbUser.id); break;
    }
  },
};

function statusEmbed(kind: 'INFO' | 'SUCCESS' | 'ERROR' | 'WARNING', title: string, description: string): EmbedBuilder {
  const color = kind === 'SUCCESS' ? Colors.Success : kind === 'ERROR' ? Colors.Error : kind === 'WARNING' ? Colors.Warning : Colors.Info;
  return vEmbed(color).setTitle(title).setDescription(description);
}

async function sendEmbedPages(interaction: ChatInputCommandInteraction, embeds: EmbedBuilder[]): Promise<void> {
  for (let index = 0; index < embeds.length; index += 10) {
    const chunk = embeds.slice(index, index + 10);
    if (index === 0) await interaction.editReply({ embeds: chunk, allowedMentions: { parse: [] } });
    else await interaction.followUp({ embeds: chunk, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  }
}

async function handleList(interaction: ChatInputCommandInteraction, userId: string) {
  const filter = interaction.options.getString('filter')?.trim() || undefined;
  const sortierung = interaction.options.getString('sortierung') || 'newest';
  let orderBy: Prisma.PackageOrderByWithRelationInput;
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
    include: {
      _count: {
        select: {
          files: { where: { isDeleted: false } },
          downloads: true,
        },
      },
    },
  });

  if (packages.length === 0) {
    await interaction.editReply({
      embeds: [statusEmbed('INFO', '📦 Keine Pakete', filter ? `Keine aktiven Pakete passen zum Filter **${filter}**.` : 'Du hast noch keine aktiven Pakete.')],
      allowedMentions: { parse: [] },
    });
    return;
  }

  const embeds: EmbedBuilder[] = [];
  for (let offset = 0; offset < packages.length; offset += PAGE_SIZE) {
    const page = packages.slice(offset, offset + PAGE_SIZE);
    const pageNo = Math.floor(offset / PAGE_SIZE) + 1;
    const pages = Math.ceil(packages.length / PAGE_SIZE);
    const fields = page.map(pkg => ({
      name: `📦 ${pkg.name}`.slice(0, 256),
      value: [
        `📊 Aktive Dateien: ${pkg._count.files}`,
        `💾 Groesse: ${formatBytes(Number(pkg.totalSize))}`,
        `📥 Download-Records: ${pkg._count.downloads}`,
        `📅 Erstellt: ${pkg.createdAt.toLocaleDateString('de-DE')}`,
        `🔹 Status: ${pkg.status}`,
      ].join('\n'),
      inline: true,
    }));
    embeds.push(createBotEmbed({
      title: `📦 Deine Pakete${pages > 1 ? ` · ${pageNo}/${pages}` : ''}`,
      color: Colors.Primary,
      fields,
      footer: `${packages.length} Paket(e) ${Brand.dot} ${Brand.footerText}`,
      timestamp: true,
    }));
  }
  await sendEmbedPages(interaction, embeds);
}

async function handleInfo(interaction: ChatInputCommandInteraction, userId: string) {
  const paketname = interaction.options.getString('paketname', true).trim();
  const pkg = await prisma.package.findFirst({
    where: { userId, name: { equals: paketname, mode: 'insensitive' }, isDeleted: false },
    include: {
      files: { where: { isDeleted: false }, orderBy: { createdAt: 'desc' } },
      _count: { select: { downloads: true } },
    },
  });
  if (!pkg) {
    await interaction.editReply({ embeds: [statusEmbed('ERROR', 'Paket nicht gefunden', `Ein aktives Paket **${paketname}** existiert in deinem Herstellerbereich nicht.`)] });
    return;
  }

  const chunks = pkg.files.length > 0
    ? Array.from({ length: Math.ceil(pkg.files.length / 15) }, (_, index) => pkg.files.slice(index * 15, index * 15 + 15))
    : [[]];
  const embeds = chunks.map((files, index) => {
    const embed = vEmbed(Colors.Primary)
      .setTitle(`📦 Paket: ${pkg.name}${chunks.length > 1 ? ` · ${index + 1}/${chunks.length}` : ''}`)
      .addFields(
        { name: '🆔 Paket-ID', value: `\`${pkg.id}\``, inline: true },
        { name: '💾 Gesamtgroesse', value: formatBytes(Number(pkg.totalSize)), inline: true },
        { name: '📥 Download-Records', value: pkg._count.downloads.toString(), inline: true },
        { name: '📅 Erstellt', value: pkg.createdAt.toLocaleDateString('de-DE'), inline: true },
        { name: '🔹 Status', value: pkg.status, inline: true },
      );
    if (index === 0 && pkg.description) embed.setDescription(pkg.description.slice(0, 4096));
    if (files.length > 0) {
      embed.addFields({
        name: `📄 Dateien ${index * 15 + 1}-${index * 15 + files.length} von ${pkg.files.length}`,
        value: files.map(file =>
          `• **${file.originalName}** (${formatBytes(Number(file.fileSize))}) · ${file.validationStatus} ${file.isValid ? '✅' : '❌'}`,
        ).join('\n').slice(0, 1024),
        inline: false,
      });
    } else {
      embed.addFields({ name: '📄 Dateien', value: '_Keine aktiven Dateien_', inline: false });
    }
    return embed;
  });
  await sendEmbedPages(interaction, embeds);
}

async function handleDelete(interaction: ChatInputCommandInteraction, userId: string) {
  const paketname = interaction.options.getString('paketname', true).trim();
  const pkg = await prisma.package.findFirst({
    where: { userId, name: { equals: paketname, mode: 'insensitive' }, isDeleted: false },
  });
  if (!pkg) {
    await interaction.editReply({ embeds: [statusEmbed('ERROR', 'Paket nicht gefunden', `Das aktive Paket **${paketname}** wurde nicht gefunden.`)] });
    return;
  }

  await deletePackage(pkg.id, userId, false);
  await interaction.editReply({
    embeds: [statusEmbed('SUCCESS', '🗑️ Paket ausgeblendet', `**${pkg.name}** wurde per Soft-Delete ausgeblendet. Einzelne Datei-Loeschungen bleiben dabei unveraendert. Mit \`/mypackages restore\` kannst du das Paket wiederherstellen.`)],
  });
}

async function handleRestore(interaction: ChatInputCommandInteraction, userId: string) {
  const paketname = interaction.options.getString('paketname', true).trim();
  const pkg = await prisma.package.findFirst({
    where: { userId, name: { equals: paketname, mode: 'insensitive' }, isDeleted: true },
  });
  if (!pkg) {
    await interaction.editReply({ embeds: [statusEmbed('ERROR', 'Paket nicht gefunden', `Kein soft-geloeschtes Paket **${paketname}** wurde gefunden.`)] });
    return;
  }

  await restorePackage(pkg.id);
  await interaction.editReply({
    embeds: [statusEmbed('SUCCESS', '✅ Paket wiederhergestellt', `**${pkg.name}** ist wieder aktiv. Bewusst einzeln geloeschte Dateien wurden nicht wiederhergestellt.`)],
  });
}

async function handleDeleteFile(interaction: ChatInputCommandInteraction, userId: string) {
  const packages = await prisma.package.findMany({
    where: { userId, isDeleted: false },
    select: {
      id: true,
      name: true,
      _count: { select: { files: { where: { isDeleted: false } } } },
    },
    orderBy: { createdAt: 'desc' },
  });
  const packagesWithFiles = packages.filter(pkg => pkg._count.files > 0);
  if (packagesWithFiles.length === 0) {
    await interaction.editReply({ embeds: [statusEmbed('INFO', '📦 Keine Dateien', 'Du hast keine aktiven Pakete mit aktiven Dateien.')] });
    return;
  }

  let packagePage = 0;
  const packagePages = Math.ceil(packagesWithFiles.length / PAGE_SIZE);
  const buildPackageView = (page: number) => {
    const slice = packagesWithFiles.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
    const select = new StringSelectMenuBuilder()
      .setCustomId('myfiles_pkg_select')
      .setPlaceholder('📦 Paket auswaehlen...')
      .addOptions(slice.map(pkg => new StringSelectMenuOptionBuilder()
        .setLabel(pkg.name.slice(0, 100))
        .setDescription(`${pkg._count.files} aktive Datei(en)`)
        .setValue(pkg.id)
        .setEmoji('📦')));
    const rows: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
    ];
    if (packagePages > 1) {
      rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('myfiles_pkg_prev').setLabel('◀ Zurueck').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
        new ButtonBuilder().setCustomId('myfiles_pkg_next').setLabel('Weiter ▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= packagePages - 1),
      ));
    }
    return {
      embeds: [vEmbed(Colors.Warning)
        .setTitle(`🗑️ Datei loeschen${packagePages > 1 ? ` · Pakete ${page + 1}/${packagePages}` : ''}`)
        .setDescription('Waehle zuerst das Paket. Danach kannst du auf jeder Dateiseite eine oder mehrere Dateien loeschen.')],
      components: rows,
    };
  };

  const response = await interaction.editReply(buildPackageView(packagePage));
  const packageCollector = response.createMessageComponentCollector({
    time: 120_000,
    filter: component => component.user.id === interaction.user.id,
  });

  packageCollector.on('collect', async component => {
    if (component.customId === 'myfiles_pkg_prev' || component.customId === 'myfiles_pkg_next') {
      packagePage += component.customId === 'myfiles_pkg_next' ? 1 : -1;
      packagePage = Math.max(0, Math.min(packagePages - 1, packagePage));
      await component.update(buildPackageView(packagePage));
      return;
    }
    if (component.customId !== 'myfiles_pkg_select' || component.componentType !== ComponentType.StringSelect) return;

    const selectedPkgId = component.values[0];
    const freshPackage = await prisma.package.findFirst({
      where: { id: selectedPkgId, userId, isDeleted: false },
      select: {
        id: true,
        name: true,
        files: {
          where: { isDeleted: false },
          select: { id: true, originalName: true, fileSize: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!freshPackage || freshPackage.files.length === 0) {
      await component.update({ embeds: [statusEmbed('ERROR', 'Keine Dateien', 'Das Paket existiert nicht mehr oder enthaelt keine aktiven Dateien.')], components: [] });
      packageCollector.stop('empty');
      return;
    }

    packageCollector.stop('package-selected');
    let filePage = 0;
    const filePages = Math.ceil(freshPackage.files.length / PAGE_SIZE);
    const buildFileView = (page: number) => {
      const slice = freshPackage.files.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
      const select = new StringSelectMenuBuilder()
        .setCustomId('myfiles_file_select')
        .setPlaceholder('📄 Datei(en) zum Loeschen auswaehlen...')
        .setMinValues(1)
        .setMaxValues(slice.length)
        .addOptions(slice.map(file => new StringSelectMenuOptionBuilder()
          .setLabel(file.originalName.slice(0, 100))
          .setDescription(formatBytes(Number(file.fileSize)))
          .setValue(file.id)
          .setEmoji('📄')));
      const rows: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
      ];
      if (filePages > 1) {
        rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId('myfiles_file_prev').setLabel('◀ Zurueck').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
          new ButtonBuilder().setCustomId('myfiles_file_next').setLabel('Weiter ▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= filePages - 1),
        ));
      }
      return {
        embeds: [vEmbed(Colors.Warning)
          .setTitle(`🗑️ ${freshPackage.name} · Dateien ${page + 1}/${filePages}`)
          .setDescription(`**${freshPackage.files.length}** aktive Datei(en). Waehle auf dieser Seite eine oder mehrere Dateien.`)],
        components: rows,
      };
    };

    await component.update(buildFileView(filePage));
    const fileCollector = response.createMessageComponentCollector({
      time: 120_000,
      filter: child => child.user.id === interaction.user.id,
    });

    fileCollector.on('collect', async child => {
      if (child.customId === 'myfiles_file_prev' || child.customId === 'myfiles_file_next') {
        filePage += child.customId === 'myfiles_file_next' ? 1 : -1;
        filePage = Math.max(0, Math.min(filePages - 1, filePage));
        await child.update(buildFileView(filePage));
        return;
      }
      if (child.customId !== 'myfiles_file_select' || child.componentType !== ComponentType.StringSelect) return;

      const selectedFileIds = child.values;
      const deletedRows = await prisma.$transaction(async tx => {
        const rows = await tx.upload.findMany({
          where: { id: { in: selectedFileIds }, userId, packageId: selectedPkgId, isDeleted: false },
          select: { id: true, filePath: true, fileSize: true, originalName: true },
        });
        if (rows.length === 0) return [];

        const ids = rows.map(row => row.id);
        const now = new Date();
        await tx.upload.updateMany({
          where: { id: { in: ids }, userId, packageId: selectedPkgId, isDeleted: false },
          data: { isDeleted: true, deletedAt: now },
        });

        const remaining = await tx.upload.findMany({
          where: { userId, packageId: selectedPkgId, isDeleted: false },
          select: { fileSize: true },
        });
        const totalSize = remaining.reduce((sum, row) => sum + row.fileSize, 0n);
        const packageUpdated = await tx.package.updateMany({
          where: { id: selectedPkgId, userId, isDeleted: false },
          data: { fileCount: remaining.length, totalSize },
        });
        if (packageUpdated.count !== 1) throw new Error('Paket wurde waehrend der Datei-Loeschung veraendert oder entfernt.');
        return rows;
      });

      for (const row of deletedRows) {
        if (!isInsideUploadRoot(row.filePath)) {
          logger.error(`mypackages delete-file: unsicherer Pfad nicht geloescht: ${row.filePath}`);
          continue;
        }
        try { await fs.unlink(row.filePath); } catch { /* DB bereits fail-closed; Orphan best-effort */ }
      }

      const deletedNames = deletedRows.map(row => row.originalName);
      logAudit('FILES_DELETED_BY_MANUFACTURER', 'UPLOAD', {
        userId,
        packageId: selectedPkgId,
        requestedFileIds: selectedFileIds,
        deletedFiles: deletedNames,
        count: deletedRows.length,
      });

      await child.update({
        embeds: [deletedRows.length > 0
          ? statusEmbed('SUCCESS', '✅ Dateien geloescht', `**${deletedRows.length} Datei(en)** aus **${freshPackage.name}** wurden entfernt:\n\n${deletedNames.map(name => `• ~~${name}~~`).join('\n').slice(0, 3000)}`)
          : statusEmbed('WARNING', 'Keine Datei geloescht', 'Die ausgewaehlten Dateien waren nicht mehr aktiv oder gehoerten nicht mehr zu diesem Paket.')],
        components: [],
      });
      fileCollector.stop('deleted');
    });

    fileCollector.on('end', async (_collected, reason) => {
      if (reason === 'time') {
        try { await interaction.editReply({ components: [] }); } catch { /* interaction gone */ }
      }
    });
  });

  packageCollector.on('end', async (_collected, reason) => {
    if (reason === 'time') {
      try { await interaction.editReply({ components: [] }); } catch { /* interaction gone */ }
    }
  });
}

export default mypackagesCommand;
