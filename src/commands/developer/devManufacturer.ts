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
          opt.setName('user_id').setDescription('Alternativ: Discord-ID, interne GUID oder Username').setRequired(false)
        )
        .addBooleanOption(opt =>
          opt.setName('force').setDescription('Auch entfernen wenn isManufacturer=false (nur Aufr\u00e4umen)').setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('Alle registrierten Hersteller auflisten')
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) as SlashCommandBuilder,
  devOnly: true,

  execute: async (interaction: ChatInputCommandInteraction) => {
    // SOFORT defern (innerhalb der 3-Sekunden-Frist von Discord),
    // bevor wir irgendeine Logik ausfuehren \u2013 sonst Code 10062.
    try {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ ephemeral: true });
      }
    } catch (deferErr) {
      logger.warn(`dev-manufacturer: deferReply fehlgeschlagen: ${(deferErr as Error).message}`);
      return;
    }

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'remove') {
      await handleRemove(interaction);
    } else if (subcommand === 'list') {
      await handleList(interaction);
    }
  },
};

async function findManufacturer(where: { discordId?: string; id?: string }) {
  return prisma.user.findUnique({
    where: where as any,
    include: {
      packages: {
        include: {
          files: { select: { id: true, filePath: true, originalName: true } },
        },
      },
      manufacturerRequest: true,
    },
  });
}

async function findByUsername(username: string) {
  // case-insensitive Suche, gibt erste Trefferin zur\u00fcck
  return prisma.user.findFirst({
    where: { username: { equals: username, mode: 'insensitive' } },
    include: {
      packages: {
        include: {
          files: { select: { id: true, filePath: true, originalName: true } },
        },
      },
      manufacturerRequest: true,
    },
  });
}

