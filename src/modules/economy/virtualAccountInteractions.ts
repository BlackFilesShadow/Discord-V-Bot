import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import prisma from '../../database/prisma';
import { logger } from '../../utils/logger';
import { asGuildId, asNitradoConnId, asUserDiscordId, type GuildId, type NitradoConnId, type UserDiscordId } from '../../types/scope';
import { getVirtualAccountById, type EconomyPocket, type VirtualAccountRawDb } from './virtualAccounts';
import {
  ensureVirtualAccountFinance,
  listManagedVirtualAccounts,
  userManagesVirtualAccount,
} from './virtualAccountFinance';
import {
  safeDepositUserIntoVirtualAccount,
  safePayoutVirtualAccountToUser,
  safeRemoveVirtualAccountAmount,
  safeTransferVirtualPocket,
} from './virtualAccountMoneySafety';
import { postVirtualAccountArchive, syncVirtualAccountProjection } from './virtualAccountDiscord';
import { getConfig } from './repository';

interface ScopeRow { guildId: string; nitradoConnId: string }

function rawDb(): VirtualAccountRawDb {
  return prisma as unknown as VirtualAccountRawDb;
}

async function resolveAccountScope(accountId: string): Promise<{ guildId: GuildId; connId: NitradoConnId }> {
  const rows = await rawDb().$queryRawUnsafe<ScopeRow[]>('SELECT "guildId", "nitradoConnId" FROM "EconomyVirtualAccount" WHERE "id"=$1 LIMIT 1', accountId);
  if (!rows[0]) throw new Error('Virtuelles Konto nicht gefunden.');
  return { guildId: asGuildId(rows[0].guildId), connId: asNitradoConnId(rows[0].nitradoConnId) };
}

function parsePositiveAmount(value: string): bigint {
  const clean = value.trim().replace(/[.\s]/g, '').replace(',', '.');
  if (!/^\d+$/.test(clean)) throw new Error('Betrag muss eine positive ganze Zahl sein.');
  const amount = BigInt(clean);
  if (amount <= 0n || amount > 1_000_000_000_000_000n) throw new Error('Betrag liegt außerhalb des erlaubten Bereichs.');
  return amount;
}

function parsePocket(value: string, label: string): EconomyPocket {
  const pocket = value.trim().toUpperCase();
  if (pocket !== 'WALLET' && pocket !== 'BANK') throw new Error(`${label} muss WALLET oder BANK sein.`);
  return pocket;
}

function parseDiscordId(value: string): UserDiscordId {
  const match = value.match(/\d{17,20}/);
  if (!match) throw new Error('Empfänger muss eine Discord-ID oder Mention sein.');
  return asUserDiscordId(match[0]);
}

async function replyError(interaction: ButtonInteraction | ModalSubmitInteraction | StringSelectMenuInteraction, message: string) {
  const payload = { embeds: [new EmbedBuilder().setColor(0xe74c3c).setTitle('Aktion abgelehnt').setDescription(message)], flags: MessageFlags.Ephemeral } as const;
  if (interaction.replied || interaction.deferred) await interaction.followUp(payload);
  else await interaction.reply(payload);
}

async function assertInteractionScope(guildId: string | null, accountId: string) {
  if (!guildId) throw new Error('Diese Aktion ist nur in einem Discord-Server verfügbar.');
  const scope = await resolveAccountScope(accountId);
  if (String(scope.guildId) !== guildId) throw new Error('Konto gehört nicht zu diesem Discord-Server.');
  return scope;
}

async function assertManager(interaction: ButtonInteraction | ModalSubmitInteraction | StringSelectMenuInteraction, accountId: string) {
  const scope = await assertInteractionScope(interaction.guildId, accountId);
  const allowed = await userManagesVirtualAccount(scope.guildId, scope.connId, accountId, asUserDiscordId(interaction.user.id));
  if (!allowed) throw new Error('Du bist für dieses virtuelle Konto nicht als Kontoverwalter eingetragen.');
  return scope;
}

