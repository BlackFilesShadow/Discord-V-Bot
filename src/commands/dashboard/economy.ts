/**
 * Phase 3 — Economy + Link-Commands.
 *
 * Alle Commands laufen ueber `withGuildScope` (Guild+Slot+Owner+Perms in einem Schritt).
 * Bei mehreren aktiven Gameservern kann und muss der Slot explizit gewaehlt werden.
 * Geld-Werte: BigInt. Replies: ephemeral bei privaten Daten/Fehlern.
 */

import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, MessageFlags,
} from 'discord.js';
import type { Command } from '../../types';
import prisma from '../../database/prisma';
import { withGuildScope } from '../middleware/withGuildScope';
import {
  getAccountOrZero, recentTransactions, pay, adminPay, deposit, withdraw, transferBank, getConfig,
} from '../../modules/economy/repository';
import { createLinkChallenge, unlinkUser, type LinkClient } from '../../modules/linking/linkService';
import { asUserDiscordId } from '../../types/scope';
import type { GuildId, NitradoConnId } from '../../types/scope';
import { logAudit } from '../../utils/logger';
import { buildStatusEmbed, type EmbedStatus } from '../../utils/statusEmbed';
import { MAX_GAME_SERVERS_PER_GUILD } from '../../modules/nitrado/gameServerScope';

function fmt(n: bigint): string { return n.toLocaleString('de-DE'); }

const TX_LABELS: Record<string, string> = {
  PAY: 'Zahlung',
  ADMIN_PAY: 'Admin-Zahlung',
  DEPOSIT: 'Einzahlung',
  WITHDRAW: 'Auszahlung',
  TRANSFER: 'Überweisung',
  CASINO_BET: 'Casino-Einsatz',
  CASINO_PAYOUT: 'Casino-Auszahlung',
  PLAYTIME_REWARD: 'Spielzeitbelohnung',
  STARTBALANCE_JOIN: 'Startguthaben',
  GRANT: 'Gutschrift',
  FINE: 'Strafe',
  INTEREST: 'Zinsen',
};
function txLabel(type: string): string { return TX_LABELS[type] ?? type; }

function slotOption(builder: SlashCommandBuilder): SlashCommandBuilder {
  return builder.addIntegerOption(o => o
    .setName('slot')
    .setDescription('Gameserver-Slot (bei mehreren Servern erforderlich)')
    .setRequired(false)
    .setMinValue(1)
    .setMaxValue(MAX_GAME_SERVERS_PER_GUILD)) as SlashCommandBuilder;
}

