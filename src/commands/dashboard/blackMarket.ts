import { EmbedBuilder, MessageFlags, SlashCommandBuilder, SlashCommandSubcommandBuilder } from 'discord.js';
import type { Command } from '../../types';
import { withGuildScope } from '../middleware/withGuildScope';
import { MAX_GAME_SERVERS_PER_GUILD } from '../../modules/nitrado/gameServerScope';
import { buyMarketListing, listMarketListings, listMarketPurchasesForUser } from '../../modules/economy/blackMarket';
import { getConfig } from '../../modules/economy/repository';

function addSlot(builder: SlashCommandSubcommandBuilder): SlashCommandSubcommandBuilder {
  return builder.addIntegerOption(o => o.setName('slot').setDescription('Gameserver-Slot (bei mehreren Servern erforderlich)').setRequired(false).setMinValue(1).setMaxValue(MAX_GAME_SERVERS_PER_GUILD));
}

const data = new SlashCommandBuilder()
  .setName('black-market')
  .setDescription('Schwarzmarkt dieses Gameservers.')
  .addSubcommand(sc => addSlot(sc.setName('list').setDescription('Zeigt aktive Angebote und deren DayZ-Liefer-Bundle.')))
  .addSubcommand(sc => addSlot(sc.setName('buy').setDescription('Kauft ein Angebot aus Wallet oder Bank.')
    .addStringOption(o => o.setName('listing').setDescription('Listing-ID aus /black-market list').setRequired(true).setMaxLength(40))
    .addIntegerOption(o => o.setName('quantity').setDescription('Menge').setRequired(true).setMinValue(1).setMaxValue(1000))
    .addStringOption(o => o.setName('quelle').setDescription('Bezahlen aus Wallet oder Bank').setRequired(false).addChoices(
      { name: 'Wallet', value: 'WALLET' },
      { name: 'Bank', value: 'BANK' },
    ))))
  .addSubcommand(sc => addSlot(sc.setName('orders').setDescription('Zeigt deine letzten Schwarzmarkt-Bestellungen und Lieferstatus.')));

function bundleText(items: Array<{ className: string; quantity: number }>): string {
  if (items.length === 0) return '⚠️ Liefer-Bundle noch nicht konfiguriert';
  return items.map(item => `\`${item.className}\` × ${item.quantity}`).join(', ');
}

function statusLabel(status: string): string {
  if (status === 'PENDING') return '🟡 Offen';
  if (status === 'DELIVERED') return '✅ Geliefert';
  if (status === 'REFUNDED') return '↩️ Refundiert';
  return '⚪ Legacy';
}

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
        ? visible.map(row => [
          `**${row.name}** — ${row.price.toLocaleString('de-DE')} ${cfg.emoji} — Bestand: ${row.stock}`,
          bundleText(row.deliveryItems),
          `\`${row.id}\` (${row.sku})`,
        ].join('\n')).join('\n\n')
        : 'Aktuell sind keine Angebote verfuegbar.';
      await interaction.reply({
        embeds: [new EmbedBuilder().setColor(0x2F3136).setTitle('🕶️ Schwarzmarkt').setDescription(description.slice(0, 4000))],
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (sub === 'orders') {
      const purchases = await listMarketPurchasesForUser(scope.guildId, connId, scope.actorDiscordId, 15);
      const description = purchases.length
        ? purchases.map(row => [
          `**${statusLabel(row.fulfillmentStatus)} · ${row.quantity}× · ${row.amount.toLocaleString('de-DE')} ${cfg.emoji}**`,
          `Bestellung: \`${row.id}\``,
          `Lieferung: ${bundleText(row.deliveryItems)}`,
          row.refundReason ? `Refund-Grund: ${row.refundReason}` : null,
          row.fulfillmentNote ? `Liefernotiz: ${row.fulfillmentNote}` : null,
        ].filter(Boolean).join('\n')).join('\n\n')
        : 'Du hast auf diesem Gameserver noch keine Schwarzmarkt-Bestellungen.';
      await interaction.reply({
        embeds: [new EmbedBuilder().setColor(0x3498DB).setTitle('📦 Deine Schwarzmarkt-Bestellungen').setDescription(description.slice(0, 4000))],
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    try {
      const sourcePocket = (interaction.options.getString('quelle') ?? 'WALLET') as 'WALLET' | 'BANK';
      const result = await buyMarketListing({
        guildId: scope.guildId,
        nitradoConnId: connId,
        listingId: interaction.options.getString('listing', true),
        userDiscordId: scope.actorDiscordId,
        quantity: interaction.options.getInteger('quantity', true),
        sourcePocket,
        idempotencyKey: `discord-slash:${interaction.id}`,
      });
      const delivery = bundleText(result.purchase.deliveryItems);
      await interaction.reply({
        content: result.booked
          ? `✅ ${result.purchase.quantity}× **${result.listing.name}** gekauft für **${result.purchase.amount.toLocaleString('de-DE')} ${cfg.emoji}** aus ${sourcePocket === 'BANK' ? 'der Bank' : 'dem Wallet'}.\n📦 Bestellung: \`${result.purchase.id}\` · Status: **Offen**\n${delivery}\nDas Server-Team markiert die Bestellung nach der manuellen DayZ-Ausgabe als geliefert.`
          : `✅ Dieser Kauf war bereits verarbeitet: ${result.purchase.quantity}× **${result.listing.name}** · Bestellung \`${result.purchase.id}\` · ${statusLabel(result.purchase.fulfillmentStatus)}.`,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      await interaction.reply({ content: `❌ ${(error as Error).message}`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    }
  }),
};

export default blackMarketCommand;
