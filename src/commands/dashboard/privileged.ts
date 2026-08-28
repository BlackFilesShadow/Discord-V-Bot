import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import type { Command } from '../../types';
import prisma from '../../database/prisma';
import { withGuildScope } from '../middleware/withGuildScope';
import { adminPay } from '../../modules/economy/repository';
import { applyPendingAdminMoneyAction } from '../../modules/economy/pendingAdminMoney';
import { isValidPlayerName } from '../../modules/linking/linkService';
import {
  forceAdminLinkByPlayerName,
  forceAdminUnlinkUser,
  type AdminForceLinkResult,
} from '../../modules/linking/adminForceLink';
import {
  applySuccessfulLinkEconomyEffects,
  deactivateLinkRewardState,
} from '../../modules/linking/linkRewards';
import { asNitradoConnId, asUserDiscordId } from '../../types/scope';
import { MAX_GAME_SERVERS_PER_GUILD } from '../../modules/nitrado/gameServerScope';
import {
  claimPendingServerAction,
  completePendingServerAction,
  createPendingServerAction,
  releasePendingServerActionClaim,
  type PendingServerActionClient,
} from '../../modules/nitrado/pendingServerAction';
import { config } from '../../config';
import { logAudit, logger } from '../../utils/logger';

const ACTIONS = {
  // ADD_MONEY bleibt nur fuer bereits vor dem Rollout erzeugte Pending-Actions
  // lesbar. /add-money erzeugt ab jetzt keine Zweitfreigabe mehr.
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

function forceLinkFailure(result: Extract<AdminForceLinkResult, { ok: false }>): string {
  switch (result.reason) {
    case 'INVALID_PLAYER_NAME':
      return 'Der Spielername ist ungueltig. Erwartet werden 1–64 Zeichen ohne Zeilenumbrueche.';
    case 'PLAYER_NAME_TAKEN':
    case 'IDENTITY_TAKEN':
      return 'Dieser Spielername bzw. die dazugehörige DayZ-GUID ist bereits mit einem anderen Discord-Account verknuepft.';
    case 'USER_ALREADY_LINKED':
      return 'Der Ziel-Discord-Account ist auf diesem Gameserver bereits mit einer anderen DayZ-Identitaet verknuepft.';
  }
}

export const addMoneyCommand: Command = {
  data: slotOption(new SlashCommandBuilder()
    .setName('add-money')
    .setDescription('Berechtigt: Fuegt Wallet-Guthaben sofort hinzu.')
    .addUserOption(o => o.setName('user').setDescription('Ziel-User').setRequired(true))
    .addIntegerOption(o => o.setName('betrag').setDescription('Betrag').setRequired(true).setMinValue(1).setMaxValue(1_000_000_000))
    .addStringOption(o => o.setName('grund').setDescription('Grund (3..200)').setRequired(true).setMinLength(3).setMaxLength(200)) as SlashCommandBuilder),
  execute: withGuildScope({ requirePerm: 'economy.manage', requireSlotToggle: 'economyActive', acceptSlotOption: true }, async (i, scope) => {
    const target = i.options.getUser('user', true);
    if (target.bot) { await reply(i, 'Bots koennen kein Economy-Guthaben erhalten.'); return; }
    const amount = i.options.getInteger('betrag', true);
    const reason = i.options.getString('grund', true);
    await adminPay({
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId!,
      targetUserId: asUserDiscordId(target.id),
      delta: BigInt(amount),
      reason,
      actorDiscordId: scope.actorDiscordId,
    });
    logAudit('ECON_ADD_MONEY', 'ECONOMY', {
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
      actor: scope.actorDiscordId,
      target: target.id,
      amount: String(amount),
    });
    await reply(i, `+${amount.toLocaleString('de-DE')} Coins wurden <@${target.id}> sofort gutgeschrieben.`);
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
    .setDescription('Admin: Verknuepft einen Discord-User direkt mit einem DayZ-Spielernamen.')
    .addUserOption(o => o.setName('user').setDescription('Discord-User').setRequired(true))
    .addStringOption(o => o.setName('id').setDescription('Exakter PSN-/Xbox-/DayZ-Spielername').setRequired(true).setMinLength(1).setMaxLength(64)) as SlashCommandBuilder),
  execute: withGuildScope({ requirePerm: 'economy.manage', acceptSlotOption: true }, async (i, scope) => {
    const target = i.options.getUser('user', true);
    if (target.bot) { await reply(i, 'Bots koennen nicht mit Spielidentitaeten verknuepft werden.'); return; }
    const playerName = i.options.getString('id', true).trim();
    if (!isValidPlayerName(playerName)) { await reply(i, 'Ungueltiger Spielername. Erwartet werden 1–64 Zeichen ohne Zeilenumbrueche.'); return; }
    await queueAction(
      i,
      scope,
      ACTIONS.FORCE_LINK,
      { targetUserId: target.id, playerName },
      `Force-Link von <@${target.id}> mit **${playerName}** ist vorbereitet. Als Admin-Aktion wird die normale ADM-/Session-Anwesenheits- und Spielzeitregel umgangen.`,
    );
  }),
};

export const forceUnlinkCommand: Command = {
  data: slotOption(new SlashCommandBuilder()
    .setName('force-unlink')
    .setDescription('Admin: Entfernt eine Discord ↔ DayZ-Verknuepfung direkt ohne Session-Voraussetzung.')
    .addUserOption(o => o.setName('user').setDescription('Discord-User').setRequired(true)) as SlashCommandBuilder),
  execute: withGuildScope({ requirePerm: 'economy.manage', acceptSlotOption: true }, async (i, scope) => {
    const target = i.options.getUser('user', true);
    await queueAction(i, scope, ACTIONS.FORCE_UNLINK, { targetUserId: target.id }, `Force-Unlink fuer <@${target.id}> ist vorbereitet. Die ADM-/Session-Erkennung ist fuer diese Admin-Aktion nicht erforderlich.`);
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

    const action = await claimPendingServerAction(prisma as unknown as PendingServerActionClient, {
      id,
      guildId: scope.guildId,
      actorDiscordId: scope.actorDiscordId,
    });
    if (!action) {
      await reply(i, 'Diese Aktion existiert nicht, ist abgelaufen, bereits abgeschlossen oder wird gerade verarbeitet.');
      return;
    }

    let finalized = false;
    const finish = async (content: string): Promise<void> => {
      const completed = await completePendingServerAction(prisma as unknown as PendingServerActionClient, {
        id: action.id,
        guildId: scope.guildId,
        actorDiscordId: scope.actorDiscordId,
        claimToken: action.claimToken,
      });
      if (!completed) throw new Error('Pending-Action-Claim konnte nicht finalisiert werden.');
      finalized = true;
      await reply(i, content);
    };

    try {
      const nitradoConnId = asNitradoConnId(action.nitradoConnId);
      const payload = payloadObject(action.payload);
      const targetUserId = asUserDiscordId(payloadString(payload, 'targetUserId'));

      const server = await prisma.nitradoConnection.findFirst({
        where: { id: nitradoConnId, guildId: scope.guildId },
        select: { slot: true, status: true, nitradoServerId: true },
      });
      if (!server || server.status !== 'ACTIVE' || !server.nitradoServerId || server.slot < 1 || server.slot > MAX_GAME_SERVERS_PER_GUILD) {
        await finish('Der Gameserver dieser Pending-Action ist nicht mehr aktiv oder nicht mehr als gueltiger Slot 1–4 gebunden. Aktion wurde nicht ausgefuehrt.');
        return;
      }

      if (action.actionType === ACTIONS.ADD_MONEY || action.actionType === ACTIONS.REMOVE_MONEY) {
        const settings = await prisma.serverSettings.findUnique({
          where: { guildId_nitradoConnId: { guildId: scope.guildId, nitradoConnId } },
          select: { economyActive: true },
        });
        if (!settings?.economyActive) {
          await finish('Economy ist fuer den ausgewaehlten Gameserver deaktiviert. Aktion wurde nicht ausgefuehrt.');
          return;
        }
        const rawAmount = payloadString(payload, 'amount');
        if (!/^\d+$/.test(rawAmount)) throw new Error('Pending-Action-Betrag ist ungueltig.');
        const amount = BigInt(rawAmount);
        if (amount <= 0n || amount > 1_000_000_000n) throw new Error('Pending-Action-Betrag ausserhalb des erlaubten Bereichs.');
        const reason = payloadString(payload, 'reason');
        if (reason.length < 3 || reason.length > 200) throw new Error('Pending-Action-Grund ist ungueltig.');
        const delta = action.actionType === ACTIONS.ADD_MONEY ? amount : -amount;
        const booking = await applyPendingAdminMoneyAction({
          actionId: action.id,
          guildId: scope.guildId,
          nitradoConnId,
          targetUserId,
          delta,
          reason,
          actorDiscordId: scope.actorDiscordId,
        });
        logAudit(action.actionType === ACTIONS.ADD_MONEY ? 'ECON_ADD_MONEY' : 'ECON_REMOVE_MONEY', 'ECONOMY', {
          guildId: scope.guildId,
          nitradoConnId,
          actor: scope.actorDiscordId,
          target: targetUserId,
          amount: amount.toString(),
          actionId: id,
          idempotentReplay: !booking.applied,
        });
        await finish(action.actionType === ACTIONS.ADD_MONEY ? 'Legacy-Gutschrift wurde ausgefuehrt.' : 'Guthaben wurde abgezogen.');
        return;
      }

      if (action.actionType === ACTIONS.FORCE_LINK) {
        const playerName = payloadString(payload, 'playerName');
        if (!isValidPlayerName(playerName)) throw new Error('Pending-Action-Spielername ist ungueltig.');
        const linkScope = { guildId: scope.guildId, nitradoConnId };
        const result = await forceAdminLinkByPlayerName({
          scope: linkScope,
          userDiscordId: targetUserId,
          playerName,
          secret: config.security.encryptionKey,
        });
        if (!result.ok) {
          await finish(forceLinkFailure(result));
          return;
        }

        let startBalance = { granted: false, amount: 0n };
        if (result.gameId) {
          startBalance = await applySuccessfulLinkEconomyEffects({
            scope: linkScope,
            userDiscordId: targetUserId,
            gameId: result.gameId,
            secret: config.security.encryptionKey,
            newLink: result.newIdentityBinding,
          });
        }
        logAudit('LINK_FORCE_CREATED', 'LINKING', {
          guildId: scope.guildId,
          nitradoConnId,
          actor: scope.actorDiscordId,
          target: targetUserId,
          playerName: result.playerName,
          actionId: id,
          identityResolved: Boolean(result.gameId),
          pendingIdentityResolution: result.pendingIdentityResolution,
          startBalanceGranted: startBalance.granted,
          startBalanceAmount: startBalance.amount.toString(),
          idempotentReplay: result.alreadyLinked,
        });
        const pending = result.pendingIdentityResolution
          ? ' Die Admin-Verknuepfung ist sofort aktiv; die echte DayZ-GUID und GUID-basierte Rewards werden beim ersten eindeutigen ADM-/Session-Treffer automatisch nachgezogen.'
          : '';
        await finish(`Force-Link wurde ausgefuehrt: <@${targetUserId}> ↔ **${result.playerName}**.${startBalance.granted ? ` Startguthaben: +${startBalance.amount.toLocaleString('de-DE')}.` : ''}${pending}`);
        return;
      }

      if (action.actionType === ACTIONS.FORCE_UNLINK) {
        const linkScope = { guildId: scope.guildId, nitradoConnId };
        const removed = await forceAdminUnlinkUser(linkScope, targetUserId);
        // Absichtlich auch bei removed=false: Ein Retry nach Crash zwischen
        // Link-Unlink und Reward-Deaktivierung muss den halbfertigen Zustand heilen.
        await deactivateLinkRewardState(linkScope, targetUserId);
        logAudit('LINK_FORCE_REMOVED', 'LINKING', {
          guildId: scope.guildId,
          nitradoConnId,
          actor: scope.actorDiscordId,
          target: targetUserId,
          removed,
          actionId: id,
          idempotentReplay: !removed,
        });
        await finish('Force-Unlink wurde verarbeitet. Die aktive Identitaet, ein eventueller provisional Admin-Link und die Reward-Berechtigung sind deaktiviert.');
        return;
      }

      throw new Error(`Unbekannter Pending-Action-Typ: ${action.actionType}`);
    } catch (error) {
      if (!finalized) {
        try {
          await releasePendingServerActionClaim(prisma as unknown as PendingServerActionClient, {
            id: action.id,
            guildId: scope.guildId,
            actorDiscordId: scope.actorDiscordId,
            claimToken: action.claimToken,
          });
        } catch (releaseError) {
          logger.error('Pending-Action-Claim konnte nach Fehler nicht freigegeben werden:', releaseError as Error);
        }
      }
      throw error;
    }
  }),
};
