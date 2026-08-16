import {
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  SlashCommandSubcommandBuilder,
} from 'discord.js';
import type { Command } from '../../types';
import { withGuildScope } from '../middleware/withGuildScope';
import { MAX_GAME_SERVERS_PER_GUILD } from '../../modules/nitrado/gameServerScope';
import {
  buyLotteryTickets,
  createLotteryEmbed,
  getCurrentLotteryRound,
  getLotteryEntry,
  refreshLotteryMessage,
} from '../../modules/economy/lottery';
import { getConfig } from '../../modules/economy/repository';
import { logger, logAudit } from '../../utils/logger';

function addSlotOption(builder: SlashCommandSubcommandBuilder): SlashCommandSubcommandBuilder {
  return builder.addIntegerOption(o => o
    .setName('slot')
    .setDescription('Gameserver-Slot (bei mehreren Servern erforderlich)')
    .setRequired(false)
    .setMinValue(1)
    .setMaxValue(MAX_GAME_SERVERS_PER_GUILD));
}

async function replyError(interaction: Parameters<Command['execute']>[0], message: string): Promise<void> {
  await interaction.reply({
    embeds: [new EmbedBuilder().setColor(0xE74C3C).setTitle('Lotterie').setDescription(message)],
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

const data = new SlashCommandBuilder()
  .setName('lottery')
  .setDescription('Economy-Lotterie dieses Gameservers.')
  .addSubcommand(sc => addSlotOption(sc
    .setName('status')
    .setDescription('Zeigt die aktuell laufende Lotterie.')))
  .addSubcommand(sc => addSlotOption(sc
    .setName('buy')
    .setDescription('Kauft Tickets aus deinem Wallet.')
    .addIntegerOption(o => o
      .setName('tickets')
      .setDescription('Anzahl Tickets (1–100 pro Kauf)')
      .setRequired(true)
      .setMinValue(1)
      .setMaxValue(100))))
  .addSubcommand(sc => addSlotOption(sc
    .setName('my')
    .setDescription('Zeigt deine Tickets in der aktuellen Lotterie.')));

export const lotteryCommand: Command = {
  data,
  cooldown: 2,
  execute: withGuildScope({ requireSlotToggle: 'economyActive', acceptSlotOption: true }, async (interaction, scope) => {
    const connId = scope.nitradoConnId!;
    const sub = interaction.options.getSubcommand();
    const round = await getCurrentLotteryRound(scope.guildId, connId);
    if (!round) {
      await replyError(interaction, 'Auf diesem Gameserver läuft aktuell keine Lotterie.');
      return;
    }

    if (sub === 'status') {
      await interaction.reply({
        embeds: [await createLotteryEmbed(round)],
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    const entry = await getLotteryEntry(round.id, scope.actorDiscordId);
    if (sub === 'my') {
      const cfg = await getConfig(scope.guildId, connId);
      const tickets = entry?.ticketCount ?? 0;
      const paid = entry?.totalPaid ?? 0n;
      await interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(0x3498DB)
          .setTitle('🎟️ Deine Lotterie-Tickets')
          .setDescription([
            `**Tickets:** ${tickets} / ${round.maxTicketsPerUser}`,
            `**Bezahlt:** ${paid.toLocaleString('de-DE')} ${cfg.emoji}`,
            `**Runde endet:** <t:${Math.floor(round.endsAt.getTime() / 1000)}:R>`,
          ].join('\n'))],
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (sub === 'buy') {
      const quantity = interaction.options.getInteger('tickets', true);
      try {
        const result = await buyLotteryTickets({
          guildId: scope.guildId,
          nitradoConnId: connId,
          roundId: round.id,
          userDiscordId: scope.actorDiscordId,
          quantity,
          idempotencyKey: `discord-slash:${interaction.id}`,
        });
        logAudit('LOTTERY_BUY_COMMAND', 'ECONOMY', {
          guildId: scope.guildId,
          nitradoConnId: connId,
          roundId: round.id,
          userDiscordId: scope.actorDiscordId,
          quantity,
          booked: result.booked,
        });
        await refreshLotteryMessage(interaction.client, round.id).catch(error => {
          logger.warn(`Lotterie-Embed-Refresh nach Slash-Kauf ${round.id}: ${(error as Error).message}`);
        });
        await interaction.reply({
          content: result.booked
            ? `✅ ${quantity} Ticket(s) gekauft. Du hast jetzt **${result.ticketCount}** Ticket(s).`
            : `✅ Dieser Kauf war bereits verarbeitet. Du hast **${result.ticketCount}** Ticket(s).`,
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
      } catch (error) {
        await replyError(interaction, `❌ ${(error as Error).message}`);
      }
    }
  }),
};

export default lotteryCommand;