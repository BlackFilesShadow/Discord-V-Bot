import { EmbedBuilder, MessageFlags, SlashCommandBuilder, SlashCommandSubcommandBuilder } from 'discord.js';
import type { Command } from '../../types';
import { withGuildScope } from '../middleware/withGuildScope';
import { MAX_GAME_SERVERS_PER_GUILD } from '../../modules/nitrado/gameServerScope';
import { buyMarketListing, listMarketListings } from '../../modules/economy/blackMarket';
import { getConfig } from '../../modules/economy/repository';

function addSlot(builder: SlashCommandSubcommandBuilder): SlashCommandSubcommandBuilder {
  return builder.addIntegerOption(o => o.setName('slot').setDescription('Gameserver-Slot (bei mehreren Servern erforderlich)').setRequired(false).setMinValue(1).setMaxValue(MAX_GAME_SERVERS_PER_GUILD));
}

const data = new SlashCommandBuilder()
  .setName('black-market')
  .setDescription('Schwarzmarkt dieses Gameservers.')
  .addSubcommand(sc => addSlot(sc.setName('list').setDescription('Zeigt aktive Angebote.')))
  .addSubcommand(sc => addSlot(sc.setName('buy').setDescription('Kauft ein Angebot aus deinem Wallet.')
    .addStringOption(o => o.setName('listing').setDescription('Listing-ID aus /black-market list').setRequired(true).setMaxLength(40))
    .addIntegerOption(o => o.setName('quantity').setDescription('Menge').setRequired(true).setMinValue(1).setMaxValue(1000))));

export const blackMarketCommand: Command = {
  data,
  cooldown: 2,
  execute: withGuildScope({ requireSlotToggle: 'economyActive', acceptSlotOption: true }, async (interaction, scope) => {
    const connId = scope.nitradoConnId!;
    const sub = interaction.options.getSubcommand();
    const cfg = await getConfig(scope.guildId, connId);
    if (sub === 'list') {
      const rows = await listMarketListings(scope.guildId, connId, false);
      const visible = rows.filter(row => row.stock > 0).slice(0, 20);
      const description = visible.length
        ? visible.map(row => `**${row.name}** — ${row.price.toLocaleString('de-DE')} ${cfg.emoji} — Bestand: ${row.stock}\n\`${row.id}\` (${row.sku})`).join('\n\n')
        : 'Aktuell sind keine Angebote verfuegbar.';
      await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x2F3136).setTitle('🕶️ Schwarzmarkt').setDescription(description)], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      return;
    }
    try {
      const result = await buyMarketListing({
        guildId: scope.guildId, nitradoConnId: connId, listingId: interaction.options.getString('listing', true),
        userDiscordId: scope.actorDiscordId, quantity: interaction.options.getInteger('quantity', true), sourcePocket: 'WALLET',
        idempotencyKey: `discord-slash:${interaction.id}`,
      });
      await interaction.reply({
        content: result.booked
          ? `✅ ${result.purchase.quantity}× **${result.listing.name}** gekauft für **${result.purchase.amount.toLocaleString('de-DE')} ${cfg.emoji}**.`
          : `✅ Dieser Kauf war bereits verarbeitet: ${result.purchase.quantity}× **${result.listing.name}**.`,
        flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] },
      });
    } catch (error) {
      await interaction.reply({ content: `❌ ${(error as Error).message}`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    }
  }),
};

export default blackMarketCommand;
