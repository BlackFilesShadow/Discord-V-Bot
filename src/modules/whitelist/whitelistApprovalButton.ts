/**
 * Button-Handler fuer die Whitelist-Approval-Embeds (Accept/Deny).
 * CustomId-Format: `wlreq:a:<requestId>` / `wlreq:d:<requestId>`
 */

import {
  EmbedBuilder, MessageFlags,
  PermissionFlagsBits, type ButtonInteraction,
} from 'discord.js';
import prisma from '../../database/prisma';
import { logger, logAudit } from '../../utils/logger';
import { emitGuildEvent } from '../../dashboard/socket/emitter';
import { notifyRequesterDecision, postDecisionLog } from './whitelistChannels';

function hasManagePermission(btn: ButtonInteraction): boolean {
  const member = btn.member;
  if (!member || !btn.guild) return false;
  // Owner immer
  if (btn.guild.ownerId === btn.user.id) return true;
  // Discord-Permission ManageGuild reicht (Mods/Admins)
  const perms = btn.memberPermissions;
  return Boolean(perms?.has(PermissionFlagsBits.ManageGuild));
}

export async function handleWhitelistApprovalButton(btn: ButtonInteraction): Promise<void> {
  const isApprove = btn.customId.startsWith('wlreq:a:');
  const requestId = btn.customId.slice('wlreq:a:'.length); // 'wlreq:a:' und 'wlreq:d:' sind beide 8 chars

  if (!hasManagePermission(btn)) {
    await btn.reply({ content: 'Du hast keine Berechtigung fuer Whitelist-Entscheidungen.', flags: MessageFlags.Ephemeral });
    return;
  }

  const reqRow = await prisma.whitelistRequest.findUnique({ where: { id: requestId } });
  if (!reqRow) {
    await btn.reply({ content: 'Anfrage nicht gefunden (vielleicht schon entfernt).', flags: MessageFlags.Ephemeral });
    return;
  }
  if (reqRow.status !== 'PENDING') {
    await btn.reply({ content: `Diese Anfrage wurde bereits bearbeitet (Status: ${reqRow.status}).`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (btn.guildId !== reqRow.guildId) {
    await btn.reply({ content: 'Anfrage gehoert nicht zu dieser Guild.', flags: MessageFlags.Ephemeral });
    return;
  }

  await btn.deferUpdate();

  try {
    if (isApprove) {
      await prisma.$transaction(async tx => {
        await tx.whitelistRequest.update({
          where: { id: requestId },
          data: { status: 'APPROVED', decidedByDiscordId: btn.user.id, decidedAt: new Date() },
        });
        await tx.whitelistEntry.upsert({
          where: { guildId_nitradoConnId_gameId: { guildId: reqRow.guildId, nitradoConnId: reqRow.nitradoConnId, gameId: reqRow.gameId } },
          update: {},
          create: {
            guildId: reqRow.guildId, nitradoConnId: reqRow.nitradoConnId, gameId: reqRow.gameId,
            source: 'REQUEST', approvedByDiscordId: btn.user.id,
          },
        });
        await tx.nitradoJob.create({
          data: {
            guildId: reqRow.guildId, nitradoConnId: reqRow.nitradoConnId,
            operation: 'WHITELIST_ADD', payload: { gameId: reqRow.gameId },
          },
        });
      });
      logAudit('WL_REQUEST_APPROVED', 'WHITELIST', { guildId: reqRow.guildId, requestId, gameId: reqRow.gameId, by: btn.user.id });
    } else {
      await prisma.whitelistRequest.update({
        where: { id: requestId },
        data: { status: 'DENIED', decidedByDiscordId: btn.user.id, decidedAt: new Date() },
      });
      logAudit('WL_REQUEST_DENIED', 'WHITELIST', { guildId: reqRow.guildId, requestId, gameId: reqRow.gameId, by: btn.user.id });
    }

    // Original-Embed aktualisieren (Buttons entfernen, Status setzen)
    const finalEmbed = EmbedBuilder.from(btn.message.embeds[0] ?? new EmbedBuilder())
      .setColor(isApprove ? 0x57F287 : 0xED4245)
      .setTitle(isApprove ? 'Whitelist-Antrag angenommen' : 'Whitelist-Antrag abgelehnt')
      .addFields({ name: isApprove ? 'Angenommen von' : 'Abgelehnt von', value: `<@${btn.user.id}>` });
    await btn.message.edit({ embeds: [finalEmbed], components: [] }).catch(() => null);

    // User benachrichtigen + Decision-Log posten
    await Promise.allSettled([
      notifyRequesterDecision({
        requesterDiscordId: reqRow.requesterDiscordId,
        gameId: reqRow.gameId,
        approved: isApprove,
      }),
      postDecisionLog({
        guildId: reqRow.guildId, nitradoConnId: reqRow.nitradoConnId, approved: isApprove,
        requesterDiscordId: reqRow.requesterDiscordId, gameId: reqRow.gameId,
        decidedByDiscordId: btn.user.id,
      }),
    ]);

    emitGuildEvent(reqRow.guildId, { type: 'whitelist.changed', payload: { guildId: reqRow.guildId, action: isApprove ? 'added' : 'decided', entryId: requestId } });

    // Stille Bestaetigung an den Mod (optional, ephemeral)
    await btn.followUp({ content: isApprove ? 'Antrag angenommen.' : 'Antrag abgelehnt.', flags: MessageFlags.Ephemeral }).catch(() => null);
  } catch (e) {
    logger.error('Whitelist-Button: Fehler', e as Error);
    await btn.followUp({ content: 'Fehler bei der Verarbeitung.', flags: MessageFlags.Ephemeral }).catch(() => null);
  }
}
