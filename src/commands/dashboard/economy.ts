/**
 * Economy-Commands — immer Guild+Gameserver-gescopt.
 * Positive Admin-Gutschriften werden unmittelbar ausgefuehrt; negative
 * Korrekturen bleiben bewusst Step-up-geschuetzt.
 */

import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, MessageFlags,
} from 'discord.js';
import type { Command } from '../../types';
import prisma from '../../database/prisma';
import { withGuildScope } from '../middleware/withGuildScope';
import {
  getAccountOrZero, pay, adminPay, deposit, withdraw, transferBank, getConfig,
} from '../../modules/economy/repository';
import { asUserDiscordId } from '../../types/scope';
import type { GuildId, NitradoConnId } from '../../types/scope';
import { logAudit } from '../../utils/logger';
import { buildStatusEmbed, type EmbedStatus } from '../../utils/statusEmbed';
import { Colors, vEmbed } from '../../utils/embedDesign';
import { MAX_GAME_SERVERS_PER_GUILD } from '../../modules/nitrado/gameServerScope';
import {
  createPendingServerAction,
  type PendingServerActionClient,
} from '../../modules/nitrado/pendingServerAction';

function fmt(n: bigint): string { return n.toLocaleString('de-DE'); }

function slotOption(builder: SlashCommandBuilder): SlashCommandBuilder {
  return builder.addIntegerOption(o => o
    .setName('slot')
    .setDescription('Gameserver-Slot (bei mehreren Servern erforderlich)')
    .setRequired(false)
    .setMinValue(1)
    .setMaxValue(MAX_GAME_SERVERS_PER_GUILD)) as SlashCommandBuilder;
}

async function guildFooter(guildId: GuildId, nitradoConnId: NitradoConnId): Promise<string> {
  try {
    const conn = await prisma.nitradoConnection.findFirst({
      where: { id: nitradoConnId, guildId },
      select: { alias: true },
    });
    if (conn?.alias) return `V-Bot • ${conn.alias}`;
  } catch { /* Nitrado optional */ }
  return 'V-Bot • Wirtschaft';
}

async function embedReply(i: ChatInputCommandInteraction, embed: EmbedBuilder, ephemeral = true): Promise<void> {
  if (ephemeral) await i.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  else await i.reply({ embeds: [embed], allowedMentions: { parse: [] } });
}

async function statusReply(
  i: ChatInputCommandInteraction,
  status: EmbedStatus,
  title: string,
  opts: { description?: string; fields?: { name: string; value: string }[]; footerText?: string; ephemeral?: boolean } = {},
): Promise<void> {
  const embed = buildStatusEmbed({ status, title, description: opts.description, fields: opts.fields, footerText: opts.footerText ?? 'V-Bot Economy' });
  const ephemeral = opts.ephemeral ?? true;
  if (ephemeral) await i.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  else await i.reply({ embeds: [embed], allowedMentions: { parse: [] } });
}

// /balance zeigt bewusst nur aktuelle Salden. Die Transaktionshistorie bleibt
// intern/Audit-seitig erhalten, wird dem Spieler aber nicht mehr eingeblendet.
export const balanceCommand: Command = {
  data: slotOption(new SlashCommandBuilder()
    .setName('balance')
    .setDescription('Zeigt deinen aktuellen Wallet-, Bank- und Gesamtstand.') as SlashCommandBuilder),
  execute: withGuildScope({ requireSlotToggle: 'economyActive', acceptSlotOption: true }, async (i, scope) => {
    const connId = scope.nitradoConnId!;
    const acc = await getAccountOrZero(scope.guildId, connId, scope.actorDiscordId);
    const cfg = await getConfig(scope.guildId, connId);
    const total = acc.walletBalance + acc.bankBalance;
    const e = vEmbed(Colors.Gold)
      .setAuthor({ name: i.user.username, iconURL: i.user.displayAvatarURL() })
      .setTitle(`${cfg.emoji} Kontostand`)
      .setDescription(`Konto von **${i.user.username}**`)
      .addFields(
        { name: '👛 Wallet', value: `**${fmt(acc.walletBalance)}** ${cfg.emoji}`, inline: false },
        { name: '🏦 Bank', value: `**${fmt(acc.bankBalance)}** ${cfg.emoji}`, inline: false },
        { name: 'Σ Gesamt', value: `**${fmt(total)}** ${cfg.emoji}`, inline: false },
      )
      .setFooter({ text: await guildFooter(scope.guildId, connId) })
      .setTimestamp();
    await embedReply(i, e, false);
  }),
};