function amountInput(id = 'amount') {
  return new TextInputBuilder().setCustomId(id).setLabel('Betrag').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(16).setPlaceholder('z. B. 5000');
}

export async function handleVirtualAccountDepositButton(interaction: ButtonInteraction): Promise<void> {
  const accountId = interaction.customId.slice('vacct:deposit:'.length);
  try {
    const scope = await assertInteractionScope(interaction.guildId, accountId);
    const account = await getVirtualAccountById(scope.guildId, scope.connId, accountId);
    if (!account || account.status !== 'ACTIVE' || !account.acceptUserTransfers || account.kind !== 'CUSTOM') throw new Error('Dieses Konto nimmt aktuell keine direkten Einzahlungen an.');
    const finance = await ensureVirtualAccountFinance(scope.guildId, scope.connId, accountId);
    const modal = new ModalBuilder().setCustomId(`vacct:deposit_modal:${accountId}`).setTitle('Auf virtuelles Konto einzahlen');
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
      amountInput().setLabel(`Betrag (${finance.currencyName})`).setPlaceholder('z. B. 5000 · Abbuchung aus deinem Wallet'),
    ));
    await interaction.showModal(modal);
  } catch (error) {
    await replyError(interaction, (error as Error).message);
  }
}

export async function handleVirtualAccountDepositModal(interaction: ModalSubmitInteraction): Promise<void> {
  const accountId = interaction.customId.slice('vacct:deposit_modal:'.length);
  try {
    const scope = await assertInteractionScope(interaction.guildId, accountId);
    const amount = parsePositiveAmount(interaction.fields.getTextInputValue('amount'));
    const result = await safeDepositUserIntoVirtualAccount({
      idempotencyKey: interaction.id,
      guildId: scope.guildId,
      nitradoConnId: scope.connId,
      accountId,
      userDiscordId: asUserDiscordId(interaction.user.id),
      sourcePocket: 'WALLET',
      playerAmount: amount,
      reason: 'Discord Button-Einzahlung',
    });
    const cfg = await getConfig(scope.guildId, scope.connId);
    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle(result.booked ? '✅ Einzahlung akzeptiert' : '✅ Einzahlung bereits verarbeitet')
        .setDescription(result.playerDebited === result.accountCredited && cfg.currencyName.toLowerCase() === result.finance.currencyName.toLowerCase()
          ? `**${result.accountCredited.toLocaleString('de-DE')} ${result.finance.currencyEmoji}** wurden dem virtuellen Konto gutgeschrieben.`
          : `Von deinem Wallet wurden **${result.playerDebited.toLocaleString('de-DE')} ${cfg.emoji}** abgebucht. Das virtuelle Konto erhielt **${result.accountCredited.toLocaleString('de-DE')} ${result.finance.currencyEmoji}**.`)],
      flags: MessageFlags.Ephemeral,
    });
    if (result.booked) {
      try {
        await postVirtualAccountArchive(interaction.client, {
          guildId: scope.guildId, nitradoConnId: scope.connId, accountId,
          title: '💰 Einzahlung eingegangen', actorDiscordId: asUserDiscordId(interaction.user.id),
          amount: result.accountCredited, pocket: 'WALLET', status: '✅ Akzeptiert',
          reason: result.playerDebited === result.accountCredited ? null : `Spielerabbuchung: ${result.playerDebited.toLocaleString('de-DE')} ${cfg.emoji}`,
        });
        await syncVirtualAccountProjection(interaction.client, scope.guildId, scope.connId, accountId);
      } catch (syncError) {
        logger.error(`Virtual-Account Discord-Sync nach Einzahlung fehlgeschlagen (${accountId}):`, syncError as Error);
        await interaction.followUp({ content: 'Die Geldbuchung ist erfolgreich und sicher gespeichert. Die Discord-Anzeige konnte noch nicht synchronisiert werden und kann erneut aufgebaut werden.', flags: MessageFlags.Ephemeral }).catch(() => undefined);
      }
    }
  } catch (error) {
    await replyError(interaction, (error as Error).message);
  }
}

