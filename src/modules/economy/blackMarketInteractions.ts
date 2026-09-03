import {
  ActionRowBuilder,
  ButtonInteraction,
  ChannelType,
  Client,
  ComponentType,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  TextChannel,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { asUserDiscordId } from '../../types/scope';
import { logger } from '../../utils/logger';
import { vEmbed } from '../../utils/embedDesign';
import { buyInventorylessMarketListing } from './blackMarketInventoryless';
import { syncMarketDiscordProjection } from './blackMarketDiscord';
import {
  resolveManagedDirectBuyContext,
  type MarketDirectBuyContext,
} from './marketDirectBuyContract';
import { syncVirtualAccountProjectionLive } from './virtualAccountLiveUpdates';

type Pocket = 'WALLET' | 'BANK';

interface ParsedButton {
  pocket: Pocket;
  listingId: string;
  version: string;
}

interface ParsedModal extends ParsedButton {
  messageId: string;
}

function pocketCode(pocket: Pocket): 'w' | 'b' {
  return pocket === 'BANK' ? 'b' : 'w';
}

function parseButton(customId: string): ParsedButton {
  const [prefix, rawPocket, listingId, version, extra] = customId.split(':');
  if (
    prefix !== 'marketbuy'
    || extra !== undefined
    || !listingId
    || !/^[a-f0-9]{12}$/.test(version ?? '')
    || (rawPocket !== 'w' && rawPocket !== 'b')
  ) {
    throw new Error('Diese Direktkauf-Anzeige ist veraltet. Bitte die aktuelle Nachricht verwenden.');
  }
  return { pocket: rawPocket === 'b' ? 'BANK' : 'WALLET', listingId, version };
}

function parseModal(customId: string): ParsedModal {
  const [prefix, rawPocket, listingId, version, messageId, extra] = customId.split(':');
  if (
    prefix !== 'marketbuy_modal'
    || extra !== undefined
    || !listingId
    || !messageId
    || !/^\d{17,20}$/.test(messageId)
    || !/^[a-f0-9]{12}$/.test(version ?? '')
    || (rawPocket !== 'w' && rawPocket !== 'b')
  ) {
    throw new Error('Dieser Direktkauf-Dialog ist veraltet. Bitte den Kauf erneut über die aktuelle Nachricht öffnen.');
  }
  return { pocket: rawPocket === 'b' ? 'BANK' : 'WALLET', listingId, version, messageId };
}

function parseQuantity(value: string): number {
  const clean = value.trim();
  if (!/^\d+$/.test(clean)) throw new Error('Kaufmenge muss eine positive ganze Zahl sein.');
  const quantity = Number(clean);
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 2_147_483_647) {
    throw new Error('Kaufmenge ist technisch nicht darstellbar.');
  }
  return quantity;
}

async function replyError(interaction: ButtonInteraction | ModalSubmitInteraction, message: string): Promise<void> {
  const payload = {
    embeds: [vEmbed(0xe74c3c).setTitle('Direktkauf abgelehnt').setDescription(message)],
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  } as const;
  if (interaction.replied || interaction.deferred) await interaction.followUp(payload);
  else await interaction.reply(payload);
}

function assertSnapshotVersion(context: MarketDirectBuyContext, version: string): void {
  if (context.version !== version) {
    throw new Error('Das Angebot wurde seit dem Öffnen dieser Kaufaktion geändert. Bitte die aktuelle Direktkauf-Nachricht verwenden.');
  }
}

async function assertCurrentDiscordMessage(
  client: Client,
  context: MarketDirectBuyContext,
  expectedButtonCustomId: string,
): Promise<void> {
  let channel;
  try {
    channel = await client.channels.fetch(context.channelId);
  } catch {
    throw new Error('Der Direktkauf-Kanal kann aktuell nicht sicher geprüft werden. Es wurde nichts gebucht.');
  }
  if (!channel || channel.type !== ChannelType.GuildText) {
    throw new Error('Der Direktkauf-Kanal ist nicht mehr verfügbar. Es wurde nichts gebucht.');
  }

  let message;
  try {
    message = await (channel as TextChannel).messages.fetch(context.messageId);
  } catch {
    throw new Error('Die Direktkauf-Nachricht ist nicht mehr verfügbar oder nicht lesbar. Es wurde nichts gebucht.');
  }

  const botId = client.user?.id;
  if (!botId || message.author.id !== botId) {
    throw new Error('Die Kaufaktion stammt nicht von einer aktuell verwalteten V-Bot-Nachricht.');
  }

  const currentCustomIds = message.components
    .filter(row => row.type === ComponentType.ActionRow)
    .flatMap(row => row.components.map(component => (
      'customId' in component ? component.customId : null
    )))
    .filter((value): value is string => typeof value === 'string');
  if (!currentCustomIds.includes(expectedButtonCustomId)) {
    throw new Error('Die Direktkauf-Nachricht wurde inzwischen aktualisiert. Bitte den Kauf erneut öffnen.');
  }
}