export const payCommand: Command = {
  data: slotOption(new SlashCommandBuilder()
    .setName('pay')
    .setDescription('Sende Coins aus deiner Wallet an einen anderen User.')
    .addUserOption(o => o.setName('user').setDescription('Empfänger').setRequired(true))
    .addIntegerOption(o => o.setName('betrag').setDescription('Betrag').setRequired(true).setMinValue(1).setMaxValue(1_000_000_000))
    .addStringOption(o => o.setName('grund').setDescription('Grund (max 100)').setRequired(false).setMaxLength(100)) as SlashCommandBuilder),
  execute: withGuildScope({ requireSlotToggle: 'economyActive', acceptSlotOption: true }, async (i, scope) => {
    const connId = scope.nitradoConnId!;
    const target = i.options.getUser('user', true);
    if (target.bot) { await statusReply(i, 'ERROR', 'Zahlung abgelehnt', { description: 'Die Zahlung konnte nicht durchgeführt werden.', fields: [{ name: '📝 Grund', value: 'Ein Bot kann keine Coins erhalten.' }] }); return; }
    if (target.id === i.user.id) { await statusReply(i, 'ERROR', 'Zahlung abgelehnt', { description: 'Die Zahlung konnte nicht durchgeführt werden.', fields: [{ name: '📝 Grund', value: 'Eine Zahlung an dich selbst ist nicht möglich.' }] }); return; }
    const betrag = BigInt(i.options.getInteger('betrag', true));
    const grund = i.options.getString('grund') ?? 'Pay';
    try {
      await pay({ guildId: scope.guildId, nitradoConnId: connId, fromUserId: scope.actorDiscordId, toUserId: asUserDiscordId(target.id), amount: betrag, reason: grund });
    } catch (e) {
      await statusReply(i, 'ERROR', 'Zahlung fehlgeschlagen', { description: 'Die Zahlung konnte nicht durchgeführt werden.', fields: [{ name: '📝 Grund', value: (e as Error).message }] });
      return;
    }
    logAudit('ECON_PAY', 'ECONOMY', { guildId: scope.guildId, nitradoConnId: connId, from: scope.actorDiscordId, to: target.id, amount: betrag.toString() });
    const cfg = await getConfig(scope.guildId, connId);
    await statusReply(i, 'SUCCESS', 'Zahlung erfolgreich', { ephemeral: false, description: `Der Betrag wurde an <@${target.id}> gesendet.`, fields: [
      { name: '👤 Empfänger', value: `<@${target.id}>` }, { name: '💰 Betrag', value: `${fmt(betrag)} ${cfg.emoji}` }, { name: '📝 Grund', value: grund },
    ] });
  }),
};

