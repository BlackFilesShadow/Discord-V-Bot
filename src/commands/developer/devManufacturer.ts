import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
} from 'discord.js';
import { Command } from '../../types';
import prisma from '../../database/prisma';
import { deletePackage } from '../../modules/upload/uploadHandler';
import { logger, logAudit } from '../../utils/logger';
import fs from 'fs/promises';
import path from 'path';
import { config } from '../../config';

/**
 * /dev-manufacturer — Hersteller-Verwaltung (DEV-Bereich).
 * - remove: Hersteller komplett entfernen + gesamten Bereich (Pakete/Dateien) löschen
 * - list: Alle Hersteller auflisten
 */
const devManufacturerCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('dev-manufacturer')
    .setDescription('Hersteller-Verwaltung (Developer)')
    .addSubcommand(sub =>
      sub.setName('remove')
        .setDescription('Hersteller entfernen und gesamten Bereich löschen')
        .addUserOption(opt =>
          opt.setName('user').setDescription('Hersteller-User').setRequired(false)
        )
        .addStringOption(opt =>
          opt.setName('user_id').setDescription('Alternativ: Discord-ID des Herstellers').setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('Alle registrierten Hersteller auflisten')
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) as SlashCommandBuilder,
  devOnly: true,

  execute: async (interaction: ChatInputCommandInteraction) => {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'remove') {
      await handleRemove(interaction);
    } else if (subcommand === 'list') {
      await handleList(interaction);
    }
  },
};

async function handleRemove(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const targetUser = interaction.options.getUser('user');
  const userIdStr = interaction.options.getString('user_id');

  let discordId: string;
  let displayName: string;

  if (targetUser) {
    discordId = targetUser.id;
    displayName = targetUser.username;
  } else if (userIdStr) {
    discordId = userIdStr.replace(/[<@!>]/g, '').trim();
    displayName = discordId;
    try {
      const fetched = await interaction.client.users.fetch(discordId);
      displayName = fetched.username;
    } catch { /* ID als Display */ }
  } else {
    await interaction.editReply({ content: '❌ Bitte gib einen **User** oder eine **User-ID** an.' });
    return;
  }

  // User in DB finden
  const dbUser = await prisma.user.findUnique({
    where: { discordId },
    include: {
      packages: {
        include: {
          files: { select: { id: true, filePath: true, originalName: true } },
        },
      },
      manufacturerRequest: true,
    },
  });

  if (!dbUser) {
    await interaction.editReply({ content: `❌ User **${displayName}** nicht in der Datenbank gefunden.` });
    return;
  }

  if (!dbUser.isManufacturer) {
    await interaction.editReply({ content: `❌ **${displayName}** ist kein Hersteller.` });
    return;
  }

  // Statistiken sammeln vor dem Löschen
  const totalPackages = dbUser.packages.length;
  let totalFiles = 0;
  let totalSize = BigInt(0);

  for (const pkg of dbUser.packages) {
    totalFiles += pkg.files.length;
    totalSize += pkg.totalSize;
  }

  // Alle Pakete hard-deleten (Dateien + DB-Einträge)
  for (const pkg of dbUser.packages) {
    await deletePackage(pkg.id, interaction.user.id, true);
  }

  // Upload-Verzeichnis des Users komplett löschen
  const userDir = path.join(config.upload.dir, dbUser.id);
  try {
    await fs.rm(userDir, { recursive: true, force: true });
  } catch { /* Verzeichnis existiert evtl. nicht */ }

  // Hersteller-Anfrage löschen
  if (dbUser.manufacturerRequest) {
    await prisma.manufacturerRequest.delete({
      where: { userId: dbUser.id },
    });
  }

  // Hersteller-Status entfernen, Rolle auf USER zurücksetzen
  await prisma.user.update({
    where: { id: dbUser.id },
    data: {
      isManufacturer: false,
      role: 'USER',
      manufacturerApprovedAt: null,
      manufacturerApprovedBy: null,
    },
  });

  logAudit('MANUFACTURER_REMOVED_BY_DEV', 'ADMIN', {
    removedUser: discordId,
    removedBy: interaction.user.id,
    packagesDeleted: totalPackages,
    filesDeleted: totalFiles,
    totalSize: totalSize.toString(),
  });

  const embed = new EmbedBuilder()
    .setTitle('🗑️ Hersteller entfernt')
    .setDescription(`**${displayName}** wurde als Hersteller entfernt.`)
    .addFields(
      { name: '📦 Pakete gelöscht', value: totalPackages.toString(), inline: true },
      { name: '📄 Dateien gelöscht', value: totalFiles.toString(), inline: true },
      { name: '💾 Speicher freigegeben', value: formatBytes(Number(totalSize)), inline: true },
      { name: '👤 Neue Rolle', value: 'USER', inline: true },
    )
    .setColor(0xff0000)
    .setTimestamp()
    .setFooter({ text: `Entfernt von ${interaction.user.username}` });

  await interaction.editReply({ embeds: [embed] });

  // Benachrichtigung an den entfernten User
  try {
    const dmUser = targetUser || await interaction.client.users.fetch(discordId);
    await dmUser.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('⚠️ Hersteller-Status entfernt')
          .setDescription(
            'Dein Hersteller-Status wurde von einem Administrator entfernt.\n' +
            'Alle deine Pakete und Dateien wurden gelöscht.\n\n' +
            'Bei Fragen wende dich an den Server-Administrator.'
          )
          .setColor(0xff0000)
          .setTimestamp(),
      ],
    });
  } catch {
    logger.warn(`Konnte DM an ${discordId} nicht senden.`);
  }
}

async function handleList(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const manufacturers = await prisma.user.findMany({
    where: { isManufacturer: true },
    include: {
      _count: { select: { packages: true } },
    },
    orderBy: { manufacturerApprovedAt: 'desc' },
  });

  if (manufacturers.length === 0) {
    await interaction.editReply({ content: '📭 Keine Hersteller registriert.' });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('🏭 Registrierte Hersteller')
    .setDescription(`**${manufacturers.length}** Hersteller insgesamt`)
    .setColor(0x0099ff)
    .setTimestamp();

  for (const m of manufacturers.slice(0, 25)) {
    embed.addFields({
      name: `🏭 ${m.username}`,
      value: [
        `🆔 Discord: \`${m.discordId}\``,
        `📦 Pakete: ${m._count.packages}`,
        `📅 Seit: ${m.manufacturerApprovedAt?.toLocaleDateString('de-DE') || 'unbekannt'}`,
        `🔹 Rolle: ${m.role}`,
      ].join('\n'),
      inline: true,
    });
  }

  await interaction.editReply({ embeds: [embed] });
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

export default devManufacturerCommand;
