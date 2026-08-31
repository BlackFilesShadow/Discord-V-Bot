import {
  ActionRowBuilder,
  ButtonInteraction,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import prisma from '../../database/prisma';
import { asGuildId, asNitradoConnId, asUserDiscordId, type GuildId, type NitradoConnId } from '../../types/scope';
import { logger } from '../../utils/logger';
import { buyInventorylessMarketListing } from './blackMarketInventoryless';
import { syncMarketDiscordProjection } from './blackMarketDiscord';
import { syncVirtualAccountProjection } from './virtualAccountDiscord';
import type { VirtualAccountRawDb } from './virtualAccounts';

interface ListingScopeRow {
  guildId: string;
  nitradoConnId: string;
}

function rawDb(): VirtualAccountRawDb {
  return prisma as unknown as VirtualAccountRawDb;
}

async function resolveListingScope(listingId: string, interactionGuildId: string | null): Promise<{ guildId: GuildId; connId: NitradoConnId }> {
  if (!interactionGuildId) throw new Error('Direktkauf ist nur in einem Discord-Server verfügbar.');
  const rows = await rawDb().$queryRawUnsafe<ListingScopeRow[]>(
    'SELECT "guildId", "nitradoConnId" FROM "EconomyMarketListing" WHERE "id"=$1 AND "guildId"=$2 AND "active"=TRUE AND "archivedAt" IS NULL LIMIT 1',
    listingId,
    interactionGuildId,
  );
  if (!rows[0]) throw new Error('Dieses Angebot ist nicht mehr aktiv.');
  return { guildId: asGuildId(rows[0].guildId), connId: asNitradoConnId(rows[0].nitradoConnId) };
}

function parseButton(customId: string): { pocket: 'WALLET' | 'BANK'; listingId: string } {
  const [, rawPocket, listingId] = customId.split(':');
  if (!listingId || (rawPocket !== 'w' && rawPocket !== 'b')) throw new Error('Direktkauf-Aktion ist ungültig.');
  return { pocket: rawPocket === 'b' ? 'BANK' : 'WALLET', listingId };
}

function parseQuantity(value: string): number {
  const clean = value.trim();
  if (!/^\d+$/.test(clean)) throw new Error('Kaufmenge muss eine positive ganze Zahl sein.');
  const quantity = Number(clean);
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000) throw new Error('Kaufmenge muss zwischen 1 und 1000 liegen.');
  return quantity;
}

async function replyError(interaction: ButtonInteraction | ModalSubmitInteraction, message: string): Promise<void> {
  const payload = {
    embeds: [new EmbedBuilder().setColor(0xe74c3c).setTitle('Direktkauf abgelehnt').setDescription(message)],
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] as never[] },
  } as const;
  if (interaction.replied || interaction.deferred) await interaction.followUp(payload);
  else await interaction.reply(payload);
}

export async function handleMarketDirectBuyButton(interaction: ButtonInteraction): Promise<void> {
  try {
    const parsed = parseButton(interaction.customId);
    await resolveListingScope(parsed.listingId, interaction.guildId);
    const modal = new ModalBuilder()
      .setCustomId(`marketbuy_modal:${parsed.pocket === 'BANK' ? 'b' : 'w'}:${parsed.listingId}`)
      .setTitle(parsed.pocket === 'BANK' ? 'Direktkauf aus Bank' : 'Direktkauf aus Wallet');
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId('quantity')
        .setLabel('Kaufmenge')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(4)
        .setValue('1'),
    ));
    await interaction.showModal(modal);
  } catch (error) {
    await replyError(interaction, (error as Error).message);
  }
}

export async function handleMarketDirectBuyModal(interaction: ModalSubmitInteraction): Promise<void> {
  try {
    const parsed = parseButton(interaction.customId.replace('marketbuy_modal:', 'marketbuy:'));
    const scope = await resolveListingScope(parsed.listingId, interaction.guildId);
    const quantity = parseQuantity(interaction.fields.getTextInputValue('quantity'));
    const result = await buyInventorylessMarketListing({
      guildId: scope.guildId,
      nitradoConnId: scope.connId,
      listingId: parsed.listingId,
      userDiscordId: asUserDiscordId(interaction.user.id),
      quantity,
      sourcePocket: parsed.pocket,
      idempotencyKey: `discord-direct:${interaction.id}`,
    });

    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle(result.booked ? '✅ Direktkauf gebucht' : '✅ Direktkauf bereits verarbeitet')
        .setDescription([
          `**${result.purchase.quantity}× ${result.listing.name}**`,
          `Gesamt: **${result.purchase.amount.toLocaleString('de-DE')}**`,
          `Bezahlt aus: **${parsed.pocket === 'BANK' ? 'Bank' : 'Wallet'}**`,
          `Bestellung: \`${result.purchase.id}\``,
          `Status: **${result.purchase.fulfillmentStatus === 'PENDING' ? 'Offen' : result.purchase.fulfillmentStatus}**`,
        ].join('\n'))],
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });

    if (result.booked) {
      try {
        await Promise.all([
          syncMarketDiscordProjection(interaction.client, scope.guildId, scope.connId),
          syncVirtualAccountProjection(interaction.client, scope.guildId, scope.connId, result.purchase.vendorAccountId),
        ]);
      } catch (syncError) {
        logger.error(`Schwarzmarkt Live-Sync nach Direktkauf fehlgeschlagen (${result.purchase.id}):`, syncError as Error);
        await interaction.followUp({
          content: 'Der Kauf ist sicher gebucht. Die Discord-Live-Anzeige konnte nicht vollständig aktualisiert werden; der nächste Sync kann sie erneut aufbauen.',
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        }).catch(() => undefined);
      }
    }
  } catch (error) {
    await replyError(interaction, (error as Error).message);
  }
}
