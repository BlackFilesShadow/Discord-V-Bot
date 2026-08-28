/**
 * Button-Handler fuer die Whitelist-Approval-Embeds (Accept/Deny/Universal).
 * CustomId-Format: `wlreq:a:<requestId>` / `wlreq:d:<requestId>` /
 * `wlreq:u:<requestId>`.
 */

import {
  EmbedBuilder, MessageFlags, type ButtonInteraction,
} from 'discord.js';
import prisma from '../../database/prisma';
import { logger, logAudit } from '../../utils/logger';
import { emitGuildEvent } from '../../dashboard/socket/emitter';
import { Colors, statusTitle } from '../../utils/embedDesign';
import { notifyRequesterDecision } from './whitelistChannels';
import { enqueueWhitelistAdd, type WhitelistOutboxClient } from './whitelistOutbox';
import { resolveDelegatedPermissionContext } from '../permissions/access';

/**
 * Whitelist-Entscheidungen folgen exakt demselben Guild-Permission-Modell wie
 * Dashboard, Socket und Slashcommands. Discord-ManageGuild allein ist bewusst
 * KEINE implizite V-Bot-Berechtigung. Direct-Grants werden dadurch automatisch
 * an die aktuelle Mitgliedschaftsepoche gebunden und Role-Grants mit aufgeloest.
 */
async function hasManagePermission(btn: ButtonInteraction): Promise<boolean> {
  if (!btn.guild || !btn.guildId) return false;
  if (btn.guild.ownerId === btn.user.id) return true;
  try {
    const delegated = await resolveDelegatedPermissionContext(btn.guild, btn.user.id);
    return !!delegated.member && delegated.permissions.has('whitelist.manage');
  } catch (e) {
    logger.warn(`WL-Btn: Permission-Aufloesung fehlgeschlagen: ${(e as Error).message}`);
    return false;
  }
}

function responseEmbed(
  state: 'SUCCESS' | 'ERROR' | 'INFO',
  title: string,
  description: string,
): EmbedBuilder {
  const color = state === 'SUCCESS' ? Colors.Success : state === 'ERROR' ? Colors.Error : 0x5865F2;
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(state === 'INFO' ? title : statusTitle(state, title))
    .setDescription(description)
    .setTimestamp();
}

async function replyEphemeral(btn: ButtonInteraction, embed: EmbedBuilder): Promise<void> {
  await btn.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
}

async function followUpEphemeral(btn: ButtonInteraction, embed: EmbedBuilder): Promise<void> {
  await btn.followUp({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }).catch(() => null);
}

/**
 * Die Anfrage soll nach einer Entscheidung nicht als permanentes Accept/Deny-
 * Embed stehen bleiben. In Discord ist delete() vorhanden; die defensive
 * Feature-Pruefung haelt aber Tests/Partials und seltene Race-Zustaende sicher.
 */
async function removeRequestMessage(btn: ButtonInteraction): Promise<void> {
  const message = btn.message as typeof btn.message & {
    delete?: () => Promise<unknown>;
    edit?: (options: { components: never[] }) => Promise<unknown>;
  };
  if (typeof message.delete === 'function') {
    try {
      await message.delete();
      return;
    } catch {
      // Best effort: falls Loeschen wegen eines Discord-Races scheitert,
      // wenigstens die Buttons unbrauchbar machen.
    }
  }
  if (typeof message.edit === 'function') {
    await message.edit({ components: [] }).catch(() => null);
  }
}

interface UniversalTargetResult {
  id: string;
  alias: string;
  slot: number;
  ok: boolean;
  error?: string;
}

async function enqueueUniversalWhitelist(args: {
  guildId: string;
  gameId: string;
  actorDiscordId: string;
  decidedAt: Date;
  targets: Array<{ id: string; alias: string; slot: number }>;
}): Promise<UniversalTargetResult[]> {
  return Promise.all(args.targets.map(async target => {
    try {
      await prisma.$transaction(async tx => {
        await tx.whitelistEntry.upsert({
          where: {
            guildId_nitradoConnId_gameId: {
              guildId: args.guildId,
              nitradoConnId: target.id,
              gameId: args.gameId,
            },
          },
          update: {
            source: 'REQUEST',
            approvedByDiscordId: args.actorDiscordId,
            approvedAt: args.decidedAt,
            syncState: 'LOCAL_ONLY',
            lastSyncedAt: null,
          },
          create: {
            guildId: args.guildId,
            nitradoConnId: target.id,
            gameId: args.gameId,
            source: 'REQUEST',
            approvedByDiscordId: args.actorDiscordId,
          },
        });
        await enqueueWhitelistAdd(
          tx as unknown as WhitelistOutboxClient,
          { guildId: args.guildId, nitradoConnId: target.id },
          args.gameId,
        );
      });
      return { ...target, ok: true };
    } catch (error) {
      return { ...target, ok: false, error: (error as Error).message };
    }
  }));
}

