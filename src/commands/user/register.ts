import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { Command } from '../../types';
import { createManufacturerRequest, verifyOneTimePassword } from '../../modules/registration/register';
import prisma from '../../database/prisma';
import { config } from '../../config';

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
          opt.setName('reason').setDescription('Grund für die Registrierung').setRequired(false)
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
  await interaction.deferReply({ ephemeral: true });

  const reason = interaction.options.getString('reason') || undefined;
  const result = await createManufacturerRequest(
    interaction.user.id,
    interaction.user.username,
    reason
  );

  const embed = new EmbedBuilder()
    .setTitle(result.success ? '✅ Anfrage gesendet' : '❌ Fehler')
    .setDescription(result.message)
    .setColor(result.success ? 0x00ff00 : 0xff0000)
    .setTimestamp();

  if (result.success) {
    embed.addFields({ name: 'Status', value: 'Warte auf Admin-Bestätigung', inline: true });

    // Admin per PN benachrichtigen (Sektion 1: Anfrage an Admin per PN)
    try {
      const ownerUser = await interaction.client.users.fetch(config.discord.ownerId);
      const adminEmbed = new EmbedBuilder()
        .setTitle('📋 Neue Hersteller-Anfrage')
        .setDescription(`**${interaction.user.username}** (${interaction.user.id}) möchte Hersteller werden.`)
        .addFields(
          { name: 'Grund', value: reason || 'Kein Grund angegeben', inline: false },
          { name: 'User-ID', value: interaction.user.id, inline: true },
          { name: 'GUID', value: result.userId || 'N/A', inline: true },
        )
        .setColor(0x0099ff)
        .setTimestamp()
        .setFooter({ text: 'Verwende /admin-approve oder /admin-deny' });

      await ownerUser.send({ embeds: [adminEmbed] });
    } catch (e) {
      // Admin-PN konnte nicht gesendet werden
    }
  }

  await interaction.editReply({ embeds: [embed] });
}

async function handlePasswordVerification(interaction: ChatInputCommandInteraction) {
  // Ephemeral damit das Passwort nicht sichtbar ist
  await interaction.deferReply({ ephemeral: true });

  const password = interaction.options.getString('password', true);

  const user = await prisma.user.findUnique({
    where: { discordId: interaction.user.id },
  });

  if (!user) {
    await interaction.editReply({ content: '❌ Du bist nicht registriert.' });
    return;
  }

  const result = await verifyOneTimePassword(user.id, password);

  const embed = new EmbedBuilder()
    .setTitle(result.success ? '✅ Verifizierung erfolgreich' : '❌ Verifizierung fehlgeschlagen')
    .setDescription(result.message)
    .setColor(result.success ? 0x00ff00 : 0xff0000)
    .setTimestamp();

  if (result.success) {
    embed.addFields(
      { name: 'GUID', value: user.id, inline: true },
      { name: 'Status', value: 'Aktiv – Uploads freigeschaltet', inline: true },
    );
  }

  await interaction.editReply({ embeds: [embed] });
}

export default registerCommand;
