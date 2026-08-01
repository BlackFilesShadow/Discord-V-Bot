/**
 * Phase 3 — Economy + Link-Commands (12 Stueck).
 *
 * Alle Commands laufen ueber `withGuildScope` (Guild+Slot+Owner+Perms in einem Schritt).
 * Geld-Werte: BigInt. Replies: ephemeral bei privaten Daten/Fehlern.
 */

import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, MessageFlags,
} from 'discord.js';
import type { Command } from '../../types';
import prisma from '../../database/prisma';
import { withGuildScope } from '../middleware/withGuildScope';
import {
  getOrCreateAccount, recentTransactions, pay, adminPay, deposit, withdraw, transferBank, getConfig,
} from '../../modules/economy/repository';
import { asUserDiscordId } from '../../types/scope';
import type { GuildId } from '../../types/scope';
import { logAudit } from '../../utils/logger';
import { buildStatusEmbed, type EmbedStatus } from '../../utils/statusEmbed';

const STEAM64 = /^7656\d{13}$/;
const CHARNAME = /^[A-Za-z0-9 _.\-]{3,32}$/;
function isValidGameId(s: string): boolean { return STEAM64.test(s) || CHARNAME.test(s); }

function fmt(n: bigint): string { return n.toLocaleString('de-DE'); }

// §5.2: Transaktionstypen als deutsche Klartext-Labels statt Enum-Namen.
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

