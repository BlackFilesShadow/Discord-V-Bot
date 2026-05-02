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
import { logAudit } from '../../utils/logger';

const STEAM64 = /^7656\d{13}$/;
const CHARNAME = /^[A-Za-z0-9 _.\-]{3,32}$/;
function isValidGameId(s: string): boolean { return STEAM64.test(s) || CHARNAME.test(s); }

function fmt(n: bigint): string { return n.toLocaleString('de-DE'); }

async function reply(i: ChatInputCommandInteraction, content: string, ephemeral = true): Promise<void> {
  if (ephemeral) await i.reply({ content, flags: MessageFlags.Ephemeral });
  else await i.reply({ content });
}

async function embedReply(i: ChatInputCommandInteraction, embed: EmbedBuilder, ephemeral = true): Promise<void> {
  if (ephemeral) await i.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  else await i.reply({ embeds: [embed], allowedMentions: { parse: [] } });
}

// ============================================================
// /link — bindet Discord-User an Steam64/Charname im aktiven Slot
// ============================================================
export const linkCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('link')
    .setDescription('Verknuepft deinen Discord-Account mit deiner Spielfigur (Steam64 oder Charname).')
    .addStringOption(o => o.setName('id').setDescription('Steam64-ID (17 Stellen) oder Charname').setRequired(true).setMaxLength(64)),
  execute: withGuildScope({ requireSlotToggle: 'economyActive' }, async (i, scope) => {
    const id = i.options.getString('id', true).trim();
    if (!isValidGameId(id)) { await reply(i, 'Ungueltige ID. Bitte Steam64 (17 Stellen, beginnt mit 7656) oder Charname (3..32 Zeichen).'); return; }

    try {
      await prisma.economyLink.create({
        data: {
          guildId: scope.guildId, nitradoConnId: scope.nitradoConnId!,
          userDiscordId: scope.actorDiscordId, gameId: id,
        },
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') {
        await reply(i, 'Du bist bereits verknuepft oder die ID ist im aktiven Slot vergeben. `/unlink` zuerst.');
        return;
      }
      throw e;
    }
    logAudit('LINK_CREATED', 'ECONOMY', { guildId: scope.guildId, slotId: scope.nitradoConnId, actor: scope.actorDiscordId, gameId: id });
    await reply(i, `Verknuepft mit \`${id}\`.`);
  }),
};

// ============================================================
// /unlink — entfernt eigene Bindung im aktiven Slot
// ============================================================
export const unlinkCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('unlink')
    .setDescription('Loescht deine Spielfigur-Verknuepfung im aktiven Server.'),
  execute: withGuildScope({ requireSlotToggle: 'economyActive' }, async (i, scope) => {
    const out = await prisma.economyLink.deleteMany({
      where: { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId!, userDiscordId: scope.actorDiscordId },
    });
    if (out.count === 0) { await reply(i, 'Du hast keine Verknuepfung in diesem Server.'); return; }
    logAudit('LINK_DELETED', 'ECONOMY', { guildId: scope.guildId, slotId: scope.nitradoConnId, actor: scope.actorDiscordId });
    await reply(i, 'Verknuepfung entfernt.');
  }),
};

// ============================================================
// /status — zeigt Link + Account-Stand
// ============================================================
export const statusCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('status')
    .setDescription('Zeigt deinen Verknuepfungs- und Konto-Status.')
    .addUserOption(o => o.setName('user').setDescription('Optional anderer User').setRequired(false)) as SlashCommandBuilder,
  execute: withGuildScope({ requireSlotToggle: 'economyActive' }, async (i, scope) => {
    const target = i.options.getUser('user') ?? i.user;
    const targetId = asUserDiscordId(target.id);
    const link = await prisma.economyLink.findUnique({
      where: { guildId_nitradoConnId_userDiscordId: { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId!, userDiscordId: targetId } },
    });
    const acc = await getOrCreateAccount(scope.guildId, targetId);
    const cfg = await getConfig(scope.guildId);
    const e = new EmbedBuilder()
      .setTitle(`Status: ${target.username}`)
      .addFields(
        { name: 'Verknuepfung', value: link ? `\`${link.gameId}\`` : '_keine_', inline: false },
        { name: 'Wallet', value: `${fmt(acc.walletBalance)} ${cfg.emoji}`, inline: true },
        { name: 'Bank', value: `${fmt(acc.bankBalance)} ${cfg.emoji}`, inline: true },
      );
    await embedReply(i, e, target.id === i.user.id);
  }),
};

