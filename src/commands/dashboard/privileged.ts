import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import type { Command } from '../../types';
import prisma from '../../database/prisma';
import { withGuildScope } from '../middleware/withGuildScope';
import { adminPay } from '../../modules/economy/repository';
import { forceLink, unlinkUser, type LinkClient } from '../../modules/linking/linkService';
import { asNitradoConnId, asUserDiscordId } from '../../types/scope';
import { MAX_GAME_SERVERS_PER_GUILD } from '../../modules/nitrado/gameServerScope';
import {
  createPendingServerAction,
  consumePendingServerAction,
  type PendingServerActionClient,
} from '../../modules/nitrado/pendingServerAction';
import { config } from '../../config';
import { logAudit } from '../../utils/logger';

const STEAM64 = /^7656\d{13}$/;
const CHARNAME = /^[A-Za-z0-9 _.\-]{3,32}$/;
const ACTIONS = {
  ADD_MONEY: 'ADD_MONEY',
  REMOVE_MONEY: 'REMOVE_MONEY',
  FORCE_LINK: 'FORCE_LINK',
  FORCE_UNLINK: 'FORCE_UNLINK',
} as const;

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

async function queueAction(
  i: ChatInputCommandInteraction,
  scope: Parameters<Parameters<typeof withGuildScope>[1]>[1],
  actionType: typeof ACTIONS[keyof typeof ACTIONS],
  payload: Record<string, unknown>,
  summary: string,
): Promise<void> {
  const action = await createPendingServerAction(prisma as unknown as PendingServerActionClient, {
    guildId: scope.guildId,
    nitradoConnId: scope.nitradoConnId!,
    actorDiscordId: scope.actorDiscordId,
    actionType,
    payload,
  });
  logAudit('PRIVILEGED_ACTION_QUEUED', 'SECURITY', {
    guildId: scope.guildId,
    nitradoConnId: scope.nitradoConnId,
    actor: scope.actorDiscordId,
    actionId: action.id,
    actionType,
  });
  await reply(i, `${summary}\n\nBestaetige innerhalb von 5 Minuten mit:\n\`/confirm-action id:${action.id}\``);
}

function payloadObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Pending-Action-Payload ist ungueltig.');
  return value as Record<string, unknown>;
}