export const adminPayCommand: Command = {
  data: slotOption(new SlashCommandBuilder()
    .setName('admin-pay')
    .setDescription('Berechtigt: Positiv sofort; negative Wallet-Korrekturen mit Bestätigung.')
    .addUserOption(o => o.setName('user').setDescription('Ziel-User').setRequired(true))
    .addIntegerOption(o => o.setName('betrag').setDescription('Delta (negativ = abziehen, ungleich 0)').setRequired(true).setMinValue(-1_000_000_000).setMaxValue(1_000_000_000))
    .addStringOption(o => o.setName('grund').setDescription('Grund (3..200)').setRequired(true).setMinLength(3).setMaxLength(200)) as SlashCommandBuilder),
  execute: withGuildScope({ requirePerm: 'economy.manage', requireSlotToggle: 'economyActive', acceptSlotOption: true }, async (i, scope) => {
    const connId = scope.nitradoConnId!;
    const target = i.options.getUser('user', true);
    if (target.bot) { await statusReply(i, 'ERROR', 'Aktion nicht erlaubt', { description: 'Die Aktion konnte nicht durchgeführt werden.', fields: [{ name: '📝 Grund', value: 'Ein Bot kann nicht begünstigt werden.' }] }); return; }
    const delta = BigInt(i.options.getInteger('betrag', true));
    if (delta === 0n) { await statusReply(i, 'ERROR', 'Ungültiger Betrag', { description: 'Die Aktion konnte nicht durchgeführt werden.', fields: [{ name: '📝 Grund', value: 'Der Betrag darf nicht 0 sein.' }] }); return; }
    const grund = i.options.getString('grund', true);

    if (delta < 0n) {
      const amount = -delta;
      const action = await createPendingServerAction(prisma as unknown as PendingServerActionClient, {
        guildId: scope.guildId,
        nitradoConnId: connId,
        actorDiscordId: scope.actorDiscordId,
        actionType: 'REMOVE_MONEY',
        payload: { targetUserId: target.id, amount: amount.toString(), reason: grund },
      });
      logAudit('PRIVILEGED_ACTION_QUEUED', 'SECURITY', { guildId: scope.guildId, nitradoConnId: connId, actor: scope.actorDiscordId, target: target.id, actionId: action.id, actionType: 'REMOVE_MONEY' });
      await statusReply(i, 'INFO', 'Abbuchung wartet auf Bestätigung', {
        footerText: 'V-Bot Economy • Administration',
        description: `-${fmt(amount)} Coins von <@${target.id}> wurden noch **nicht** abgezogen.`,
        fields: [{ name: 'Bestätigen', value: `\`/confirm-action id:${action.id}\`` }, { name: 'Grund', value: grund }],
      });
      return;
    }

    try {
      await adminPay({ guildId: scope.guildId, nitradoConnId: connId, targetUserId: asUserDiscordId(target.id), delta, reason: grund, actorDiscordId: scope.actorDiscordId });
    } catch (e) { await statusReply(i, 'ERROR', 'Aktion fehlgeschlagen', { description: 'Die Aktion konnte nicht durchgeführt werden.', fields: [{ name: '📝 Grund', value: (e as Error).message }] }); return; }
    logAudit('ECON_ADMIN_PAY', 'ECONOMY', { guildId: scope.guildId, nitradoConnId: connId, target: target.id, delta: delta.toString(), actor: scope.actorDiscordId });
    const cfg = await getConfig(scope.guildId, connId);
    await statusReply(i, 'SUCCESS', 'Guthaben hinzugefügt', { footerText: 'V-Bot Economy • Administration', description: `Das Wallet von <@${target.id}> wurde angepasst.`, fields: [
      { name: '👤 Spieler', value: `<@${target.id}>` }, { name: '💰 Hinzugefügt', value: `${fmt(delta)} ${cfg.emoji}` }, { name: '📝 Grund', value: grund },
    ] });
  }),
};

export const depositCommand: Command = {
  data: slotOption(new SlashCommandBuilder().setName('deposit').setDescription('Bringt Coins von Wallet auf die Bank.')
    .addIntegerOption(o => o.setName('betrag').setDescription('Betrag').setRequired(true).setMinValue(1).setMaxValue(1_000_000_000)) as SlashCommandBuilder),
  execute: withGuildScope({ requireSlotToggle: 'economyActive', acceptSlotOption: true }, async (i, scope) => {
    const connId = scope.nitradoConnId!; const amount = BigInt(i.options.getInteger('betrag', true));
    try { await deposit(scope.guildId, connId, scope.actorDiscordId, amount); }
    catch (e) { await statusReply(i, 'ERROR', 'Einzahlung fehlgeschlagen', { footerText: 'V-Bot Bank', description: 'Die Einzahlung konnte nicht durchgeführt werden.', fields: [{ name: '📝 Grund', value: (e as Error).message }] }); return; }
    const cfg = await getConfig(scope.guildId, connId); const acc = await getAccountOrZero(scope.guildId, connId, scope.actorDiscordId);
    await statusReply(i, 'SUCCESS', 'Einzahlung erfolgreich', { footerText: 'V-Bot Bank', description: 'Der Betrag wurde von deiner Wallet auf dein Bankkonto übertragen.', fields: [
      { name: '💰 Betrag', value: `${fmt(amount)} ${cfg.emoji}` }, { name: '🏦 Neues Bankguthaben', value: `${fmt(acc.bankBalance)} ${cfg.emoji}` },
    ] });
  }),
};

export const withdrawCommand: Command = {
  data: slotOption(new SlashCommandBuilder().setName('withdraw').setDescription('Hebt Coins von der Bank auf die Wallet ab.')
    .addIntegerOption(o => o.setName('betrag').setDescription('Betrag').setRequired(true).setMinValue(1).setMaxValue(1_000_000_000)) as SlashCommandBuilder),
  execute: withGuildScope({ requireSlotToggle: 'economyActive', acceptSlotOption: true }, async (i, scope) => {
    const connId = scope.nitradoConnId!; const amount = BigInt(i.options.getInteger('betrag', true));
    try { await withdraw(scope.guildId, connId, scope.actorDiscordId, amount); }
    catch (e) { await statusReply(i, 'ERROR', 'Auszahlung fehlgeschlagen', { footerText: 'V-Bot Bank', description: 'Die Auszahlung konnte nicht durchgeführt werden.', fields: [{ name: '📝 Grund', value: (e as Error).message }] }); return; }
    const cfg = await getConfig(scope.guildId, connId); const acc = await getAccountOrZero(scope.guildId, connId, scope.actorDiscordId);
    await statusReply(i, 'SUCCESS', 'Auszahlung erfolgreich', { footerText: 'V-Bot Bank', description: 'Der Betrag wurde von deinem Bankkonto auf deine Wallet übertragen.', fields: [
      { name: '💰 Betrag', value: `${fmt(amount)} ${cfg.emoji}` }, { name: '👛 Neue Wallet', value: `${fmt(acc.walletBalance)} ${cfg.emoji}` },
    ] });
  }),
};