export async function handleMarketDirectBuyButton(interaction: ButtonInteraction): Promise<void> {
  try {
    const parsed = parseButton(interaction.customId);
    const botId = interaction.client.user?.id;
    if (!botId || interaction.message.author.id !== botId) {
      throw new Error('Diese Kaufaktion stammt nicht von einer verwalteten V-Bot-Nachricht.');
    }
    const context = await resolveManagedDirectBuyContext({
      listingId: parsed.listingId,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      messageId: interaction.message.id,
    });
    assertSnapshotVersion(context, parsed.version);

    const modalId = `marketbuy_modal:${pocketCode(parsed.pocket)}:${parsed.listingId}:${parsed.version}:${interaction.message.id}`;
    if (modalId.length > 100) throw new Error('Direktkauf-Aktion ist technisch zu lang und wurde sicher abgewiesen.');

    const modal = new ModalBuilder()
      .setCustomId(modalId)
      .setTitle(parsed.pocket === 'BANK' ? 'Direktkauf aus Bank' : 'Direktkauf aus Wallet');
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId('quantity')
        .setLabel('Kaufmenge')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(10)
        .setValue('1'),
    ));
    await interaction.showModal(modal);
  } catch (error) {
    await replyError(interaction, (error as Error).message);
  }
}

export async function handleMarketDirectBuyModal(interaction: ModalSubmitInteraction): Promise<void> {
  let result: Awaited<ReturnType<typeof buyInventorylessMarketListing>>;
  let context: MarketDirectBuyContext;
  let parsed: ParsedModal;

  try {
    parsed = parseModal(interaction.customId);
    context = await resolveManagedDirectBuyContext({
      listingId: parsed.listingId,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      messageId: parsed.messageId,
    });
    assertSnapshotVersion(context, parsed.version);
    await assertCurrentDiscordMessage(
      interaction.client,
      context,
      `marketbuy:${pocketCode(parsed.pocket)}:${parsed.listingId}:${parsed.version}`,
    );

    const quantity = parseQuantity(interaction.fields.getTextInputValue('quantity'));
    result = await buyInventorylessMarketListing({
      guildId: context.guildId,
      nitradoConnId: context.connId,
      listingId: parsed.listingId,
      userDiscordId: asUserDiscordId(interaction.user.id),
      quantity,
      sourcePocket: parsed.pocket,
      idempotencyKey: `discord-direct:${interaction.id}`,
      expectedUnitPrice: context.price,
      expectedVendorAccountId: context.vendorAccountId,
      expectedUpdatedAt: context.updatedAt,
    });
  } catch (error) {
    await replyError(interaction, (error as Error).message);
    return;
  }

  let confirmationDelivered = false;
  try {
    await interaction.reply({
      embeds: [vEmbed(0x2ecc71)
        .setTitle(result.booked ? 'Direktkauf gebucht' : 'Direktkauf bereits verarbeitet')
        .setDescription([
          `**${result.purchase.quantity}× ${result.listing.name}**`,
          `Gesamt: **${result.purchase.amount.toLocaleString('de-DE')}**`,
          `Bezahlt aus: **${parsed.pocket === 'BANK' ? 'Bank' : 'Wallet'}**`,
          `Bestellung: \`${result.purchase.id}\``,
          `Status: **${result.purchase.fulfillmentStatus === 'PENDING' ? 'Offen' : result.purchase.fulfillmentStatus}**`,
        ].join('\n\n'))],
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    confirmationDelivered = true;
  } catch (replyFailure) {
    logger.error(`Discord-Bestätigung nach sicher gebuchtem Direktkauf fehlgeschlagen (${result.purchase.id}):`, replyFailure as Error);
  }

  if (result.booked) {
    try {
      await Promise.all([
        syncMarketDiscordProjection(interaction.client, context.guildId, context.connId),
        syncVirtualAccountProjectionLive(interaction.client, context.guildId, context.connId, result.purchase.vendorAccountId),
      ]);
    } catch (syncError) {
      logger.error(`Schwarzmarkt Live-Sync nach Direktkauf fehlgeschlagen (${result.purchase.id}):`, syncError as Error);
      if (confirmationDelivered) {
        await interaction.followUp({
          content: 'Der Kauf ist sicher gebucht. Die Discord-Live-Anzeige konnte nicht vollständig aktualisiert werden; der nächste Sync kann sie erneut aufbauen.',
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        }).catch(() => undefined);
      }
    }
  }
}