// ============================================================
// /balance — eigener Kontostand + letzte 5 Tx
// ============================================================
export const balanceCommand: Command = {
  data: new SlashCommandBuilder().setName('balance').setDescription('Dein Kontostand und die letzten 5 Transaktionen.'),
  execute: withGuildScope({ requireSlotToggle: 'economyActive' }, async (i, scope) => {
    const acc = await getOrCreateAccount(scope.guildId, scope.actorDiscordId);
    const cfg = await getConfig(scope.guildId);
    const txs = await recentTransactions(scope.guildId, scope.actorDiscordId, 5);
    const lines = txs.length === 0
      ? '_keine Transaktionen_'
      : txs.map(t => `\`${t.delta >= 0n ? '+' : ''}${fmt(t.delta)}\` ${cfg.emoji} ${t.type}${t.reason ? ` — ${t.reason}` : ''}`).join('\n');
    const e = new EmbedBuilder()
      .setTitle('Kontostand')
      .addFields(
        { name: 'Wallet', value: `${fmt(acc.walletBalance)} ${cfg.emoji}`, inline: true },
        { name: 'Bank', value: `${fmt(acc.bankBalance)} ${cfg.emoji}`, inline: true },
        { name: 'Letzte 5', value: lines, inline: false },
      );
    await embedReply(i, e);
  }),
};

// ============================================================
// /pay — User → User (Wallet)
// ============================================================
export const payCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('pay')
    .setDescription('Sende Coins aus deiner Wallet an einen anderen User.')
    .addUserOption(o => o.setName('user').setDescription('Empfaenger').setRequired(true))
    .addIntegerOption(o => o.setName('betrag').setDescription('Betrag').setRequired(true).setMinValue(1).setMaxValue(1_000_000_000))
    .addStringOption(o => o.setName('grund').setDescription('Grund (max 100)').setRequired(false).setMaxLength(100)) as SlashCommandBuilder,
  execute: withGuildScope({ requireSlotToggle: 'economyActive' }, async (i, scope) => {
    const target = i.options.getUser('user', true);
    if (target.bot) { await reply(i, 'Bots koennen keine Coins erhalten.'); return; }
    if (target.id === i.user.id) { await reply(i, 'Du kannst dir nicht selbst Coins senden.'); return; }
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
      await reply(i, `Fehlgeschlagen: ${(e as Error).message}`);
      return;
    }
    logAudit('ECON_PAY', 'ECONOMY', { guildId: scope.guildId, from: scope.actorDiscordId, to: target.id, amount: betrag.toString() });
    const cfg = await getConfig(scope.guildId);
    await reply(i, `${fmt(betrag)} ${cfg.emoji} an <@${target.id}> ueberwiesen.`, false);
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
    if (target.bot) { await reply(i, 'Bots koennen nicht beguenstigt werden.'); return; }
    const delta = BigInt(i.options.getInteger('betrag', true));
    if (delta === 0n) { await reply(i, 'Delta darf nicht 0 sein.'); return; }
    const grund = i.options.getString('grund', true);
    try {
      await adminPay({
        guildId: scope.guildId, targetUserId: asUserDiscordId(target.id),
        delta, reason: grund, actorDiscordId: scope.actorDiscordId,
      });
    } catch (e) { await reply(i, `Fehlgeschlagen: ${(e as Error).message}`); return; }
    logAudit('ECON_ADMIN_PAY', 'ECONOMY', { guildId: scope.guildId, target: target.id, delta: delta.toString(), actor: scope.actorDiscordId });
    const cfg = await getConfig(scope.guildId);
    await reply(i, `Wallet von <@${target.id}> um ${fmt(delta)} ${cfg.emoji} angepasst.`);
  }),
};

// ============================================================
// /grant — Force-Link (Owner ueberschreibt fremde Bindung)
// ============================================================
export const grantCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('grant')
    .setDescription('Owner/Berechtigt: Erzwingt eine Spielfigur-Verknuepfung.')
    .addUserOption(o => o.setName('user').setDescription('Discord-User').setRequired(true))
    .addStringOption(o => o.setName('id').setDescription('Steam64 oder Charname').setRequired(true).setMaxLength(64)) as SlashCommandBuilder,
  execute: withGuildScope({ requirePerm: 'economy.manage' }, async (i, scope) => {
    const target = i.options.getUser('user', true);
    if (target.bot) { await reply(i, 'Bots koennen nicht verknuepft werden.'); return; }
    const id = i.options.getString('id', true).trim();
    if (!isValidGameId(id)) { await reply(i, 'Ungueltige ID.'); return; }
    await prisma.economyLink.upsert({
      where: { guildId_nitradoConnId_userDiscordId: { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId!, userDiscordId: asUserDiscordId(target.id) } },
      create: { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId!, userDiscordId: asUserDiscordId(target.id), gameId: id },
      update: { gameId: id, linkedAt: new Date() },
    });
    logAudit('LINK_FORCE_GRANTED', 'ECONOMY', { guildId: scope.guildId, slotId: scope.nitradoConnId, target: target.id, gameId: id, actor: scope.actorDiscordId });
    await reply(i, `<@${target.id}> wurde mit \`${id}\` verknuepft.`);
  }),
};

