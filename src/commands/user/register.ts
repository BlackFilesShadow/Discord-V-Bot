import { SlashCommandBuilder, ChatInputCommandInteraction, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { Command } from '../../types';
import { createManufacturerRequest, verifyOneTimePassword } from '../../modules/registration/register';
import prisma from '../../database/prisma';
import { config } from '../../config';
import { Colors, Brand, compactDescription, compactEmbed } from '../../utils/embedDesign';
import { buildStatusEmbed } from '../../utils/statusEmbed';
import { safeSend } from '../../utils/safeSend';
import { logger } from '../../utils/logger';

/**
 * /register Command (Sektion 1):
 * - Registrierung als Hersteller per Command
 * - Anfrage an Admin per PN
 * - Passwort-Eingabe für GUID-Bereich-Aktivierung
 */
const registerCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('register')
    .setDescription('Registriere dich als Hersteller')
    .addSubcommand(sub =>
      sub
        .setName('manufacturer')
        .setDescription('Als Hersteller registrieren')
        .addStringOption(opt =>
          opt.setName('reason').setDescription('Grund für die Registrierung').setRequired(false).setMaxLength(500)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('verify')
        .setDescription('Einmal-Passwort eingeben um GUID-Bereich zu aktivieren')
        .addStringOption(opt =>
          opt.setName('password').setDescription('Dein Einmal-Passwort').setRequired(true)
        )
    ),

  execute: async (interaction: ChatInputCommandInteraction) => {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'manufacturer') {
      await handleManufacturerRegistration(interaction);
    } else if (subcommand === 'verify') {
      await handlePasswordVerification(interaction);
    }
  },
};

async function handleManufacturerRegistration(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const reason = interaction.options.getString('reason') || undefined;
  const result = await createManufacturerRequest(
    interaction.user.id,
    interaction.user.username,
    reason
  );

  const embed = buildStatusEmbed({
    status: result.success ? 'SUCCESS' : 'ERROR',
    title: result.success ? 'Anfrage gesendet' : 'Fehler',
    description: result.message,
    fields: result.success
      ? [{ name: 'Status', value: 'Warte auf Admin-Bestätigung', inline: true }]
      : undefined,
    footerText: Brand.footerText,
  });

  if (result.success) {
    try {
      const ownerUser = await interaction.client.users.fetch(config.discord.ownerId);
      const adminEmbed = compactEmbed(Colors.Info)
        .setDescription(compactDescription('📋 Neue Hersteller-Anfrage', [
          `👤 **${interaction.user.username}** möchte Hersteller werden.`,
          `**Discord:** <@${interaction.user.id}>`,
          `**Grund:** ${(reason || 'Kein Grund angegeben').slice(0, 500)}`,
        ]));

      const approveBtn = new ButtonBuilder()
        .setCustomId(`approve_manufacturer_${interaction.user.id}`)
        .setLabel('✅ Annehmen')
        .setStyle(ButtonStyle.Success);

      const denyBtn = new ButtonBuilder()
        .setCustomId(`deny_manufacturer_${interaction.user.id}`)
        .setLabel('❌ Ablehnen')
        .setStyle(ButtonStyle.Danger);

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(approveBtn, denyBtn);

      const dm = await ownerUser.createDM();
      const sent = await safeSend(dm, { embeds: [adminEmbed], components: [row], allowedMentions: { parse: [] } });
      if (!sent) {
        logger.warn(`register.manufacturer: Admin-PN an Owner ${config.discord.ownerId} nicht zustellbar.`);
        embed.addFields({ name: '⚠️ Hinweis', value: 'Admin-Benachrichtigung konnte nicht zugestellt werden, dein Antrag ist aber gespeichert.', inline: false });
      }
    } catch (e) {
      logger.warn(`register.manufacturer: Owner-Lookup fehlgeschlagen: ${String(e)}`);
      embed.addFields({ name: '⚠️ Hinweis', value: 'Admin-Benachrichtigung konnte nicht zugestellt werden, dein Antrag ist aber gespeichert.', inline: false });
    }
  }

  await interaction.editReply({ embeds: [embed] });
}

async function handlePasswordVerification(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const password = interaction.options.getString('password', true);

  const user = await prisma.user.findUnique({
    where: { discordId: interaction.user.id },
  });

  if (!user) {
    await interaction.editReply({ content: '❌ Du bist nicht registriert.' });
    return;
  }

  const result = await verifyOneTimePassword(user.id, password);

  const embed = buildStatusEmbed({
    status: result.success ? 'SUCCESS' : 'ERROR',
    title: result.success ? 'Verifizierung erfolgreich' : 'Verifizierung fehlgeschlagen',
    description: result.message,
    fields: result.success
      ? [{ name: 'Status', value: 'Aktiv – Uploads freigeschaltet', inline: true }]
      : undefined,
    footerText: Brand.footerText,
  });

  await interaction.editReply({ embeds: [embed] });
}

export default registerCommand;