function actionLabel(action: string): string {
  if (action === 'payout') return 'Auszahlung';
  if (action === 'remove') return 'Remove';
  return 'Pay / Balance';
}

export async function handleVirtualManagerButton(interaction: ButtonInteraction): Promise<void> {
  const [, action, rawConnId] = interaction.customId.split(':');
  if (!interaction.guildId || !rawConnId || !['payout', 'remove', 'balance'].includes(action)) return replyError(interaction, 'Manager-Aktion ist ungültig.');
  try {
    const guildId = asGuildId(interaction.guildId);
    const connId = asNitradoConnId(rawConnId);
    const accounts = await listManagedVirtualAccounts(guildId, connId, asUserDiscordId(interaction.user.id));
    if (accounts.length === 0) throw new Error('Dir ist in diesem Gameserver kein virtuelles Konto zugewiesen.');
    const options = [];
    for (const account of accounts.slice(0, 25)) {
      const finance = await ensureVirtualAccountFinance(guildId, connId, account.id);
      options.push({
        label: account.name.slice(0, 100),
        value: account.id,
        description: `${finance.accountPurpose === 'BANK_TREASURY' ? 'Serverbank' : account.kind} · ${finance.currencyName}`.slice(0, 100),
        emoji: finance.accountEmoji,
      });
    }
    const select = new StringSelectMenuBuilder()
      .setCustomId(`vacct_mgr_sel:${action}:${connId}`)
      .setPlaceholder(`Konto für „${actionLabel(action)}“ auswählen`)
      .addOptions(options);
    await interaction.reply({
      embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(actionLabel(action)).setDescription('Wähle das virtuelle Konto aus. Es werden ausschließlich Konten angezeigt, für die du als Kontoverwalter gespeichert bist.')],
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    await replyError(interaction, (error as Error).message);
  }
}

export async function handleVirtualManagerSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const [, action] = interaction.customId.split(':');
  const accountId = interaction.values[0];
  try {
    const scope = await assertManager(interaction, accountId);
    const account = await getVirtualAccountById(scope.guildId, scope.connId, accountId);
    const finance = await ensureVirtualAccountFinance(scope.guildId, scope.connId, accountId);
    if (!account) throw new Error('Virtuelles Konto nicht gefunden.');
    if (action === 'balance') {
      const embed = new EmbedBuilder().setColor(0x5865f2).setTitle(`${finance.accountEmoji} ${account.name}`)
        .addFields(
          { name: 'Wallet', value: `${account.balance.toLocaleString('de-DE')} ${finance.currencyEmoji}`, inline: true },
          { name: 'Bank', value: `${finance.bankBalance.toLocaleString('de-DE')} ${finance.currencyEmoji}`, inline: true },
          { name: 'Gesamt', value: `${(account.balance + finance.bankBalance).toLocaleString('de-DE')} ${finance.currencyEmoji}`, inline: true },
        );
      const components = account.kind === 'CUSTOM' ? [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`vacct_mgr_move:wb:${accountId}`).setLabel('Wallet → Bank').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`vacct_mgr_move:bw:${accountId}`).setLabel('Bank → Wallet').setStyle(ButtonStyle.Secondary),
      )] : [];
      await interaction.update({ embeds: [embed], components });
      return;
    }
    if (account.kind !== 'CUSTOM') throw new Error('Lotterie- und Markt-Systemkonten dürfen nicht über generische Manageraktionen manipuliert werden.');
    if (action === 'payout') {
      const modal = new ModalBuilder().setCustomId(`vacct_mgr_modal:payout:${accountId}`).setTitle('Auszahlung aus virtuellem Konto');
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('target').setLabel('Empfänger (Mention oder Discord-ID)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(30)),
        new ActionRowBuilder<TextInputBuilder>().addComponents(amountInput()),
        new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('source').setLabel('Quelle: WALLET oder BANK').setStyle(TextInputStyle.Short).setRequired(true).setValue('WALLET').setMaxLength(6)),
        new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('targetPocket').setLabel('Ziel beim User: WALLET oder BANK').setStyle(TextInputStyle.Short).setRequired(true).setValue('WALLET').setMaxLength(6)),
        new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('Grund').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(3).setMaxLength(180)),
      );
      await interaction.showModal(modal);
      return;
    }
    if (action === 'remove') {
      const modal = new ModalBuilder().setCustomId(`vacct_mgr_modal:remove:${accountId}`).setTitle('Betrag kontrolliert entfernen');
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(amountInput()),
        new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('pocket').setLabel('Pocket: WALLET oder BANK').setStyle(TextInputStyle.Short).setRequired(true).setValue('WALLET').setMaxLength(6)),
        new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('Begründung der Korrektur').setStyle(TextInputStyle.Paragraph).setRequired(true).setMinLength(3).setMaxLength(180)),
      );
      await interaction.showModal(modal);
      return;
    }
    throw new Error('Manager-Aktion ist ungültig.');
  } catch (error) {
    await replyError(interaction, (error as Error).message);
  }
}