// ============================================================
// /links — listet alle Bindungen im aktiven Slot
// ============================================================
export const linksCommand: Command = {
  data: new SlashCommandBuilder().setName('links').setDescription('Owner/Berechtigt: Listet alle Spielfigur-Verknuepfungen im aktiven Slot.'),
  execute: withGuildScope({ requirePerm: 'economy.view' }, async (i, scope) => {
    const rows = await prisma.economyLink.findMany({
      where: { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId! },
      orderBy: { linkedAt: 'desc' },
      take: 50,
    });
    if (rows.length === 0) { await reply(i, '_keine Verknuepfungen_'); return; }
    const lines = rows.map(r => `<@${r.userDiscordId}> → \`${r.gameId}\``).join('\n');
    const e = new EmbedBuilder().setTitle(`Verknuepfungen (${rows.length})`).setDescription(lines.slice(0, 4000));
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
    catch (e) { await reply(i, `Fehlgeschlagen: ${(e as Error).message}`); return; }
    const cfg = await getConfig(scope.guildId);
    await reply(i, `${fmt(amount)} ${cfg.emoji} eingezahlt.`);
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
    catch (e) { await reply(i, `Fehlgeschlagen: ${(e as Error).message}`); return; }
    const cfg = await getConfig(scope.guildId);
    await reply(i, `${fmt(amount)} ${cfg.emoji} abgehoben.`);
  }),
};

// ============================================================
// /transfer — Bank → Bank (an anderen User)
// ============================================================
export const transferCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('transfer')
    .setDescription('Sende Coins von deiner Bank an die Bank eines anderen Users.')
    .addUserOption(o => o.setName('user').setDescription('Empfaenger').setRequired(true))
    .addIntegerOption(o => o.setName('betrag').setDescription('Betrag').setRequired(true).setMinValue(1).setMaxValue(1_000_000_000)) as SlashCommandBuilder,
  execute: withGuildScope({ requireSlotToggle: 'economyActive' }, async (i, scope) => {
    const target = i.options.getUser('user', true);
    if (target.bot) { await reply(i, 'Bots koennen keine Coins erhalten.'); return; }
    if (target.id === i.user.id) { await reply(i, 'Self-Transfer nicht erlaubt.'); return; }
    const amount = BigInt(i.options.getInteger('betrag', true));
    try {
      await transferBank({
        guildId: scope.guildId, fromUserId: scope.actorDiscordId,
        toUserId: asUserDiscordId(target.id), amount,
      });
    } catch (e) { await reply(i, `Fehlgeschlagen: ${(e as Error).message}`); return; }
    logAudit('ECON_TRANSFER', 'ECONOMY', { guildId: scope.guildId, from: scope.actorDiscordId, to: target.id, amount: amount.toString() });
    const cfg = await getConfig(scope.guildId);
    await reply(i, `${fmt(amount)} ${cfg.emoji} an <@${target.id}> Bank ueberwiesen.`);
  }),
};

// ============================================================
// /bank — Wallet/Bank/Zinssatz
// ============================================================
export const bankCommand: Command = {
  data: new SlashCommandBuilder().setName('bank').setDescription('Zeigt Wallet, Bank und Zinssatz.'),
  execute: withGuildScope({ requireSlotToggle: 'economyActive' }, async (i, scope) => {
    const acc = await getOrCreateAccount(scope.guildId, scope.actorDiscordId);
    const cfg = await getConfig(scope.guildId);
    const total = acc.walletBalance + acc.bankBalance;
    const e = new EmbedBuilder()
      .setColor(0xF1C40F)
      .setAuthor({ name: i.user.username, iconURL: i.user.displayAvatarURL() })
      .setTitle(`${cfg.emoji} Bankuebersicht`)
      .setDescription(`Konto von **${i.user.username}**`)
      .addFields(
        { name: '\uD83D\uDC5B Wallet', value: `**${fmt(acc.walletBalance)}** ${cfg.emoji}`, inline: true },
        { name: '\uD83C\uDFE6 Bank', value: `**${fmt(acc.bankBalance)}** ${cfg.emoji}`, inline: true },
        { name: '\u03A3 Gesamt', value: `**${fmt(total)}** ${cfg.emoji}`, inline: true },
        { name: '\uD83D\uDCC8 Zinsen / Tag', value: `${cfg.bankInterestPercent}%`, inline: true },
      )
      .setFooter({ text: `Guild ${scope.guildId}` })
      .setTimestamp();
    await embedReply(i, e, false);
  }),
};
