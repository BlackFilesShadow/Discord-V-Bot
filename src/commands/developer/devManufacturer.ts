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
import { logger, logAudit } from '../../utils/logger';
import fs from 'fs/promises';
import path from 'path';
import { config } from '../../config';
import { formatBytes, vEmbed } from '../../utils/embedDesign';

/**
 * /dev-manufacturer — ausschliesslich Developer.
 *
 * remove:
 * - Identifier-Suche ist eindeutig; doppelte Usernames werden nie geraten.
 * - Herstellerstatus, Request, OTPs und ALLE Pakete werden in EINER DB-
 *   Transaktion entfernt. Uploads/ValidationResult folgen per Cascade.
 * - Dateisystem-Cleanup erfolgt erst nach erfolgreichem Commit.
 *
 * list:
 * - zeigt nur kanonisch aktive Hersteller;
 * - keine stille 25er-Abschneidung, Ausgabe wird ueber Embeds/Folgenachrichten
 *   paginiert.
 */
const devManufacturerCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('dev-manufacturer')
    .setDescription('Hersteller-Verwaltung (Developer)')
    .addSubcommand(sub => sub.setName('remove')
      .setDescription('Hersteller entfernen und gesamten Bereich loeschen')
      .addUserOption(opt => opt.setName('user').setDescription('Hersteller-User').setRequired(false))
      .addStringOption(opt => opt.setName('user_id').setDescription('Discord-ID, interne GUID oder eindeutiger Username').setRequired(false))
      .addBooleanOption(opt => opt.setName('force').setDescription('Auch asymmetrische Herstellerdaten aufraeumen').setRequired(false)))
    .addSubcommand(sub => sub.setName('list').setDescription('Alle aktiven Hersteller auflisten'))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) as SlashCommandBuilder,
  devOnly: true,

  execute: async (interaction: ChatInputCommandInteraction) => {
    try {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      }
    } catch (deferErr) {
      logger.warn(`dev-manufacturer: deferReply fehlgeschlagen: ${(deferErr as Error).message}`);
      return;
    }

    const subcommand = interaction.options.getSubcommand();
    if (subcommand === 'remove') await handleRemove(interaction);
    else if (subcommand === 'list') await handleList(interaction);
  },
};

function statusEmbed(
  kind: 'INFO' | 'SUCCESS' | 'ERROR' | 'WARNING',
  title: string,
  description: string,
): EmbedBuilder {
  const color = kind === 'SUCCESS' ? 0x57F287 : kind === 'ERROR' ? 0xED4245 : kind === 'WARNING' ? 0xFEE75C : 0x5865F2;
  return vEmbed(color).setTitle(title).setDescription(description);
}

const userInclude = {
  packages: {
    include: {
      files: { select: { id: true, filePath: true, originalName: true } },
    },
  },
  manufacturerRequest: true,
} satisfies Prisma.UserInclude;

async function findManufacturer(where: Prisma.UserWhereUniqueInput) {
  return prisma.user.findUnique({ where, include: userInclude });
}

async function findUsernameMatches(username: string) {
  return prisma.user.findMany({
    where: { username: { equals: username, mode: 'insensitive' } },
    include: userInclude,
    orderBy: { id: 'asc' },
    take: 2,
  });
}