// Footer ist an denselben Gameserver-Scope wie die Buchung gebunden.
async function guildFooter(guildId: GuildId, nitradoConnId: NitradoConnId): Promise<string> {
  try {
    const conn = await prisma.nitradoConnection.findFirst({
      where: { id: nitradoConnId, guildId },
      select: { alias: true },
    });
    if (conn?.alias) return `V-Bot • ${conn.alias}`;
  } catch { /* Nitrado optional – Fallback unten */ }
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

// ============================================================
// /link — startet den sicheren Ingame-Challenge-Flow im ausgewaehlten Slot
// ============================================================
export const linkCommand: Command = {
  data: slotOption(new SlashCommandBuilder()
    .setName('link')
    .setDescription('Startet die sichere Verknüpfung mit deiner Spielfigur per Ingame-Code.') as SlashCommandBuilder),
  execute: withGuildScope({ acceptSlotOption: true }, async (i, scope) => {
    const { code, expiresAt } = await createLinkChallenge(
      prisma as unknown as LinkClient,
      { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId! },
      scope.actorDiscordId,
    );
    logAudit('LINK_CHALLENGE_CREATED', 'LINKING', {
      guildId: scope.guildId,
      slotId: scope.nitradoConnId,
      actor: scope.actorDiscordId,
      expiresAt: expiresAt.toISOString(),
    });
    await statusReply(i, 'SUCCESS', 'Verknüpfung gestartet', {
      description: 'Schreibe den folgenden Code **im Spielchat auf dem ausgewählten DayZ-Server**. Erst die ADM-Erkennung verknüpft danach deine Spielidentität mit Discord.',
      fields: [
        { name: '🔐 Ingame-Code', value: `\`${code}\`` },
        { name: '⏱️ Gültig', value: `<t:${Math.floor(expiresAt.getTime() / 1000)}:R>` },
      ],
    });
  }),
};

// ============================================================
// /unlink — entfernt eigene Bindung im ausgewaehlten Slot
// ============================================================
export const unlinkCommand: Command = {
  data: slotOption(new SlashCommandBuilder()
    .setName('unlink')
    .setDescription('Löscht deine Spielfigur-Verknüpfung im ausgewählten Server.') as SlashCommandBuilder),
  execute: withGuildScope({ requireSlotToggle: 'economyActive', acceptSlotOption: true }, async (i, scope) => {
    const removed = await unlinkUser(prisma as unknown as LinkClient, { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId! }, scope.actorDiscordId);
    if (!removed) { await statusReply(i, 'INFO', 'Keine Verknüpfung', { description: 'Du hast in diesem Server keine Verknüpfung.' }); return; }
    logAudit('LINK_DELETED', 'ECONOMY', { guildId: scope.guildId, slotId: scope.nitradoConnId, actor: scope.actorDiscordId });
    await statusReply(i, 'SUCCESS', 'Verknüpfung entfernt', { description: 'Deine Spielfigur-Verknüpfung wurde entfernt.' });
  }),
};

// ============================================================
// /balance — eigener Kontostand + letzte 5 Tx
// ============================================================
export const balanceCommand: Command = {
  data: slotOption(new SlashCommandBuilder()
    .setName('balance')
    .setDescription('Dein Kontostand und die letzten 5 Transaktionen.') as SlashCommandBuilder),
  execute: withGuildScope({ requireSlotToggle: 'economyActive', acceptSlotOption: true }, async (i, scope) => {
    const connId = scope.nitradoConnId!;
    const acc = await getAccountOrZero(scope.guildId, connId, scope.actorDiscordId);
    const cfg = await getConfig(scope.guildId, connId);
    const txs = await recentTransactions(scope.guildId, connId, scope.actorDiscordId, 5);
    const total = acc.walletBalance + acc.bankBalance;
    const lines = txs.length === 0
      ? '_keine Transaktionen_'
      : txs.map(t => `\`${t.delta >= 0n ? '+' : ''}${fmt(t.delta)}\` ${cfg.emoji} ${txLabel(t.type)}${t.reason ? ` — ${t.reason}` : ''}`).join('\n');
    const e = new EmbedBuilder()
      .setColor(0xF1C40F)
      .setAuthor({ name: i.user.username, iconURL: i.user.displayAvatarURL() })
      .setTitle(`${cfg.emoji} Kontostand`)
      .setDescription(`Konto von **${i.user.username}**`)
      .addFields(
        { name: '👛 Wallet', value: `**${fmt(acc.walletBalance)}** ${cfg.emoji}`, inline: true },
        { name: '🏦 Bank', value: `**${fmt(acc.bankBalance)}** ${cfg.emoji}`, inline: true },
        { name: 'Σ Gesamt', value: `**${fmt(total)}** ${cfg.emoji}`, inline: true },
        { name: '📜 Letzte 5 Transaktionen', value: lines.slice(0, 1024), inline: false },
      )
      .setFooter({ text: await guildFooter(scope.guildId, connId) })
      .setTimestamp();
    await embedReply(i, e, false);
  }),
};

// ============================================================
// /pay — User → User (Wallet), immer innerhalb desselben Slots
// ============================================================
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
      await pay({
        guildId: scope.guildId,
        nitradoConnId: connId,
        fromUserId: scope.actorDiscordId,
        toUserId: asUserDiscordId(target.id),
        amount: betrag,
        reason: grund,
      });
    } catch (e) {
      await statusReply(i, 'ERROR', 'Zahlung fehlgeschlagen', { description: 'Die Zahlung konnte nicht durchgeführt werden.', fields: [{ name: '📝 Grund', value: (e as Error).message }] });
      return;
    }
    logAudit('ECON_PAY', 'ECONOMY', { guildId: scope.guildId, nitradoConnId: connId, from: scope.actorDiscordId, to: target.id, amount: betrag.toString() });
    const cfg = await getConfig(scope.guildId, connId);
    await statusReply(i, 'SUCCESS', 'Zahlung erfolgreich', {
      ephemeral: false,
      description: `Der Betrag wurde an <@${target.id}> gesendet.`,
      fields: [
        { name: '👤 Empfänger', value: `<@${target.id}>` },
        { name: '💰 Betrag', value: `${fmt(betrag)} ${cfg.emoji}` },
        { name: '📝 Grund', value: grund },
      ],
    });
  }),
};

