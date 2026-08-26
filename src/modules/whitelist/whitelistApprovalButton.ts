/**
 * Button-Handler fuer die Whitelist-Approval-Embeds (Accept/Deny).
 * CustomId-Format: `wlreq:a:<requestId>` / `wlreq:d:<requestId>`
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

export async function handleWhitelistApprovalButton(btn: ButtonInteraction): Promise<void> {
  const isApprove = btn.customId.startsWith('wlreq:a:');
  const isDeny = btn.customId.startsWith('wlreq:d:');
  if (!isApprove && !isDeny) {
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

  await btn.deferUpdate();

  try {
    const decidedAt = new Date();
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
