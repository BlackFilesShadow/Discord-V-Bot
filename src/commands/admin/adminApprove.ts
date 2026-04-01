import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
} from 'discord.js';
import { Command } from '../../types';
import { approveManufacturer, denyManufacturer } from '../../modules/registration/register';
import { logger, logAudit } from '../../utils/logger';

/**
 * /admin-approve [user] — Hersteller-Anfrage annehmen.
 * Developer-Bereich: Admin kann annehmen, Einmal-Passwort wird generiert.
 */
const adminApproveCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('admin-approve')
    .setDescription('Hersteller-Anfrage annehmen')
    .addUserOption(opt =>
      opt.setName('user').setDescription('User dessen Anfrage angenommen wird').setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) as SlashCommandBuilder,
  adminOnly: true,

  execute: async (interaction: ChatInputCommandInteraction) => {
    await interaction.deferReply({ ephemeral: true });

    const targetUser = interaction.options.getUser('user', true);

    const result = await approveManufacturer(targetUser.id, interaction.user.id);

    if (!result.success) {
      await interaction.editReply({ content: `❌ ${result.message}` });
      return;
    }

    // OTP dem User per DM senden
    try {
      const dm = await targetUser.createDM();
      await dm.send({
        embeds: [
          new EmbedBuilder()
            .setTitle('✅ Hersteller-Anfrage angenommen!')
            .setDescription(
              `Deine Anfrage wurde von einem Admin angenommen.\n\n` +
              `**Dein Einmal-Passwort:** \`${result.otp}\`\n\n` +
              `⚠️ Dieses Passwort ist **30 Minuten gültig** und kann nur **einmal** verwendet werden.\n` +
              `Verwende \`/register verify\` um dich zu verifizieren.`
            )
            .setColor(0x00ff00)
            .setTimestamp(),
        ],
      });
    } catch {
      logger.warn(`Konnte DM an ${targetUser.id} nicht senden.`);
    }

    await interaction.editReply({ content: `✅ Hersteller-Anfrage von ${targetUser.username} angenommen. OTP wurde per DM gesendet.` });
  },
};

export default adminApproveCommand;