function payloadString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Pending-Action-Feld ${key} ist ungueltig.`);
  return value;
}

/**
 * Phase 8: explizite privilegierte Commands. Die fachliche Mutation bleibt in
 * den zentralen Economy-/Linking-Services. Mutationen werden zuerst als
 * persistente PendingServerAction gespeichert und erst durch /confirm-action
 * atomar geclaimt und ausgefuehrt.
 */
export const addMoneyCommand: Command = {
  data: slotOption(new SlashCommandBuilder()
    .setName('add-money')
    .setDescription('Berechtigt: Bereitet das Hinzufuegen von Wallet-Guthaben vor.')
    .addUserOption(o => o.setName('user').setDescription('Ziel-User').setRequired(true))
    .addIntegerOption(o => o.setName('betrag').setDescription('Betrag').setRequired(true).setMinValue(1).setMaxValue(1_000_000_000))
    .addStringOption(o => o.setName('grund').setDescription('Grund (3..200)').setRequired(true).setMinLength(3).setMaxLength(200)) as SlashCommandBuilder),
  execute: withGuildScope({ requirePerm: 'economy.manage', requireSlotToggle: 'economyActive', acceptSlotOption: true }, async (i, scope) => {
    const target = i.options.getUser('user', true);
    if (target.bot) { await reply(i, 'Bots koennen kein Economy-Guthaben erhalten.'); return; }
    const amount = i.options.getInteger('betrag', true);
    const reason = i.options.getString('grund', true);
    await queueAction(i, scope, ACTIONS.ADD_MONEY, { targetUserId: target.id, amount: String(amount), reason }, `+${amount.toLocaleString('de-DE')} Coins fuer <@${target.id}> sind vorbereitet.`);
  }),
};

export const removeMoneyCommand: Command = {
  data: slotOption(new SlashCommandBuilder()
    .setName('remove-money')
    .setDescription('Berechtigt: Bereitet das Abziehen von Wallet-Guthaben vor.')
    .addUserOption(o => o.setName('user').setDescription('Ziel-User').setRequired(true))
    .addIntegerOption(o => o.setName('betrag').setDescription('Betrag').setRequired(true).setMinValue(1).setMaxValue(1_000_000_000))
    .addStringOption(o => o.setName('grund').setDescription('Grund (3..200)').setRequired(true).setMinLength(3).setMaxLength(200)) as SlashCommandBuilder),
  execute: withGuildScope({ requirePerm: 'economy.manage', requireSlotToggle: 'economyActive', acceptSlotOption: true }, async (i, scope) => {
    const target = i.options.getUser('user', true);
    if (target.bot) { await reply(i, 'Bots besitzen kein Economy-Guthaben.'); return; }
    const amount = i.options.getInteger('betrag', true);
    const reason = i.options.getString('grund', true);
    await queueAction(i, scope, ACTIONS.REMOVE_MONEY, { targetUserId: target.id, amount: String(amount), reason }, `-${amount.toLocaleString('de-DE')} Coins fuer <@${target.id}> sind vorbereitet.`);
  }),
};

export const forceLinkCommand: Command = {
  data: slotOption(new SlashCommandBuilder()
    .setName('force-link')
    .setDescription('Berechtigt: Bereitet eine erzwungene Spielidentitaets-Verknuepfung vor.')
    .addUserOption(o => o.setName('user').setDescription('Discord-User').setRequired(true))
    .addStringOption(o => o.setName('id').setDescription('Steam64 oder Charname').setRequired(true).setMaxLength(64)) as SlashCommandBuilder),
  execute: withGuildScope({ requirePerm: 'economy.manage', acceptSlotOption: true }, async (i, scope) => {
    const target = i.options.getUser('user', true);
    if (target.bot) { await reply(i, 'Bots koennen nicht mit Spielidentitaeten verknuepft werden.'); return; }
    const gameId = i.options.getString('id', true).trim();
    if (!validGameId(gameId)) { await reply(i, 'Ungueltige Spielidentitaet. Erwartet wird Steam64 oder ein Charname mit 3–32 Zeichen.'); return; }
    await queueAction(i, scope, ACTIONS.FORCE_LINK, { targetUserId: target.id, gameId }, `Force-Link fuer <@${target.id}> ist vorbereitet.`);
  }),
};

export const forceUnlinkCommand: Command = {
  data: slotOption(new SlashCommandBuilder()
    .setName('force-unlink')
    .setDescription('Berechtigt: Bereitet das Entfernen einer Spielidentitaets-Verknuepfung vor.')
    .addUserOption(o => o.setName('user').setDescription('Discord-User').setRequired(true)) as SlashCommandBuilder),
  execute: withGuildScope({ requirePerm: 'economy.manage', acceptSlotOption: true }, async (i, scope) => {
    const target = i.options.getUser('user', true);
    await queueAction(i, scope, ACTIONS.FORCE_UNLINK, { targetUserId: target.id }, `Force-Unlink fuer <@${target.id}> ist vorbereitet.`);
  }),
};

export const confirmActionCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('confirm-action')
    .setDescription('Bestaetigt eine zuvor vorbereitete privilegierte Server-Aktion.')
    .addStringOption(o => o.setName('id').setDescription('Pending-Action-ID').setRequired(true).setMinLength(36).setMaxLength(36)) as SlashCommandBuilder,
  execute: withGuildScope({ guildOnly: true, requirePerm: 'economy.manage' }, async (i, scope) => {
    const id = i.options.getString('id', true).trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      await reply(i, 'Pending-Action-ID ist ungueltig.');
      return;
    }

    const action = await consumePendingServerAction(prisma as unknown as PendingServerActionClient, {
      id,
      guildId: scope.guildId,
      actorDiscordId: scope.actorDiscordId,
    });
    if (!action) { await reply(i, 'Diese Aktion existiert nicht, ist abgelaufen oder wurde bereits verbraucht.'); return; }

    const nitradoConnId = asNitradoConnId(action.nitradoConnId);
    const payload = payloadObject(action.payload);
    const targetUserId = asUserDiscordId(payloadString(payload, 'targetUserId'));

    if (action.actionType === ACTIONS.ADD_MONEY || action.actionType === ACTIONS.REMOVE_MONEY) {
      const settings = await prisma.serverSettings.findUnique({
        where: { guildId_nitradoConnId: { guildId: scope.guildId, nitradoConnId } },
        select: { economyActive: true },
      });
      if (!settings?.economyActive) { await reply(i, 'Economy ist fuer den ausgewaehlten Gameserver deaktiviert. Aktion wurde nicht ausgefuehrt.'); return; }
      const rawAmount = payloadString(payload, 'amount');
      if (!/^\d+$/.test(rawAmount)) throw new Error('Pending-Action-Betrag ist ungueltig.');
      const amount = BigInt(rawAmount);
      if (amount <= 0n || amount > 1_000_000_000n) throw new Error('Pending-Action-Betrag ausserhalb des erlaubten Bereichs.');
      const reason = payloadString(payload, 'reason');
      if (reason.length < 3 || reason.length > 200) throw new Error('Pending-Action-Grund ist ungueltig.');
      const delta = action.actionType === ACTIONS.ADD_MONEY ? amount : -amount;
      await adminPay({ guildId: scope.guildId, nitradoConnId, targetUserId, delta, reason, actorDiscordId: scope.actorDiscordId });
      logAudit(action.actionType === ACTIONS.ADD_MONEY ? 'ECON_ADD_MONEY' : 'ECON_REMOVE_MONEY', 'ECONOMY', {
        guildId: scope.guildId, nitradoConnId, actor: scope.actorDiscordId, target: targetUserId, amount: amount.toString(), actionId: id,
      });
      await reply(i, action.actionType === ACTIONS.ADD_MONEY ? 'Guthaben wurde hinzugefuegt.' : 'Guthaben wurde abgezogen.');
      return;
    }

    if (action.actionType === ACTIONS.FORCE_LINK) {
      const gameId = payloadString(payload, 'gameId');
      if (!validGameId(gameId)) throw new Error('Pending-Action-Spielidentitaet ist ungueltig.');
      const result = await forceLink(prisma as unknown as LinkClient, { guildId: scope.guildId, nitradoConnId }, targetUserId, gameId, config.security.encryptionKey);
      if (!result.ok) { await reply(i, 'Diese Spielidentitaet ist bereits mit einem anderen Discord-Account verknuepft.'); return; }
      logAudit('LINK_FORCE_CREATED', 'ECONOMY', { guildId: scope.guildId, nitradoConnId, actor: scope.actorDiscordId, target: targetUserId, actionId: id });
      await reply(i, 'Force-Link wurde ausgefuehrt.');
      return;
    }

    if (action.actionType === ACTIONS.FORCE_UNLINK) {
      const removed = await unlinkUser(prisma as unknown as LinkClient, { guildId: scope.guildId, nitradoConnId }, targetUserId);
      logAudit('LINK_FORCE_REMOVED', 'ECONOMY', { guildId: scope.guildId, nitradoConnId, actor: scope.actorDiscordId, target: targetUserId, removed, actionId: id });
      await reply(i, removed ? 'Force-Unlink wurde ausgefuehrt.' : 'Es existierte keine aktive Verknuepfung.');
      return;
    }

    throw new Error(`Unbekannter Pending-Action-Typ: ${action.actionType}`);
  }),
};