export async function handleVirtualManagerMoveButton(interaction: ButtonInteraction): Promise<void> {
  const [, , direction, accountId] = interaction.customId.split(':');
  try {
    await assertManager(interaction, accountId);
    const accountScope = await resolveAccountScope(accountId);
    const account = await getVirtualAccountById(accountScope.guildId, accountScope.connId, accountId);
    if (!account || account.kind !== 'CUSTOM') throw new Error('Dieses Konto erlaubt keine generische Pocket-Verschiebung.');
    if (direction !== 'wb' && direction !== 'bw') throw new Error('Pocket-Richtung ist ungültig.');
    const modal = new ModalBuilder().setCustomId(`vacct_mgr_modal:move_${direction}:${accountId}`).setTitle(direction === 'wb' ? 'Wallet → Bank' : 'Bank → Wallet');
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(amountInput()),
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('Grund').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(180).setPlaceholder('Optional')),
    );
    await interaction.showModal(modal);
  } catch (error) {
    await replyError(interaction, (error as Error).message);
  }
}

async function ensureHumanGuildMember(interaction: ModalSubmitInteraction, userId: UserDiscordId): Promise<void> {
  const guild = interaction.guild;
  if (!guild) throw new Error('Discord-Server fehlt.');
  const member = guild.members.cache.get(String(userId)) ?? await guild.members.fetch(String(userId)).catch(() => null);
  if (!member || member.user.bot) throw new Error('Empfänger ist kein aktives menschliches Mitglied dieses Servers.');
}