export async function handleWhitelistApprovalButton(btn: ButtonInteraction): Promise<void> {
  const isApprove = btn.customId.startsWith('wlreq:a:');
  const isDeny = btn.customId.startsWith('wlreq:d:');
  const isUniversal = btn.customId.startsWith('wlreq:u:');
  if (!isApprove && !isDeny && !isUniversal) {
    await replyEphemeral(btn, responseEmbed('ERROR', 'Ungueltige Aktion', 'Diese Whitelist-Aktion ist nicht gueltig.'));
    return;
  }
  const requestId = btn.customId.slice('wlreq:a:'.length);

  if (!(await hasManagePermission(btn))) {
    await replyEphemeral(btn, responseEmbed('ERROR', 'Keine Berechtigung', 'Du hast keine Berechtigung fuer Whitelist-Entscheidungen.'));
    return;
  }

  if (!btn.guildId) {
    await replyEphemeral(btn, responseEmbed('ERROR', 'Server erforderlich', 'Diese Aktion ist nur auf einem Discord-Server moeglich.'));
    return;
  }

  const reqRow = await prisma.whitelistRequest.findUnique({
    where: { id: requestId, guildId: btn.guildId },
  });
  if (!reqRow) {
    await replyEphemeral(btn, responseEmbed('ERROR', 'Anfrage nicht gefunden', 'Die Anfrage wurde entfernt oder existiert nicht mehr.'));
    return;
  }

  let universalTargets: Array<{ id: string; alias: string; slot: number }> = [];
  if (isUniversal) {
    universalTargets = await prisma.nitradoConnection.findMany({
      where: {
        guildId: reqRow.guildId,
        status: 'ACTIVE',
        nitradoServerId: { not: null },
      },
      select: { id: true, alias: true, slot: true },
      orderBy: { slot: 'asc' },
    });
    if (universalTargets.length === 0) {
      await replyEphemeral(
        btn,
        responseEmbed('ERROR', 'Keine aktiven Gameserver', 'Es ist aktuell kein aktiver, vollständig verbundener Gameserver für die Universal-Whitelist verfügbar.'),
      );
      return;
    }
  }

  await btn.deferUpdate();

  try {
    const decidedAt = new Date();

    if (isUniversal) {
      const claim = await prisma.whitelistRequest.updateMany({
        where: { id: requestId, guildId: reqRow.guildId, status: 'PENDING' },
        data: {
          status: 'APPROVED',
          decidedByDiscordId: btn.user.id,
          decidedAt,
        },
      });
      if (claim.count !== 1) {
        await followUpEphemeral(
          btn,
          responseEmbed('INFO', 'Anfrage bereits bearbeitet', 'Diese Anfrage wurde bereits von jemand anderem entschieden.'),
        );
        await removeRequestMessage(btn);
        return;
      }

      const results = await enqueueUniversalWhitelist({
        guildId: reqRow.guildId,
        gameId: reqRow.gameId,
        actorDiscordId: btn.user.id,
        decidedAt,
        targets: universalTargets,
      });
      const succeeded = results.filter(result => result.ok);
      const failed = results.filter(result => !result.ok);

      if (succeeded.length === 0) {
        await prisma.whitelistRequest.updateMany({
          where: {
            id: requestId,
            guildId: reqRow.guildId,
            status: 'APPROVED',
            decidedByDiscordId: btn.user.id,
            decidedAt,
          },
          data: {
            status: 'PENDING',
            decidedByDiscordId: null,
            decidedAt: null,
          },
        });
        logAudit('WL_REQUEST_UNIVERSAL_FAILED', 'WHITELIST', {
          guildId: reqRow.guildId,
          requestId,
          gameId: reqRow.gameId,
          by: btn.user.id,
          targets: results.map(result => ({ id: result.id, alias: result.alias, slot: result.slot, error: result.error })),
        });
        await followUpEphemeral(
          btn,
          responseEmbed('ERROR', 'Universal Whitelist fehlgeschlagen', 'Keiner der aktiven Gameserver konnte sicher eingereiht werden. Die Anfrage bleibt offen und kann erneut bearbeitet werden.'),
        );
        return;
      }

      logAudit('WL_REQUEST_UNIVERSAL_APPROVED', 'WHITELIST', {
        guildId: reqRow.guildId,
        requestId,
        gameId: reqRow.gameId,
        by: btn.user.id,
        succeeded: succeeded.map(result => ({ id: result.id, alias: result.alias, slot: result.slot })),
        failed: failed.map(result => ({ id: result.id, alias: result.alias, slot: result.slot, error: result.error })),
      });

      await removeRequestMessage(btn);
      await Promise.allSettled([
        notifyRequesterDecision({
          requesterDiscordId: reqRow.requesterDiscordId,
          gameId: reqRow.gameId,
          approved: true,
          description: failed.length === 0
            ? `Deine Universal-Whitelist wurde für alle ${succeeded.length} aktiven Gameserver zur Synchronisierung eingereiht.`
            : `Dein Antrag wurde angenommen. Die Universal-Whitelist konnte für ${succeeded.length} von ${results.length} aktiven Gameservern eingereiht werden; das Server-Team wurde über die fehlgeschlagenen Ziele informiert.`,
        }),
      ]);

      emitGuildEvent(reqRow.guildId, {
        type: 'whitelist.changed',
        payload: { guildId: reqRow.guildId, action: 'added', entryId: requestId },
      });

      const successNames = succeeded.map(result => result.alias || `Slot ${result.slot}`).join(', ');
      const failedNames = failed.map(result => result.alias || `Slot ${result.slot}`).join(', ');
      await followUpEphemeral(
        btn,
        responseEmbed(
          failed.length === 0 ? 'SUCCESS' : 'INFO',
          failed.length === 0 ? 'Universal Whitelist eingereiht' : 'Universal Whitelist teilweise eingereiht',
          failed.length === 0
            ? `Der Spieler wurde für alle ${succeeded.length} aktiven Gameserver unabhängig eingereiht: ${successNames}.`
            : `Erfolgreich (${succeeded.length}): ${successNames}.\nFehlgeschlagen (${failed.length}): ${failedNames}. Die erfolgreichen Server werden dadurch nicht blockiert.`,
        ),
      );
      return;
    }

    const claimed = await prisma.$transaction(async tx => {
      const cas = await tx.whitelistRequest.updateMany({
        where: { id: requestId, guildId: reqRow.guildId, status: 'PENDING' },
        data: {
          status: isApprove ? 'APPROVED' : 'DENIED',
          decidedByDiscordId: btn.user.id,
          decidedAt,
        },
      });
      if (cas.count !== 1) return false;

      if (isApprove) {
        await tx.whitelistEntry.upsert({
          where: {
            guildId_nitradoConnId_gameId: {
              guildId: reqRow.guildId,
              nitradoConnId: reqRow.nitradoConnId,
              gameId: reqRow.gameId,
            },
          },
          update: {
            source: 'REQUEST',
            approvedByDiscordId: btn.user.id,
            approvedAt: decidedAt,
            syncState: 'LOCAL_ONLY',
            lastSyncedAt: null,
          },
          create: {
            guildId: reqRow.guildId,
            nitradoConnId: reqRow.nitradoConnId,
            gameId: reqRow.gameId,
            source: 'REQUEST',
            approvedByDiscordId: btn.user.id,
          },
        });
        await enqueueWhitelistAdd(
          tx as unknown as WhitelistOutboxClient,
          { guildId: reqRow.guildId, nitradoConnId: reqRow.nitradoConnId },
          reqRow.gameId,
        );
      }
      return true;
    });

    if (!claimed) {
      await followUpEphemeral(
        btn,
        responseEmbed('INFO', 'Anfrage bereits bearbeitet', 'Diese Anfrage wurde bereits von jemand anderem entschieden.'),
      );
      await removeRequestMessage(btn);
      return;
    }

    if (isApprove) {
      logAudit('WL_REQUEST_APPROVED', 'WHITELIST', {
        guildId: reqRow.guildId,
        requestId,
        gameId: reqRow.gameId,
        by: btn.user.id,
      });
    } else {
      logAudit('WL_REQUEST_DENIED', 'WHITELIST', {
        guildId: reqRow.guildId,
        requestId,
        gameId: reqRow.gameId,
        by: btn.user.id,
      });
    }

    // Nach der Entscheidung bleibt kein dauerhaftes Accept/Deny-Embed im Kanal.
    // Die sichtbaren Ergebnisse sind ausschliesslich die DM an den Antragsteller
    // und die ephemere Bestaetigung fuer den entscheidenden Admin.
    await removeRequestMessage(btn);

    await Promise.allSettled([
      notifyRequesterDecision({
        requesterDiscordId: reqRow.requesterDiscordId,
        gameId: reqRow.gameId,
        approved: isApprove,
      }),
    ]);

    emitGuildEvent(reqRow.guildId, {
      type: 'whitelist.changed',
      payload: { guildId: reqRow.guildId, action: isApprove ? 'added' : 'decided', entryId: requestId },
    });

    await followUpEphemeral(
      btn,
      responseEmbed(
        isApprove ? 'SUCCESS' : 'ERROR',
        isApprove ? 'Antrag angenommen' : 'Antrag abgelehnt',
        isApprove
          ? 'Der Whitelist-Sync zu Nitrado wurde sicher eingereiht.'
          : 'Die Whitelist-Anfrage wurde abgelehnt.',
      ),
    );
  } catch (e) {
    logger.error('Whitelist-Button: Fehler', e as Error);
    await followUpEphemeral(
      btn,
      responseEmbed('ERROR', 'Verarbeitung fehlgeschlagen', 'Die Anfrage wurde nicht vollstaendig verarbeitet. Bitte erneut versuchen.'),
    );
  }
}
