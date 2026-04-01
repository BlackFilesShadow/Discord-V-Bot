import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
} from 'discord.js';
import { Command } from '../../types';
import { approveManufacturer } from '../../modules/registration/register';
import { logger } from '../../utils/logger';

/**
 * /admin-approve [user | user_id] — Hersteller-Anfrage annehmen.
 * Developer-Bereich: Admin kann annehmen, Einmal-Passwort wird generiert.
 */
const adminApproveCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('admin-approve')
    .setDescription('Hersteller-Anfrage annehmen')
    .addUserOption(opt =>
      opt.setName('user').setDescription('User dessen Anfrage angenommen wird').setRequired(false)
    )
    .addStringOption(opt =>
      opt.setName('user_id').setDescription('Alternativ: Discord-ID des Users').setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) as SlashCommandBuilder,
  adminOnly: true,

  execute: async (interaction: ChatInputCommandInteraction) => {
    await interaction.deferReply({ ephemeral: true });

    const targetUser = interaction.options.getUser('user');
    const userIdStr = interaction.options.getString('user_id');

    // Discord-ID ermitteln: User-Option oder String-Fallback
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
      } catch { /* ID wird als Display verwendet */ }
    } else {
      await interaction.editReply({ content: '❌ Bitte gib einen **User** oder eine **User-ID** an.' });
      return;
    }

    const result = await approveManufacturer(discordId, interaction.user.id);

    if (!result.success) {
      await interaction.editReply({ content: `❌ ${result.message}\n\n🔍 Gesuchte Discord-ID: \`${discordId}\`` });
      return;
    }

    // OTP dem User per DM senden
    try {
      const dmUser = targetUser || await interaction.client.users.fetch(discordId);
      const dm = await dmUser.createDM();
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
      logger.warn(`Konnte DM an ${discordId} nicht senden.`);
    }

    await interaction.editReply({ content: `✅ Hersteller-Anfrage von **${displayName}** angenommen. OTP wurde per DM gesendet.` });
  },
};

export default adminApproveCommand;