// ============================================================
// /admin-pay — Admin-Korrektur im ausgewaehlten Slot
// ============================================================
export const adminPayCommand: Command = {
  data: slotOption(new SlashCommandBuilder()
    .setName('admin-pay')
    .setDescription('Owner/Berechtigt: Korrigiere das Wallet eines Users (positiv oder negativ).')
    .addUserOption(o => o.setName('user').setDescription('Ziel-User').setRequired(true))
    .addIntegerOption(o => o.setName('betrag').setDescription('Delta (negativ = abziehen, ungleich 0)').setRequired(true).setMinValue(-1_000_000_000).setMaxValue(1_000_000_000))
    .addStringOption(o => o.setName('grund').setDescription('Grund (3..200)').setRequired(true).setMinLength(3).setMaxLength(200)) as SlashCommandBuilder),
  execute: withGuildScope({ requirePerm: 'economy.manage', acceptSlotOption: true }, async (i, scope) => {
    const connId = scope.nitradoConnId!;
    const target = i.options.getUser('user', true);
    if (target.bot) { await statusReply(i, 'ERROR', 'Aktion nicht erlaubt', { description: 'Die Aktion konnte nicht durchgeführt werden.', fields: [{ name: '📝 Grund', value: 'Ein Bot kann nicht begünstigt werden.' }] }); return; }
    const delta = BigInt(i.options.getInteger('betrag', true));
    if (delta === 0n) { await statusReply(i, 'ERROR', 'Ungültiger Betrag', { description: 'Die Aktion konnte nicht durchgeführt werden.', fields: [{ name: '📝 Grund', value: 'Der Betrag darf nicht 0 sein.' }] }); return; }
    const grund = i.options.getString('grund', true);
    try {
      await adminPay({
        guildId: scope.guildId,
        nitradoConnId: connId,
        targetUserId: asUserDiscordId(target.id),
        delta,
        reason: grund,
        actorDiscordId: scope.actorDiscordId,
      });
    } catch (e) { await statusReply(i, 'ERROR', 'Aktion fehlgeschlagen', { description: 'Die Aktion konnte nicht durchgeführt werden.', fields: [{ name: '📝 Grund', value: (e as Error).message }] }); return; }
    logAudit('ECON_ADMIN_PAY', 'ECONOMY', { guildId: scope.guildId, nitradoConnId: connId, target: target.id, delta: delta.toString(), actor: scope.actorDiscordId });
    const cfg = await getConfig(scope.guildId, connId);
    const abs = delta < 0n ? -delta : delta;
    await statusReply(i, 'SUCCESS', delta > 0n ? 'Guthaben hinzugefügt' : 'Guthaben abgezogen', {
      footerText: 'V-Bot Economy • Administration',
      description: `Das Wallet von <@${target.id}> wurde angepasst.`,
      fields: [
        { name: '👤 Spieler', value: `<@${target.id}>` },
        { name: delta > 0n ? '💰 Hinzugefügt' : '💰 Abgezogen', value: `${fmt(abs)} ${cfg.emoji}` },
        { name: '📝 Grund', value: grund },
      ],
    });
  }),
};

// /grant wurde entfernt. Administrative Force-Link-Aktionen laufen ausschliesslich
// ueber /force-link + /confirm-action, damit Slotbindung und Step-up-Bestaetigung
// nicht durch einen parallelen Alias umgangen werden koennen.