export const transferCommand: Command = {
  data: slotOption(new SlashCommandBuilder().setName('transfer').setDescription('Sende Coins von deiner Bank an die Bank eines anderen Users.')
    .addUserOption(o => o.setName('user').setDescription('Empfänger').setRequired(true))
    .addIntegerOption(o => o.setName('betrag').setDescription('Betrag').setRequired(true).setMinValue(1).setMaxValue(1_000_000_000)) as SlashCommandBuilder),
  execute: withGuildScope({ requireSlotToggle: 'economyActive', acceptSlotOption: true }, async (i, scope) => {
    const connId = scope.nitradoConnId!; const target = i.options.getUser('user', true);
    if (target.bot) { await statusReply(i, 'ERROR', 'Überweisung abgelehnt', { footerText: 'V-Bot Bank', description: 'Die Überweisung konnte nicht durchgeführt werden.', fields: [{ name: '📝 Grund', value: 'Ein Bot kann keine Coins erhalten.' }] }); return; }
    if (target.id === i.user.id) { await statusReply(i, 'ERROR', 'Überweisung abgelehnt', { footerText: 'V-Bot Bank', description: 'Die Überweisung konnte nicht durchgeführt werden.', fields: [{ name: '📝 Grund', value: 'Eine Überweisung an das eigene Konto ist nicht möglich.' }] }); return; }
    const amount = BigInt(i.options.getInteger('betrag', true));
    try { await transferBank({ guildId: scope.guildId, nitradoConnId: connId, fromUserId: scope.actorDiscordId, toUserId: asUserDiscordId(target.id), amount }); }
    catch (e) { await statusReply(i, 'ERROR', 'Überweisung fehlgeschlagen', { footerText: 'V-Bot Bank', description: 'Die Überweisung konnte nicht durchgeführt werden.', fields: [{ name: '📝 Grund', value: (e as Error).message }] }); return; }
    logAudit('ECON_TRANSFER', 'ECONOMY', { guildId: scope.guildId, nitradoConnId: connId, from: scope.actorDiscordId, to: target.id, amount: amount.toString() });
    const cfg = await getConfig(scope.guildId, connId);
    await statusReply(i, 'SUCCESS', 'Überweisung erfolgreich', { footerText: 'V-Bot Bank', description: `Der Betrag wurde an <@${target.id}> überwiesen.`, fields: [
      { name: '👤 Empfänger', value: `<@${target.id}>` }, { name: '💰 Betrag', value: `${fmt(amount)} ${cfg.emoji}` }, { name: '🏦 Quelle', value: 'Bankkonto' },
    ] });
  }),
};

export const bankCommand: Command = {
  data: slotOption(new SlashCommandBuilder().setName('bank').setDescription('Zeigt Wallet, Bank und Gesamtguthaben.') as SlashCommandBuilder),
  execute: withGuildScope({ requireSlotToggle: 'economyActive', acceptSlotOption: true }, async (i, scope) => {
    const connId = scope.nitradoConnId!; const acc = await getAccountOrZero(scope.guildId, connId, scope.actorDiscordId); const cfg = await getConfig(scope.guildId, connId); const total = acc.walletBalance + acc.bankBalance;
    const e = vEmbed(Colors.Gold).setAuthor({ name: i.user.username, iconURL: i.user.displayAvatarURL() }).setTitle(`${cfg.emoji} Bankübersicht`).setDescription(`Konto von **${i.user.username}**`).addFields(
      { name: '👛 Wallet', value: `**${fmt(acc.walletBalance)}** ${cfg.emoji}`, inline: false }, { name: '🏦 Bank', value: `**${fmt(acc.bankBalance)}** ${cfg.emoji}`, inline: false }, { name: 'Σ Gesamt', value: `**${fmt(total)}** ${cfg.emoji}`, inline: false },
    ).setFooter({ text: await guildFooter(scope.guildId, connId) }).setTimestamp();
    await embedReply(i, e, false);
  }),
};
