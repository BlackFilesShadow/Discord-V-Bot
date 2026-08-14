import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import type { Command } from '../../types';
import prisma from '../../database/prisma';
import { withGuildScope } from '../middleware/withGuildScope';
import { adminPay } from '../../modules/economy/repository';
import { forceLink, unlinkUser, type LinkClient } from '../../modules/linking/linkService';
import { asUserDiscordId } from '../../types/scope';
import { MAX_GAME_SERVERS_PER_GUILD } from '../../modules/nitrado/gameServerScope';
import { config } from '../../config';
import { logAudit } from '../../utils/logger';

const STEAM64 = /^7656\d{13}$/;
const CHARNAME = /^[A-Za-z0-9 _.\-]{3,32}$/;

function slotOption(builder: SlashCommandBuilder): SlashCommandBuilder {
  return builder.addIntegerOption(o => o
    .setName('slot')
    .setDescription('Gameserver-Slot (bei mehreren Servern erforderlich)')
    .setRequired(false)
    .setMinValue(1)
    .setMaxValue(MAX_GAME_SERVERS_PER_GUILD)) as SlashCommandBuilder;
}

async function reply(i: ChatInputCommandInteraction, content: string): Promise<void> {
  await i.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
}

function validGameId(value: string): boolean {
  return STEAM64.test(value) || CHARNAME.test(value);
}

/**
 * Phase 8: explizite privilegierte Commands. Die fachliche Mutation bleibt in
 * den zentralen Economy-/Linking-Services; der Command-Layer macht nur Scope,
 * Permission, Validierung und Audit.
 */
export const addMoneyCommand: Command = {
  data: slotOption(new SlashCommandBuilder()
    .setName('add-money')
    .setDescription('Berechtigt: Fuegt einem User Wallet-Guthaben auf einem Gameserver hinzu.')
    .addUserOption(o => o.setName('user').setDescription('Ziel-User').setRequired(true))
    .addIntegerOption(o => o.setName('betrag').setDescription('Betrag').setRequired(true).setMinValue(1).setMaxValue(1_000_000_000))
    .addStringOption(o => o.setName('grund').setDescription('Grund (3..200)').setRequired(true).setMinLength(3).setMaxLength(200)) as SlashCommandBuilder),
  execute: withGuildScope({ requirePerm: 'economy.manage', requireSlotToggle: 'economyActive', acceptSlotOption: true }, async (i, scope) => {
    const target = i.options.getUser('user', true);
    if (target.bot) { await reply(i, 'Bots koennen kein Economy-Guthaben erhalten.'); return; }
    const amount = BigInt(i.options.getInteger('betrag', true));
    const reason = i.options.getString('grund', true);
    await adminPay({
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId!,
      targetUserId: asUserDiscordId(target.id),
      delta: amount,
      reason,
      actorDiscordId: scope.actorDiscordId,
    });
    logAudit('ECON_ADD_MONEY', 'ECONOMY', { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId, actor: scope.actorDiscordId, target: target.id, amount: amount.toString() });
    await reply(i, `${amount.toLocaleString('de-DE')} Coins wurden <@${target.id}> hinzugefuegt.`);
  }),
};

export const removeMoneyCommand: Command = {
  data: slotOption(new SlashCommandBuilder()
    .setName('remove-money')
    .setDescription('Berechtigt: Zieht einem User Wallet-Guthaben auf einem Gameserver ab.')
    .addUserOption(o => o.setName('user').setDescription('Ziel-User').setRequired(true))
    .addIntegerOption(o => o.setName('betrag').setDescription('Betrag').setRequired(true).setMinValue(1).setMaxValue(1_000_000_000))
    .addStringOption(o => o.setName('grund').setDescription('Grund (3..200)').setRequired(true).setMinLength(3).setMaxLength(200)) as SlashCommandBuilder),
  execute: withGuildScope({ requirePerm: 'economy.manage', requireSlotToggle: 'economyActive', acceptSlotOption: true }, async (i, scope) => {
    const target = i.options.getUser('user', true);
    if (target.bot) { await reply(i, 'Bots besitzen kein Economy-Guthaben.'); return; }
    const amount = BigInt(i.options.getInteger('betrag', true));
    const reason = i.options.getString('grund', true);
    await adminPay({
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId!,
      targetUserId: asUserDiscordId(target.id),
      delta: -amount,
      reason,
      actorDiscordId: scope.actorDiscordId,
    });
    logAudit('ECON_REMOVE_MONEY', 'ECONOMY', { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId, actor: scope.actorDiscordId, target: target.id, amount: amount.toString() });
    await reply(i, `${amount.toLocaleString('de-DE')} Coins wurden <@${target.id}> abgezogen.`);
  }),
};

export const forceLinkCommand: Command = {
  data: slotOption(new SlashCommandBuilder()
    .setName('force-link')
    .setDescription('Berechtigt: Erzwingt eine Discord-Spielidentitaets-Verknuepfung.')
    .addUserOption(o => o.setName('user').setDescription('Discord-User').setRequired(true))
    .addStringOption(o => o.setName('id').setDescription('Steam64 oder Charname').setRequired(true).setMaxLength(64)) as SlashCommandBuilder),
  execute: withGuildScope({ requirePerm: 'economy.manage', acceptSlotOption: true }, async (i, scope) => {
    const target = i.options.getUser('user', true);
    if (target.bot) { await reply(i, 'Bots koennen nicht mit Spielidentitaeten verknuepft werden.'); return; }
    const gameId = i.options.getString('id', true).trim();
    if (!validGameId(gameId)) { await reply(i, 'Ungueltige Spielidentitaet. Erwartet wird Steam64 oder ein Charname mit 3–32 Zeichen.'); return; }
    const result = await forceLink(
      prisma as unknown as LinkClient,
      { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId! },
      asUserDiscordId(target.id),
      gameId,
      config.security.encryptionKey,
    );
    if (!result.ok) { await reply(i, 'Diese Spielidentitaet ist bereits mit einem anderen Discord-Account verknuepft.'); return; }
    logAudit('LINK_FORCE_CREATED', 'ECONOMY', { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId, actor: scope.actorDiscordId, target: target.id });
    await reply(i, `<@${target.id}> wurde auf dem ausgewaehlten Gameserver verknuepft.`);
  }),
};

export const forceUnlinkCommand: Command = {
  data: slotOption(new SlashCommandBuilder()
    .setName('force-unlink')
    .setDescription('Berechtigt: Entfernt die Spielidentitaets-Verknuepfung eines Users.')
    .addUserOption(o => o.setName('user').setDescription('Discord-User').setRequired(true)) as SlashCommandBuilder),
  execute: withGuildScope({ requirePerm: 'economy.manage', acceptSlotOption: true }, async (i, scope) => {
    const target = i.options.getUser('user', true);
    const removed = await unlinkUser(
      prisma as unknown as LinkClient,
      { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId! },
      asUserDiscordId(target.id),
    );
    logAudit('LINK_FORCE_REMOVED', 'ECONOMY', { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId, actor: scope.actorDiscordId, target: target.id, removed });
    await reply(i, removed ? `<@${target.id}> wurde entkoppelt.` : 'Fuer diesen User existiert auf dem ausgewaehlten Gameserver keine aktive Verknuepfung.');
  }),
};