// ============================================================
// /links — listet alle Bindungen im ausgewaehlten Slot
// ============================================================
export const linksCommand: Command = {
  data: slotOption(new SlashCommandBuilder()
    .setName('links')
    .setDescription('Owner/Berechtigt: Listet alle Spielfigur-Verknüpfungen im ausgewählten Slot.') as SlashCommandBuilder),
  execute: withGuildScope({ requirePerm: 'economy.view', acceptSlotOption: true }, async (i, scope) => {
    const connId = scope.nitradoConnId!;
    const rows = await prisma.gameIdentityLink.findMany({
      where: { guildId: scope.guildId, nitradoConnId: connId, status: 'VERIFIED' },
      orderBy: { verifiedAt: 'desc' },
      take: 50,
    });
    if (rows.length === 0) { await statusReply(i, 'INFO', 'Verknüpfungen', { description: 'Im ausgewählten Slot gibt es noch keine verifizierten Verknüpfungen.' }); return; }
    const lines = rows.map(r => `<@${r.userDiscordId}> • ✅ verifiziert`).join('\n');
    const e = new EmbedBuilder()
      .setColor(0xF1C40F)
      .setTitle(`🔗 Verknüpfungen (${rows.length})`)
      .setDescription(lines.slice(0, 4000))
      .setFooter({ text: await guildFooter(scope.guildId, connId) })
      .setTimestamp();
    await embedReply(i, e);
  }),
};

// ============================================================
// /deposit — Wallet → Bank
// ============================================================
export const depositCommand: Command = {
  data: slotOption(new SlashCommandBuilder()
    .setName('deposit')
    .setDescription('Bringt Coins von Wallet auf die Bank.')
    .addIntegerOption(o => o.setName('betrag').setDescription('Betrag').setRequired(true).setMinValue(1).setMaxValue(1_000_000_000)) as SlashCommandBuilder),
  execute: withGuildScope({ requireSlotToggle: 'economyActive', acceptSlotOption: true }, async (i, scope) => {
    const connId = scope.nitradoConnId!;
    const amount = BigInt(i.options.getInteger('betrag', true));
    try { await deposit(scope.guildId, connId, scope.actorDiscordId, amount); }
    catch (e) { await statusReply(i, 'ERROR', 'Einzahlung fehlgeschlagen', { footerText: 'V-Bot Bank', description: 'Die Einzahlung konnte nicht durchgeführt werden.', fields: [{ name: '📝 Grund', value: (e as Error).message }] }); return; }
    const cfg = await getConfig(scope.guildId, connId);
    const acc = await getAccountOrZero(scope.guildId, connId, scope.actorDiscordId);
    await statusReply(i, 'SUCCESS', 'Einzahlung erfolgreich', {
      footerText: 'V-Bot Bank',
      description: 'Der Betrag wurde von deiner Wallet auf dein Bankkonto übertragen.',
      fields: [
        { name: '💰 Betrag', value: `${fmt(amount)} ${cfg.emoji}` },
        { name: '🏦 Neues Bankguthaben', value: `${fmt(acc.bankBalance)} ${cfg.emoji}` },
      ],
    });
  }),
};

// ============================================================
// /withdraw — Bank → Wallet
// ============================================================
export const withdrawCommand: Command = {
  data: slotOption(new SlashCommandBuilder()
    .setName('withdraw')
    .setDescription('Hebt Coins von der Bank auf die Wallet ab.')
    .addIntegerOption(o => o.setName('betrag').setDescription('Betrag').setRequired(true).setMinValue(1).setMaxValue(1_000_000_000)) as SlashCommandBuilder),
  execute: withGuildScope({ requireSlotToggle: 'economyActive', acceptSlotOption: true }, async (i, scope) => {
    const connId = scope.nitradoConnId!;
    const amount = BigInt(i.options.getInteger('betrag', true));
    try { await withdraw(scope.guildId, connId, scope.actorDiscordId, amount); }
    catch (e) { await statusReply(i, 'ERROR', 'Auszahlung fehlgeschlagen', { footerText: 'V-Bot Bank', description: 'Die Auszahlung konnte nicht durchgeführt werden.', fields: [{ name: '📝 Grund', value: (e as Error).message }] }); return; }
    const cfg = await getConfig(scope.guildId, connId);
    const acc = await getAccountOrZero(scope.guildId, connId, scope.actorDiscordId);
    await statusReply(i, 'SUCCESS', 'Auszahlung erfolgreich', {
      footerText: 'V-Bot Bank',
      description: 'Der Betrag wurde von deinem Bankkonto auf deine Wallet übertragen.',
      fields: [
        { name: '💰 Betrag', value: `${fmt(amount)} ${cfg.emoji}` },
        { name: '👛 Neue Wallet', value: `${fmt(acc.walletBalance)} ${cfg.emoji}` },
      ],
    });
  }),
};

