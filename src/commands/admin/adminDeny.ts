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
 * /admin-deny [user] — Hersteller-Anfrage ablehnen.
 */
const adminDenyCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('admin-deny')
    .setDescription('Hersteller-Anfrage ablehnen')
    .addUserOption(opt =>
      opt.setName('user').setDescription('User dessen Anfrage abgelehnt wird').setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('grund').setDescription('Ablehnungsgrund').setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) as SlashCommandBuilder,
  adminOnly: true,

  execute: async (interaction: ChatInputCommandInteraction) => {
    await interaction.deferReply({ ephemeral: true });

    const targetUser = interaction.options.getUser('user', true);
    const reason = interaction.options.getString('grund') || 'Kein Grund angegeben';

    const result = await denyManufacturer(targetUser.id, interaction.user.id, reason);

    if (!result.success) {
      await interaction.editReply({ content: `❌ ${result.message}` });
      return;
    }

    try {
      const dm = await targetUser.createDM();
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
      logger.warn(`Konnte DM an ${targetUser.id} nicht senden.`);
    }

    await interaction.editReply({ content: `❌ Hersteller-Anfrage von ${targetUser.username} abgelehnt.` });
  },
};

export default adminDenyCommand;
