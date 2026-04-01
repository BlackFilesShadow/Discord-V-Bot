import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
} from 'discord.js';
import { Command } from '../../types';
import { denyManufacturer } from '../../modules/registration/register';
import { logger } from '../../utils/logger';

/**
 * /admin-deny [user | user_id] — Hersteller-Anfrage ablehnen.
 */
const adminDenyCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('admin-deny')
    .setDescription('Hersteller-Anfrage ablehnen')
    .addUserOption(opt =>
      opt.setName('user').setDescription('User dessen Anfrage abgelehnt wird').setRequired(false)
    )
    .addStringOption(opt =>
      opt.setName('user_id').setDescription('Alternativ: Discord-ID des Users').setRequired(false)
    )
    .addStringOption(opt =>
      opt.setName('grund').setDescription('Ablehnungsgrund').setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) as SlashCommandBuilder,
  adminOnly: true,

  execute: async (interaction: ChatInputCommandInteraction) => {
    await interaction.deferReply({ ephemeral: true });

    const targetUser = interaction.options.getUser('user');
    const userIdStr = interaction.options.getString('user_id');
    const reason = interaction.options.getString('grund') || 'Kein Grund angegeben';

    // Discord-ID ermitteln: User-Option oder String-Fallback
    let discordId: string;
    let displayName: string;

    if (targetUser) {
      discordId = targetUser.id;
      displayName = targetUser.username;
    } else if (userIdStr) {
      discordId = userIdStr.replace(/[<@!>]/g, '').trim();
      displayName = discordId;
      // Versuche den User aufzulösen für Display
      try {
        const fetched = await interaction.client.users.fetch(discordId);
        displayName = fetched.username;
      } catch { /* ID wird als Display verwendet */ }
    } else {
      await interaction.editReply({ content: '❌ Bitte gib einen **User** oder eine **User-ID** an.' });
      return;
    }

    const result = await denyManufacturer(discordId, interaction.user.id, reason);

    if (!result.success) {
      await interaction.editReply({ content: `❌ ${result.message}\n\n🔍 Gesuchte Discord-ID: \`${discordId}\`` });
      return;
    }

    try {
      const dmUser = targetUser || await interaction.client.users.fetch(discordId);
      const dm = await dmUser.createDM();
      await dm.send({
        embeds: [
          new EmbedBuilder()
            .setTitle('❌ Hersteller-Anfrage abgelehnt')
            .setDescription(`Deine Anfrage wurde leider abgelehnt.\n\n**Grund:** ${reason}`)
            .setColor(0xff0000)
            .setTimestamp(),
        ],
      });
    } catch {
      logger.warn(`Konnte DM an ${discordId} nicht senden.`);
    }

    await interaction.editReply({ content: `❌ Hersteller-Anfrage von **${displayName}** abgelehnt.` });
  },
};

export default adminDenyCommand;