export async function handleVirtualManagerModal(interaction: ModalSubmitInteraction): Promise<void> {
  const [, , operation, accountId] = interaction.customId.split(':');
  try {
    const scope = await assertManager(interaction, accountId);
    const account = await getVirtualAccountById(scope.guildId, scope.connId, accountId);
    if (!account) throw new Error('Virtuelles Konto nicht gefunden.');
    if (account.kind !== 'CUSTOM') throw new Error('Lotterie- und Markt-Systemkonten dürfen nicht über generische Manageraktionen manipuliert werden.');

    if (operation === 'payout') {
      const target = parseDiscordId(interaction.fields.getTextInputValue('target'));
      await ensureHumanGuildMember(interaction, target);
      const amount = parsePositiveAmount(interaction.fields.getTextInputValue('amount'));
      const sourcePocket = parsePocket(interaction.fields.getTextInputValue('source'), 'Quelle');
      const targetPocket = parsePocket(interaction.fields.getTextInputValue('targetPocket'), 'Ziel');
      const reason = interaction.fields.getTextInputValue('reason');
      const result = await safePayoutVirtualAccountToUser({
        idempotencyKey: interaction.id, guildId: scope.guildId, nitradoConnId: scope.connId, accountId,
        actorDiscordId: asUserDiscordId(interaction.user.id), toUserDiscordId: target,
        sourcePocket, targetPocket, accountAmount: amount, reason,
      });
      await interaction.reply({ content: result.booked ? '✅ Auszahlung atomar gebucht.' : '✅ Diese Auszahlung war bereits verarbeitet.', flags: MessageFlags.Ephemeral });
      if (result.booked) await syncAfterManagerAction(interaction, scope.guildId, scope.connId, accountId, {
        title: '💸 Auszahlung durchgeführt', amount: result.accountDebited, pocket: sourcePocket, targetDiscordId: target, reason,
      });
      return;
    }

    if (operation === 'remove') {
      const amount = parsePositiveAmount(interaction.fields.getTextInputValue('amount'));
      const pocket = parsePocket(interaction.fields.getTextInputValue('pocket'), 'Pocket');
      const reason = interaction.fields.getTextInputValue('reason');
      const result = await safeRemoveVirtualAccountAmount({
        idempotencyKey: interaction.id, guildId: scope.guildId, nitradoConnId: scope.connId, accountId,
        actorDiscordId: asUserDiscordId(interaction.user.id), pocket, amount, reason,
      });
      await interaction.reply({ content: result.booked ? '✅ Betrag entfernt und protokolliert.' : '✅ Diese Korrektur war bereits verarbeitet.', flags: MessageFlags.Ephemeral });
      if (result.booked) await syncAfterManagerAction(interaction, scope.guildId, scope.connId, accountId, { title: '➖ Kontokorrektur', amount, pocket, reason });
      return;
    }

    if (operation === 'move_wb' || operation === 'move_bw') {
      const amount = parsePositiveAmount(interaction.fields.getTextInputValue('amount'));
      const reason = interaction.fields.getTextInputValue('reason') || undefined;
      const from: EconomyPocket = operation === 'move_wb' ? 'WALLET' : 'BANK';
      const to: EconomyPocket = from === 'WALLET' ? 'BANK' : 'WALLET';
      const result = await safeTransferVirtualPocket({
        idempotencyKey: interaction.id, guildId: scope.guildId, nitradoConnId: scope.connId, accountId,
        actorDiscordId: asUserDiscordId(interaction.user.id), from, to, amount, reason,
      });
      await interaction.reply({ content: result.booked ? `✅ ${from} → ${to} gebucht.` : '✅ Diese Verschiebung war bereits verarbeitet.', flags: MessageFlags.Ephemeral });
      if (result.booked) await syncAfterManagerAction(interaction, scope.guildId, scope.connId, accountId, { title: '💳 Pocket-Transfer', amount, pocket: from, reason: reason ?? `${from} → ${to}` });
      return;
    }

    throw new Error('Manager-Operation ist ungültig.');
  } catch (error) {
    await replyError(interaction, (error as Error).message);
  }
}

async function syncAfterManagerAction(interaction: ModalSubmitInteraction, guildId: GuildId, connId: NitradoConnId, accountId: string, event: {
  title: string; amount: bigint; pocket?: EconomyPocket; targetDiscordId?: UserDiscordId; reason?: string;
}) {
  try {
    await postVirtualAccountArchive(interaction.client, {
      guildId, nitradoConnId: connId, accountId, title: event.title,
      actorDiscordId: asUserDiscordId(interaction.user.id), targetDiscordId: event.targetDiscordId ?? null,
      amount: event.amount, pocket: event.pocket ?? null, status: '✅ Ausgeführt', reason: event.reason ?? null,
    });
    await syncVirtualAccountProjection(interaction.client, guildId, connId, accountId);
  } catch (error) {
    logger.error(`Virtual-Account Discord-Sync nach Manageraktion fehlgeschlagen (${accountId}):`, error as Error);
    await interaction.followUp({ content: 'Die Geldbuchung ist erfolgreich gespeichert. Discord-Archiv/Live-Sync konnte noch nicht aktualisiert werden.', flags: MessageFlags.Ephemeral }).catch(() => undefined);
  }
}
