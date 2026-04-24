import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { Command } from '../../types';
import { Colors, Brand, vEmbed } from '../../utils/embedDesign';

/**
 * /ping — schnelle Latenz-Anzeige.
 * Misst Round-Trip (defer -> editReply) sowie WebSocket-Heartbeat.
 */
const pingCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Misst Bot- und WebSocket-Latenz'),
  cooldown: 5,
  execute: async (interaction: ChatInputCommandInteraction) => {
    const start = Date.now();
    await interaction.deferReply({ ephemeral: true });
    const rtt = Date.now() - start;
    const wsPing = interaction.client.ws.ping;

    const wsLabel = wsPing < 0 ? 'n/a' : `${wsPing} ms`;
    const color =
      wsPing < 0 ? Colors.Warning :
      wsPing < 150 ? Colors.Success :
      wsPing < 400 ? Colors.Warning :
      Colors.Error;

    const embed = vEmbed(color)
      .setTitle('🏓 Pong!')
      .setDescription(
        [
          Brand.divider,
          `**Roundtrip:** \`${rtt} ms\``,
          `**WebSocket:** \`${wsLabel}\``,
          Brand.divider,
        ].join('\n')
      );

    await interaction.editReply({ embeds: [embed] });
  },
};

export default pingCommand;