// ============================================================
// /transfer — Bank → Bank, konstruktiv innerhalb desselben Slots
// ============================================================
export const transferCommand: Command = {
  data: slotOption(new SlashCommandBuilder()
    .setName('transfer')
    .setDescription('Sende Coins von deiner Bank an die Bank eines anderen Users.')
    .addUserOption(o => o.setName('user').setDescription('Empfänger').setRequired(true))
    .addIntegerOption(o => o.setName('betrag').setDescription('Betrag').setRequired(true).setMinValue(1).setMaxValue(1_000_000_000)) as SlashCommandBuilder),
  execute: withGuildScope({ requireSlotToggle: 'economyActive', acceptSlotOption: true }, async (i, scope) => {
    const connId = scope.nitradoConnId!;
    const target = i.options.getUser('user', true);
    if (target.bot) { await statusReply(i, 'ERROR', 'Überweisung abgelehnt', { footerText: 'V-Bot Bank', description: 'Die Überweisung konnte nicht durchgeführt werden.', fields: [{ name: '📝 Grund', value: 'Ein Bot kann keine Coins erhalten.' }] }); return; }
    if (target.id === i.user.id) { await statusReply(i, 'ERROR', 'Überweisung abgelehnt', { footerText: 'V-Bot Bank', description: 'Die Überweisung konnte nicht durchgeführt werden.', fields: [{ name: '📝 Grund', value: 'Eine Überweisung an das eigene Konto ist nicht möglich.' }] }); return; }
    const amount = BigInt(i.options.getInteger('betrag', true));
    try {
      await transferBank({
        guildId: scope.guildId,
        nitradoConnId: connId,
        fromUserId: scope.actorDiscordId,
        toUserId: asUserDiscordId(target.id),
        amount,
      });
    } catch (e) { await statusReply(i, 'ERROR', 'Überweisung fehlgeschlagen', { footerText: 'V-Bot Bank', description: 'Die Überweisung konnte nicht durchgeführt werden.', fields: [{ name: '📝 Grund', value: (e as Error).message }] }); return; }
    logAudit('ECON_TRANSFER', 'ECONOMY', { guildId: scope.guildId, nitradoConnId: connId, from: scope.actorDiscordId, to: target.id, amount: amount.toString() });
    const cfg = await getConfig(scope.guildId, connId);
    await statusReply(i, 'SUCCESS', 'Überweisung erfolgreich', {
      footerText: 'V-Bot Bank',
      description: `Der Betrag wurde an <@${target.id}> überwiesen.`,
      fields: [
        { name: '👤 Empfänger', value: `<@${target.id}>` },
        { name: '💰 Betrag', value: `${fmt(amount)} ${cfg.emoji}` },
        { name: '🏦 Quelle', value: 'Bankkonto' },
      ],
    });
  }),
};

// ============================================================
// /bank — Wallet/Bank/Zinssatz
// ============================================================
export const bankCommand: Command = {
  data: slotOption(new SlashCommandBuilder()
    .setName('bank')
    .setDescription('Zeigt Wallet, Bank und Gesamtguthaben.') as SlashCommandBuilder),
  execute: withGuildScope({ requireSlotToggle: 'economyActive', acceptSlotOption: true }, async (i, scope) => {
    const connId = scope.nitradoConnId!;
    const acc = await getAccountOrZero(scope.guildId, connId, scope.actorDiscordId);
    const cfg = await getConfig(scope.guildId, connId);
    const total = acc.walletBalance + acc.bankBalance;
    const e = new EmbedBuilder()
      .setColor(0xF1C40F)
      .setAuthor({ name: i.user.username, iconURL: i.user.displayAvatarURL() })
      .setTitle(`${cfg.emoji} Bankübersicht`)
      .setDescription(`Konto von **${i.user.username}**`)
      .addFields(
        { name: '👛 Wallet', value: `**${fmt(acc.walletBalance)}** ${cfg.emoji}`, inline: true },
        { name: '🏦 Bank', value: `**${fmt(acc.bankBalance)}** ${cfg.emoji}`, inline: true },
        { name: 'Σ Gesamt', value: `**${fmt(total)}** ${cfg.emoji}`, inline: true },
      )
      .setFooter({ text: await guildFooter(scope.guildId, connId) })
      .setTimestamp();
    await embedReply(i, e, false);
  }),
};