async function handleRemove(interaction: ChatInputCommandInteraction): Promise<void> {
  // defer wurde bereits in execute() aufgerufen

  const targetUser = interaction.options.getUser('user');
  const userIdStr = interaction.options.getString('user_id');
  const force = interaction.options.getBoolean('force') ?? false;

  let dbUser: Awaited<ReturnType<typeof findManufacturer>> | null = null;
  let displayName: string;
  let lookupMethod = '';

  if (targetUser) {
    dbUser = await findManufacturer({ discordId: targetUser.id });
    displayName = targetUser.username;
    lookupMethod = `Discord-User-Picker (id=${targetUser.id})`;
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
      // Fallback: Username
      dbUser = await findByUsername(cleaned);
      lookupMethod = `Username (${cleaned})`;
    }
    // Wenn Discord-ID-Suche fehlschl\u00e4gt, Username-Fallback versuchen
    if (!dbUser && !isUuid) {
      const byName = await findByUsername(cleaned);
      if (byName) {
        dbUser = byName;
        lookupMethod += ' \u2192 fallback Username';
      }
    }
    displayName = dbUser?.username || cleaned;
    if (dbUser) {
      try {
        const fetched = await interaction.client.users.fetch(dbUser.discordId);
        displayName = fetched.username;
      } catch { /* ID als Display */ }
    }
  } else {
    await interaction.editReply({ content: '❌ Bitte gib einen **User**, eine **Discord-ID**, eine **GUID** oder einen **Username** an.' });
    return;
  }

  const discordId = dbUser?.discordId ?? '';

  // User in DB finden
  if (!dbUser) {
    const searched = userIdStr ? `\`${userIdStr}\`` : `<@${targetUser?.id}>`;
    await interaction.editReply({
      content:
        `\u274c User **${displayName}** nicht in der Datenbank gefunden.\n` +
        `\u2022 Suchart: ${lookupMethod}\n` +
        `\u2022 Eingabe: ${searched}\n\n` +
        `Tipp: Mit \`/dev-manufacturer list\` siehst du alle Hersteller mit Discord-ID und GUID.`,
    });
    return;
  }

  if (!dbUser.isManufacturer && !force) {
    await interaction.editReply({
      content:
        `\u274c **${displayName}** ist kein Hersteller (isManufacturer=false).\n` +
        `\u2022 Discord-ID: \`${dbUser.discordId}\`\n` +
        `\u2022 GUID: \`${dbUser.id}\`\n` +
        `\u2022 Rolle: \`${dbUser.role}\` | Status: \`${dbUser.status}\`\n` +
        `\u2022 Suchart: ${lookupMethod}\n\n` +
        `Wenn du trotzdem Pakete/Daten aufr\u00e4umen willst, nutze die Option \`force:true\`.`,
    });
    return;
  }

  // Statistiken sammeln vor dem Löschen
  const totalPackages = dbUser.packages.length;
  const activePackages = dbUser.packages.filter((p) => !p.isDeleted).length;
  const softDeletedPackages = totalPackages - activePackages;
  let totalFiles = 0;
  let totalSize = BigInt(0);

  for (const pkg of dbUser.packages) {
    totalFiles += pkg.files.length;
    totalSize += pkg.totalSize;
  }

  // ATOMARE STATUS-AENDERUNG ZUERST: User sofort vom Hersteller-Status entfernen,
  // damit er waehrend des Cleanups nicht parallel weiter uploaden kann (Race-Schutz).
  // ManufacturerRequest und OTPs werden in derselben Transaction geloescht, damit die
  // DB nie in einem halbgaren Zustand zurueckbleibt (User=USER aber Request=APPROVED).
  let requestsDeleted: { count: number };
  let otpsDeleted: { count: number };
  try {
    [, requestsDeleted, otpsDeleted] = await prisma.$transaction([
      prisma.user.update({
        where: { id: dbUser.id },
        data: {
          isManufacturer: false,
          role: 'USER',
          manufacturerApprovedAt: null,
          manufacturerApprovedBy: null,
        },
      }),
      prisma.manufacturerRequest.deleteMany({ where: { userId: dbUser.id } }),
      prisma.oneTimePassword.deleteMany({ where: { userId: dbUser.id } }),
    ]);
  } catch (txErr) {
    const msg = (txErr as Error).message;
    logger.error(`dev-manufacturer remove: Transaction fehlgeschlagen fuer ${dbUser.id}: ${msg}`);
    await interaction.editReply({
      content:
        `\u274c Reset fehlgeschlagen \u2013 DB-Transaction abgebrochen.\n` +
        `\u2022 User: \`${displayName}\` (Discord \`${dbUser.discordId}\`, GUID \`${dbUser.id}\`)\n` +
        `\u2022 Fehler: \`${msg}\`\n\n` +
        `Der Hersteller-Status wurde NICHT geaendert. Bitte Logs pruefen und erneut versuchen.`,
    });
    return;
  }

  // DANACH: Pakete/Dateien aufraeumen (best-effort, nicht-transactional wegen Filesystem).
  // Selbst wenn hier etwas schief geht, ist der User schon kein Hersteller mehr und kann
  // sich sauber neu registrieren. Verwaiste Dateien koennen manuell weggeraeumt werden.
  for (const pkg of dbUser.packages) {
    try {
      await deletePackage(pkg.id, interaction.user.id, true);
    } catch (err) {
      logger.error(`Paket ${pkg.id} konnte nicht geloescht werden: ${(err as Error).message}`);
    }
  }

  // Upload-Verzeichnis des Users komplett löschen
  const userDir = path.join(config.upload.dir, dbUser.id);
  let dirDeleted = false;
  try {
    await fs.rm(userDir, { recursive: true, force: true });
    dirDeleted = true;
    logger.info(`Upload-Bereich gelöscht: ${userDir}`);
  } catch (err) {
    logger.error(`Konnte Upload-Bereich nicht löschen (${userDir}): ${(err as Error).message}`);
  }

  logAudit('MANUFACTURER_REMOVED_BY_DEV', 'ADMIN', {
    removedUser: discordId,
    removedBy: interaction.user.id,
    packagesDeleted: totalPackages,
    filesDeleted: totalFiles,
    otpsDeleted: otpsDeleted.count,
    requestsDeleted: requestsDeleted.count,
    totalSize: totalSize.toString(),
  });

  const pkgValue =
    softDeletedPackages > 0
      ? `${totalPackages} (davon ${activePackages} aktiv, ${softDeletedPackages} soft-deleted)`
      : totalPackages.toString();

  const embed = new EmbedBuilder()
    .setTitle('🗑️ Hersteller entfernt')
    .setDescription(`**${displayName}** wurde als Hersteller entfernt.`)
    .addFields(
      { name: '📦 Pakete gelöscht', value: pkgValue, inline: true },
      { name: '📄 Dateien gelöscht', value: totalFiles.toString(), inline: true },
      { name: '💾 Speicher freigegeben', value: formatBytes(Number(totalSize)), inline: true },
      { name: '📂 Upload-Bereich', value: dirDeleted ? '✅ gelöscht' : '⚠️ nicht entfernt', inline: true },
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
  // defer wurde bereits in execute() aufgerufen

  const manufacturers = await prisma.user.findMany({
    where: { isManufacturer: true },
    include: {
      packages: { where: { isDeleted: false }, select: { id: true } },
    },
    orderBy: { manufacturerApprovedAt: 'desc' },
  });

  if (manufacturers.length === 0) {
    await interaction.editReply({ content: '📭 Keine Hersteller registriert.' });
    return;
  }

  // Pro Hersteller: aktive Pakete (isDeleted=false) UND gesamt (inkl. Soft-
  // Delete) zaehlen. Letztere Zahl entspricht dem, was /dev-manufacturer
  // remove tatsaechlich physisch wegraeumt - so entsteht kein Widerspruch
  // zwischen "5 Pakete laut list" und "6 Pakete geloescht laut remove".
  const packageCounts: Record<string, { active: number; total: number }> = {};
  for (const m of manufacturers) {
    const pkgs = await prisma.package.findMany({
      where: { userId: m.id },
      select: { name: true, isDeleted: true },
    });
    const activeNames = new Set(
      pkgs.filter((p) => !p.isDeleted).map((p) => p.name.toLowerCase()),
    );
    packageCounts[m.id] = { active: activeNames.size, total: pkgs.length };
  }

  const embed = new EmbedBuilder()
    .setTitle('🏭 Registrierte Hersteller')
    .setDescription(`**${manufacturers.length}** Hersteller insgesamt`)
    .setColor(0x0099ff)
    .setTimestamp();

  for (const m of manufacturers.slice(0, 25)) {
    const pc = packageCounts[m.id];
    const pkgLine =
      pc.total > pc.active
        ? `📦 Pakete: ${pc.active} aktiv (${pc.total - pc.active} soft-deleted, gesamt ${pc.total})`
        : `📦 Pakete: ${pc.active}`;
    embed.addFields({
      name: `🏭 ${m.username}`,
      value: [
        `🆔 Discord: \`${m.discordId}\``,
        `🔑 GUID: \`${m.id}\``,
        pkgLine,
        `📅 Seit: ${m.manufacturerApprovedAt?.toLocaleDateString('de-DE') || 'unbekannt'}`,
        `🔹 Rolle: ${m.role}`,
      ].join('\n'),
      inline: false,
    });
  }

  await interaction.editReply({ embeds: [embed] });
  return;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

export default devManufacturerCommand;