async function handleRemove(interaction: ChatInputCommandInteraction): Promise<void> {
  const targetUser = interaction.options.getUser('user');
  const userIdStr = interaction.options.getString('user_id');
  const force = interaction.options.getBoolean('force') ?? false;

  let dbUser: Awaited<ReturnType<typeof findManufacturer>> | null = null;
  let lookupMethod = '';
  let displayName = targetUser?.username ?? userIdStr?.trim() ?? 'unbekannt';

  if (targetUser) {
    dbUser = await findManufacturer({ discordId: targetUser.id });
    lookupMethod = `Discord-User-Picker (${targetUser.id})`;
  } else if (userIdStr) {
    const cleaned = userIdStr.replace(/[<@!>]/g, '').trim();
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleaned);
    const isSnowflake = /^\d{17,20}$/.test(cleaned);

    if (isUuid) {
      dbUser = await findManufacturer({ id: cleaned });
      lookupMethod = `GUID (${cleaned})`;
    } else if (isSnowflake) {
      dbUser = await findManufacturer({ discordId: cleaned });
      lookupMethod = `Discord-ID (${cleaned})`;
    } else {
      const matches = await findUsernameMatches(cleaned);
      if (matches.length > 1) {
        await interaction.editReply({
          embeds: [statusEmbed(
            'ERROR',
            '❌ Username nicht eindeutig',
            `Mehrere Datenbank-User heissen **${cleaned}**. Aus Sicherheitsgruenden wird niemand automatisch ausgewaehlt. Nutze die Discord-ID oder interne GUID.`,
          )],
          allowedMentions: { parse: [] },
        });
        return;
      }
      dbUser = matches[0] ?? null;
      lookupMethod = `Username (${cleaned})`;
    }
    displayName = dbUser?.username ?? cleaned;
  } else {
    await interaction.editReply({
      embeds: [statusEmbed('ERROR', '❌ Ziel fehlt', 'Bitte gib einen **User**, eine **Discord-ID**, eine **GUID** oder einen **eindeutigen Username** an.')],
      allowedMentions: { parse: [] },
    });
    return;
  }

  if (!dbUser) {
    await interaction.editReply({
      embeds: [statusEmbed(
        'ERROR',
        '❌ User nicht gefunden',
        `**${displayName}** wurde nicht in der Datenbank gefunden.\n\nSuchart: ${lookupMethod}\nNutze \`/dev-manufacturer list\` fuer die kanonischen Discord-IDs und GUIDs.`,
      )],
      allowedMentions: { parse: [] },
    });
    return;
  }

  const canonicalManufacturer = dbUser.status === 'ACTIVE' && dbUser.isManufacturer && dbUser.role === 'MANUFACTURER';
  if (!canonicalManufacturer && !force) {
    await interaction.editReply({
      embeds: [statusEmbed(
        'WARNING',
        '⚠️ Kein kanonisch aktiver Hersteller',
        `**${displayName}** ist nicht vollstaendig als Hersteller aktiv.\n\n` +
          `Discord-ID: \`${dbUser.discordId}\`\nGUID: \`${dbUser.id}\`\n` +
          `Rolle: \`${dbUser.role}\` · Status: \`${dbUser.status}\` · Flag: \`${dbUser.isManufacturer}\`\n\n` +
          'Wenn du asymmetrische Alt-/Restdaten bewusst bereinigen willst, verwende `force:true`.',
      )],
      allowedMentions: { parse: [] },
    });
    return;
  }

  const totalPackages = dbUser.packages.length;
  const activePackages = dbUser.packages.filter(pkg => !pkg.isDeleted).length;
  const softDeletedPackages = totalPackages - activePackages;
  const totalFiles = dbUser.packages.reduce((sum, pkg) => sum + pkg.files.length, 0);
  const totalSize = dbUser.packages.reduce((sum, pkg) => sum + pkg.totalSize, 0n);

  let requestsDeleted = 0;
  let otpsDeleted = 0;
  let packagesDeleted = 0;
  try {
    const result = await prisma.$transaction(async tx => {
      await tx.user.update({
        where: { id: dbUser!.id },
        data: {
          isManufacturer: false,
          role: 'USER',
          manufacturerApprovedAt: null,
          manufacturerApprovedBy: null,
        },
      });
      const requestResult = await tx.manufacturerRequest.deleteMany({ where: { userId: dbUser!.id } });
      const otpResult = await tx.oneTimePassword.deleteMany({ where: { userId: dbUser!.id } });
      const packageResult = await tx.package.deleteMany({ where: { userId: dbUser!.id } });
      return {
        requestsDeleted: requestResult.count,
        otpsDeleted: otpResult.count,
        packagesDeleted: packageResult.count,
      };
    });
    requestsDeleted = result.requestsDeleted;
    otpsDeleted = result.otpsDeleted;
    packagesDeleted = result.packagesDeleted;
  } catch (txErr) {
    logger.error(`dev-manufacturer remove: DB-Transaction fehlgeschlagen fuer ${dbUser.id}:`, txErr as Error);
    await interaction.editReply({
      embeds: [statusEmbed(
        'ERROR',
        '❌ Hersteller-Reset abgebrochen',
        `Die Datenbank konnte den Reset fuer **${displayName}** nicht vollstaendig committen. Es wurde kein absichtlich halbfertiger Reset bestaetigt. Bitte Server-Logs pruefen und erneut versuchen.`,
      )],
      allowedMentions: { parse: [] },
    });
    return;
  }

  const userDir = path.join(config.upload.dir, dbUser.id);
  let dirDeleted = false;
  try {
    await fs.rm(userDir, { recursive: true, force: true });
    dirDeleted = true;
  } catch (err) {
    logger.error(`Konnte Upload-Bereich nicht loeschen (${userDir}):`, err as Error);
  }

  logAudit('MANUFACTURER_REMOVED_BY_DEV', 'ADMIN', {
    removedUser: dbUser.discordId,
    removedBy: interaction.user.id,
    packagesDeleted,
    filesDeleted: totalFiles,
    otpsDeleted,
    requestsDeleted,
    totalSize: totalSize.toString(),
    filesystemDeleted: dirDeleted,
    force,
  });

  const pkgValue = softDeletedPackages > 0
    ? `${packagesDeleted} (vorher ${activePackages} aktiv, ${softDeletedPackages} soft-deleted)`
    : packagesDeleted.toString();
  const resultEmbed = statusEmbed(
    dirDeleted ? 'SUCCESS' : 'WARNING',
    dirDeleted ? '✅ Hersteller vollstaendig entfernt' : '⚠️ Hersteller entfernt, Dateisystem-Cleanup offen',
    `**${displayName}** hat keine Herstellerrechte und keine Herstellerpakete mehr in der Datenbank.`,
  ).addFields(
    { name: '📦 Pakete DB', value: pkgValue, inline: true },
    { name: '📄 Dateien vorher', value: totalFiles.toString(), inline: true },
    { name: '💾 Datenmenge vorher', value: formatBytes(Number(totalSize)), inline: true },
    { name: '🔑 OTPs geloescht', value: otpsDeleted.toString(), inline: true },
    { name: '📝 Requests geloescht', value: requestsDeleted.toString(), inline: true },
    { name: '📂 Upload-Verzeichnis', value: dirDeleted ? 'geloescht' : 'manuell pruefen', inline: true },
  ).setFooter({ text: `Entfernt von ${interaction.user.username}` });

  await interaction.editReply({ embeds: [resultEmbed], allowedMentions: { parse: [] } });

  try {
    const dmUser = targetUser ?? await interaction.client.users.fetch(dbUser.discordId);
    await dmUser.send({
      embeds: [statusEmbed(
        'INFO',
        'Hersteller-Status entfernt',
        'Dein Hersteller-Status und der Zugriff auf deine Herstellerpakete wurden administrativ entfernt. Bei Fragen wende dich an den Administrator.',
      )],
      allowedMentions: { parse: [] },
    });
  } catch {
    logger.warn(`Konnte DM an ${dbUser.discordId} nicht senden.`);
  }
}