// §5: Footer zeigt den Nitrado-Alias der Guild, nicht die Guild-ID.
async function guildFooter(guildId: GuildId): Promise<string> {
  try {
    const conn = await prisma.nitradoConnection.findFirst({
      where: { guildId },
      orderBy: { slot: 'asc' },
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

// Embed-Plan Rev IV: jede Meldung als Status-Embed (kein Klartext mehr).
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
// /link — bindet Discord-User an Steam64/Charname im aktiven Slot
// ============================================================
export const linkCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('link')
    .setDescription('Verknüpft deinen Discord-Account mit deiner Spielfigur (Steam64 oder Charname).')
    .addStringOption(o => o.setName('id').setDescription('Steam64-ID (17 Stellen) oder Charname').setRequired(true).setMaxLength(64)),
  execute: withGuildScope({ requireSlotToggle: 'economyActive' }, async (i, scope) => {
    const id = i.options.getString('id', true).trim();
    if (!isValidGameId(id)) { await statusReply(i, 'ERROR', 'Verknüpfung fehlgeschlagen', { description: 'Die ID ist ungültig.', fields: [{ name: '📝 Grund', value: 'Bitte Steam64 (17 Stellen, beginnt mit 7656) oder Charname (3–32 Zeichen) angeben.' }] }); return; }

    try {
      await prisma.economyLink.create({
        data: {
          guildId: scope.guildId, nitradoConnId: scope.nitradoConnId!,
          userDiscordId: scope.actorDiscordId, gameId: id,
        },
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') {
        await statusReply(i, 'ERROR', 'Bereits verknüpft', { description: 'Die Verknüpfung konnte nicht erstellt werden.', fields: [{ name: '📝 Grund', value: 'Du bist bereits verknüpft oder die ID ist im aktiven Slot vergeben. Nutze zuerst /unlink.' }] });
        return;
      }
      throw e;
    }
    logAudit('LINK_CREATED', 'ECONOMY', { guildId: scope.guildId, slotId: scope.nitradoConnId, actor: scope.actorDiscordId, gameId: id });
    await statusReply(i, 'SUCCESS', 'Verknüpft', { description: 'Deine Spielfigur wurde verknüpft.', fields: [{ name: '🎮 Spielfigur', value: `\`${id}\`` }] });
  }),
};

// ============================================================
// /unlink — entfernt eigene Bindung im aktiven Slot
// ============================================================
export const unlinkCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('unlink')
    .setDescription('Löscht deine Spielfigur-Verknüpfung im aktiven Server.'),
  execute: withGuildScope({ requireSlotToggle: 'economyActive' }, async (i, scope) => {
    const out = await prisma.economyLink.deleteMany({
      where: { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId!, userDiscordId: scope.actorDiscordId },
    });
    if (out.count === 0) { await statusReply(i, 'INFO', 'Keine Verknüpfung', { description: 'Du hast in diesem Server keine Verknüpfung.' }); return; }
    logAudit('LINK_DELETED', 'ECONOMY', { guildId: scope.guildId, slotId: scope.nitradoConnId, actor: scope.actorDiscordId });
    await statusReply(i, 'SUCCESS', 'Verknüpfung entfernt', { description: 'Deine Spielfigur-Verknüpfung wurde entfernt.' });
  }),
};

// ============================================================
// HINWEIS: Der fruehere Economy-`/status` Command wurde entfernt.
// Grund: Namens-Kollision mit user/status.ts (Bot-Health `/status`).
// Ersatz im Dashboard: Bereich "Wirtschaft" — GET /api/v2/guilds/:guildId/economy/overview
// (guild-weite Uebersicht) + GET /accounts/:userDiscordId (Einzel-Lookup).
// Spec §10: "Nur user/status.ts bleibt als Discord Command /status."
// ============================================================

// ============================================================
// /balance — eigener Kontostand + letzte 5 Tx (Public Embed, V-Bot Style)
// ============================================================
export const balanceCommand: Command = {
  data: new SlashCommandBuilder().setName('balance').setDescription('Dein Kontostand und die letzten 5 Transaktionen.'),
  execute: withGuildScope({ requireSlotToggle: 'economyActive' }, async (i, scope) => {
    const acc = await getOrCreateAccount(scope.guildId, scope.actorDiscordId);
    const cfg = await getConfig(scope.guildId);
    const txs = await recentTransactions(scope.guildId, scope.actorDiscordId, 5);
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
        { name: '\uD83D\uDC5B Wallet', value: `**${fmt(acc.walletBalance)}** ${cfg.emoji}`, inline: true },
        { name: '\uD83C\uDFE6 Bank', value: `**${fmt(acc.bankBalance)}** ${cfg.emoji}`, inline: true },
        { name: '\u03A3 Gesamt', value: `**${fmt(total)}** ${cfg.emoji}`, inline: true },
        { name: '\uD83D\uDCDC Letzte 5 Transaktionen', value: lines.slice(0, 1024), inline: false },
      )
      .setFooter({ text: await guildFooter(scope.guildId) })
      .setTimestamp();
    await embedReply(i, e, false);
  }),
};

// ============================================================
// /pay — User → User (Wallet)
// ============================================================
export const payCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('pay')
    .setDescription('Sende Coins aus deiner Wallet an einen anderen User.')
    .addUserOption(o => o.setName('user').setDescription('Empfänger').setRequired(true))
    .addIntegerOption(o => o.setName('betrag').setDescription('Betrag').setRequired(true).setMinValue(1).setMaxValue(1_000_000_000))
    .addStringOption(o => o.setName('grund').setDescription('Grund (max 100)').setRequired(false).setMaxLength(100)) as SlashCommandBuilder,
  execute: withGuildScope({ requireSlotToggle: 'economyActive' }, async (i, scope) => {
    const target = i.options.getUser('user', true);
    if (target.bot) { await statusReply(i, 'ERROR', 'Zahlung abgelehnt', { description: 'Die Zahlung konnte nicht durchgeführt werden.', fields: [{ name: '📝 Grund', value: 'Ein Bot kann keine Coins erhalten.' }] }); return; }
    if (target.id === i.user.id) { await statusReply(i, 'ERROR', 'Zahlung abgelehnt', { description: 'Die Zahlung konnte nicht durchgeführt werden.', fields: [{ name: '📝 Grund', value: 'Eine Zahlung an dich selbst ist nicht möglich.' }] }); return; }
    const betrag = BigInt(i.options.getInteger('betrag', true));
    const grund = i.options.getString('grund') ?? 'Pay';
    try {
      await pay({
        guildId: scope.guildId,
        fromUserId: scope.actorDiscordId,
        toUserId: asUserDiscordId(target.id),
        amount: betrag,
        reason: grund,
      });
    } catch (e) {
      await statusReply(i, 'ERROR', 'Zahlung fehlgeschlagen', { description: 'Die Zahlung konnte nicht durchgeführt werden.', fields: [{ name: '📝 Grund', value: (e as Error).message }] });
      return;
    }
    logAudit('ECON_PAY', 'ECONOMY', { guildId: scope.guildId, from: scope.actorDiscordId, to: target.id, amount: betrag.toString() });
    const cfg = await getConfig(scope.guildId);
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
// /admin-pay — Admin-Korrektur (positiv oder negativ)
// ============================================================
export const adminPayCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('admin-pay')
    .setDescription('Owner/Berechtigt: Korrigiere das Wallet eines Users (positiv oder negativ).')
    .addUserOption(o => o.setName('user').setDescription('Ziel-User').setRequired(true))
    .addIntegerOption(o => o.setName('betrag').setDescription('Delta (negativ = abziehen, ungleich 0)').setRequired(true).setMinValue(-1_000_000_000).setMaxValue(1_000_000_000))
    .addStringOption(o => o.setName('grund').setDescription('Grund (3..200)').setRequired(true).setMinLength(3).setMaxLength(200)) as SlashCommandBuilder,
  execute: withGuildScope({ requirePerm: 'economy.manage' }, async (i, scope) => {
    const target = i.options.getUser('user', true);
    if (target.bot) { await statusReply(i, 'ERROR', 'Aktion nicht erlaubt', { description: 'Die Aktion konnte nicht durchgeführt werden.', fields: [{ name: '📝 Grund', value: 'Ein Bot kann nicht begünstigt werden.' }] }); return; }
    const delta = BigInt(i.options.getInteger('betrag', true));
    if (delta === 0n) { await statusReply(i, 'ERROR', 'Ungültiger Betrag', { description: 'Die Aktion konnte nicht durchgeführt werden.', fields: [{ name: '📝 Grund', value: 'Der Betrag darf nicht 0 sein.' }] }); return; }
    const grund = i.options.getString('grund', true);
    try {
      await adminPay({
        guildId: scope.guildId, targetUserId: asUserDiscordId(target.id),
        delta, reason: grund, actorDiscordId: scope.actorDiscordId,
      });
    } catch (e) { await statusReply(i, 'ERROR', 'Aktion fehlgeschlagen', { description: 'Die Aktion konnte nicht durchgeführt werden.', fields: [{ name: '📝 Grund', value: (e as Error).message }] }); return; }
    logAudit('ECON_ADMIN_PAY', 'ECONOMY', { guildId: scope.guildId, target: target.id, delta: delta.toString(), actor: scope.actorDiscordId });
    const cfg = await getConfig(scope.guildId);
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

// ============================================================
// /grant — Force-Link (Owner ueberschreibt fremde Bindung)
// ============================================================
export const grantCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('grant')
    .setDescription('Owner/Berechtigt: Erzwingt eine Spielfigur-Verknüpfung.')
    .addUserOption(o => o.setName('user').setDescription('Discord-User').setRequired(true))
    .addStringOption(o => o.setName('id').setDescription('Steam64 oder Charname').setRequired(true).setMaxLength(64)) as SlashCommandBuilder,
  execute: withGuildScope({ requirePerm: 'economy.manage' }, async (i, scope) => {
    const target = i.options.getUser('user', true);
    if (target.bot) { await statusReply(i, 'ERROR', 'Verknüpfung abgelehnt', { description: 'Die Verknüpfung konnte nicht erstellt werden.', fields: [{ name: '📝 Grund', value: 'Ein Bot kann nicht verknüpft werden.' }] }); return; }
    const id = i.options.getString('id', true).trim();
    if (!isValidGameId(id)) { await statusReply(i, 'ERROR', 'Verknüpfung abgelehnt', { description: 'Die ID ist ungültig.', fields: [{ name: '📝 Grund', value: 'Bitte Steam64 (17 Stellen) oder Charname (3–32 Zeichen) angeben.' }] }); return; }
    await prisma.economyLink.upsert({
      where: { guildId_nitradoConnId_userDiscordId: { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId!, userDiscordId: asUserDiscordId(target.id) } },
      create: { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId!, userDiscordId: asUserDiscordId(target.id), gameId: id },
      update: { gameId: id, linkedAt: new Date() },
    });
    logAudit('LINK_FORCE_GRANTED', 'ECONOMY', { guildId: scope.guildId, slotId: scope.nitradoConnId, target: target.id, gameId: id, actor: scope.actorDiscordId });
    await statusReply(i, 'SUCCESS', 'Verknüpfung erstellt', { description: 'Die Spielfigur wurde zugewiesen.', fields: [{ name: '👤 User', value: `<@${target.id}>` }, { name: '🎮 Spielfigur', value: `\`${id}\`` }] });
  }),
};

// ============================================================
// /links — listet alle Bindungen im aktiven Slot
// ============================================================
export const linksCommand: Command = {
  data: new SlashCommandBuilder().setName('links').setDescription('Owner/Berechtigt: Listet alle Spielfigur-Verknüpfungen im aktiven Slot.'),
  execute: withGuildScope({ requirePerm: 'economy.view' }, async (i, scope) => {
    const rows = await prisma.economyLink.findMany({
      where: { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId! },
      orderBy: { linkedAt: 'desc' },
      take: 50,
    });
    if (rows.length === 0) { await statusReply(i, 'INFO', 'Verknüpfungen', { description: 'Im aktiven Slot gibt es noch keine Verknüpfungen.' }); return; }
    const lines = rows.map(r => `<@${r.userDiscordId}> → \`${r.gameId}\``).join('\n');
    const e = new EmbedBuilder()
      .setColor(0xF1C40F)
      .setTitle(`🔗 Verknüpfungen (${rows.length})`)
      .setDescription(lines.slice(0, 4000))
      .setFooter({ text: await guildFooter(scope.guildId) })
      .setTimestamp();
    await embedReply(i, e);
  }),
};

// ============================================================
// /deposit — Wallet → Bank
// ============================================================
export const depositCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('deposit')
    .setDescription('Bringt Coins von Wallet auf die Bank.')
    .addIntegerOption(o => o.setName('betrag').setDescription('Betrag').setRequired(true).setMinValue(1).setMaxValue(1_000_000_000)) as SlashCommandBuilder,
  execute: withGuildScope({ requireSlotToggle: 'economyActive' }, async (i, scope) => {
    const amount = BigInt(i.options.getInteger('betrag', true));
    try { await deposit(scope.guildId, scope.actorDiscordId, amount); }
    catch (e) { await statusReply(i, 'ERROR', 'Einzahlung fehlgeschlagen', { footerText: 'V-Bot Bank', description: 'Die Einzahlung konnte nicht durchgeführt werden.', fields: [{ name: '📝 Grund', value: (e as Error).message }] }); return; }
    const cfg = await getConfig(scope.guildId);
    const acc = await getOrCreateAccount(scope.guildId, scope.actorDiscordId);
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
  data: new SlashCommandBuilder()
    .setName('withdraw')
    .setDescription('Hebt Coins von der Bank auf die Wallet ab.')
    .addIntegerOption(o => o.setName('betrag').setDescription('Betrag').setRequired(true).setMinValue(1).setMaxValue(1_000_000_000)) as SlashCommandBuilder,
  execute: withGuildScope({ requireSlotToggle: 'economyActive' }, async (i, scope) => {
    const amount = BigInt(i.options.getInteger('betrag', true));
    try { await withdraw(scope.guildId, scope.actorDiscordId, amount); }
    catch (e) { await statusReply(i, 'ERROR', 'Auszahlung fehlgeschlagen', { footerText: 'V-Bot Bank', description: 'Die Auszahlung konnte nicht durchgeführt werden.', fields: [{ name: '📝 Grund', value: (e as Error).message }] }); return; }
    const cfg = await getConfig(scope.guildId);
    const acc = await getOrCreateAccount(scope.guildId, scope.actorDiscordId);
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
// /transfer — Bank → Bank (an anderen User)
// ============================================================
export const transferCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('transfer')
    .setDescription('Sende Coins von deiner Bank an die Bank eines anderen Users.')
    .addUserOption(o => o.setName('user').setDescription('Empfänger').setRequired(true))
    .addIntegerOption(o => o.setName('betrag').setDescription('Betrag').setRequired(true).setMinValue(1).setMaxValue(1_000_000_000)) as SlashCommandBuilder,
  execute: withGuildScope({ requireSlotToggle: 'economyActive' }, async (i, scope) => {
    const target = i.options.getUser('user', true);
    if (target.bot) { await statusReply(i, 'ERROR', 'Überweisung abgelehnt', { footerText: 'V-Bot Bank', description: 'Die Überweisung konnte nicht durchgeführt werden.', fields: [{ name: '📝 Grund', value: 'Ein Bot kann keine Coins erhalten.' }] }); return; }
    if (target.id === i.user.id) { await statusReply(i, 'ERROR', 'Überweisung abgelehnt', { footerText: 'V-Bot Bank', description: 'Die Überweisung konnte nicht durchgeführt werden.', fields: [{ name: '📝 Grund', value: 'Eine Überweisung an das eigene Konto ist nicht möglich.' }] }); return; }
    const amount = BigInt(i.options.getInteger('betrag', true));
    try {
      await transferBank({
        guildId: scope.guildId, fromUserId: scope.actorDiscordId,
        toUserId: asUserDiscordId(target.id), amount,
      });
    } catch (e) { await statusReply(i, 'ERROR', 'Überweisung fehlgeschlagen', { footerText: 'V-Bot Bank', description: 'Die Überweisung konnte nicht durchgeführt werden.', fields: [{ name: '📝 Grund', value: (e as Error).message }] }); return; }
    logAudit('ECON_TRANSFER', 'ECONOMY', { guildId: scope.guildId, from: scope.actorDiscordId, to: target.id, amount: amount.toString() });
    const cfg = await getConfig(scope.guildId);
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
  data: new SlashCommandBuilder().setName('bank').setDescription('Zeigt Wallet, Bank und Gesamtguthaben.'),
  execute: withGuildScope({ requireSlotToggle: 'economyActive' }, async (i, scope) => {
    const acc = await getOrCreateAccount(scope.guildId, scope.actorDiscordId);
    const cfg = await getConfig(scope.guildId);
    const total = acc.walletBalance + acc.bankBalance;
    const e = new EmbedBuilder()
      .setColor(0xF1C40F)
      .setAuthor({ name: i.user.username, iconURL: i.user.displayAvatarURL() })
      .setTitle(`${cfg.emoji} Bankübersicht`)
      .setDescription(`Konto von **${i.user.username}**`)
      .addFields(
        { name: '\uD83D\uDC5B Wallet', value: `**${fmt(acc.walletBalance)}** ${cfg.emoji}`, inline: true },
        { name: '\uD83C\uDFE6 Bank', value: `**${fmt(acc.bankBalance)}** ${cfg.emoji}`, inline: true },
        { name: '\u03A3 Gesamt', value: `**${fmt(total)}** ${cfg.emoji}`, inline: true },
      )
      .setFooter({ text: await guildFooter(scope.guildId) })
      .setTimestamp();
    await embedReply(i, e, false);
  }),
};