async function handleList(interaction: ChatInputCommandInteraction): Promise<void> {
  const manufacturers = await prisma.user.findMany({
    where: { status: 'ACTIVE', isManufacturer: true, role: 'MANUFACTURER' },
    include: {
      packages: { select: { id: true, isDeleted: true } },
    },
    orderBy: [{ manufacturerApprovedAt: 'desc' }, { username: 'asc' }],
  });

  if (manufacturers.length === 0) {
    await interaction.editReply({
      embeds: [statusEmbed('INFO', '📭 Keine Hersteller', 'Aktuell gibt es keine kanonisch aktiven Hersteller.')],
      allowedMentions: { parse: [] },
    });
    return;
  }

  const embeds: EmbedBuilder[] = [];
  for (let offset = 0; offset < manufacturers.length; offset += 25) {
    const page = manufacturers.slice(offset, offset + 25);
    const pageNo = Math.floor(offset / 25) + 1;
    const pageCount = Math.ceil(manufacturers.length / 25);
    const embed = vEmbed()
      .setTitle(`🏭 Aktive Hersteller${pageCount > 1 ? ` · ${pageNo}/${pageCount}` : ''}`)
      .setDescription(`**${manufacturers.length}** kanonisch aktive Hersteller insgesamt`)
      .setColor(0x5865F2);

    for (const manufacturer of page) {
      const active = manufacturer.packages.filter(pkg => !pkg.isDeleted).length;
      const deleted = manufacturer.packages.length - active;
      embed.addFields({
        name: `🏭 ${manufacturer.username}`.slice(0, 256),
        value: [
          `Discord: \`${manufacturer.discordId}\``,
          `GUID: \`${manufacturer.id}\``,
          `Pakete: ${active} aktiv${deleted > 0 ? ` · ${deleted} soft-deleted` : ''}`,
          `Seit: ${manufacturer.manufacturerApprovedAt?.toLocaleDateString('de-DE') ?? 'unbekannt'}`,
        ].join('\n'),
        inline: false,
      });
    }
    embeds.push(embed);
  }

  for (let index = 0; index < embeds.length; index += 10) {
    const chunk = embeds.slice(index, index + 10);
    if (index === 0) {
      await interaction.editReply({ embeds: chunk, allowedMentions: { parse: [] } });
    } else {
      await interaction.followUp({
        embeds: chunk,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
    }
  }
}

export default devManufacturerCommand;
