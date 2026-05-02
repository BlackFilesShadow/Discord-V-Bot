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

async function hasManagePermission(btn: ButtonInteraction): Promise<boolean> {
  if (!btn.guild || !btn.guildId) return false;
  // Owner immer
  if (btn.guild.ownerId === btn.user.id) return true;
  // Discord-Permission ManageGuild (Mods/Admins)
  if (btn.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  // Subuser-Grant 'whitelist.manage' (konsistent mit Dashboard)
  try {
    const grant = await prisma.guildPermissionGrant.findUnique({
      where: { guildId_userDiscordId: { guildId: btn.guildId, userDiscordId: btn.user.id } },
    });
    const list = Array.isArray(grant?.permissions) ? (grant!.permissions as string[]) : [];
    return list.includes('whitelist.manage');
  } catch (e) {
    logger.warn(`WL-Btn: Permission-Lookup fehlgeschlagen: ${(e as Error).message}`);
    return false;
  }
}

export async function handleWhitelistApprovalButton(btn: ButtonInteraction): Promise<void> {
  const isApprove = btn.customId.startsWith('wlreq:a:');
  const requestId = btn.customId.slice('wlreq:a:'.length); // 'wlreq:a:' und 'wlreq:d:' sind beide 8 chars

  if (!(await hasManagePermission(btn))) {
    await btn.reply({ content: 'Du hast keine Berechtigung fuer Whitelist-Entscheidungen.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (!btn.guildId) {
    await btn.reply({ content: 'Diese Aktion ist nur in einem Server moeglich.', flags: MessageFlags.Ephemeral });
    return;
  }

  // guildId-Scoping STRIKT: Cross-Guild-Klick auf gleicher requestId muss fehlschlagen.
  const reqRow = await prisma.whitelistRequest.findUnique({
    where: { id: requestId, guildId: btn.guildId },
  });
  if (!reqRow) {
    await btn.reply({ content: 'Anfrage nicht gefunden (vielleicht schon entfernt).', flags: MessageFlags.Ephemeral });
    return;
  }

  await btn.deferUpdate();

  try {
    // Atomic CAS-Update: Nur wenn noch PENDING → schliesst Race-Condition
    // wenn 2 Mods gleichzeitig klicken (oder Discord-Btn + Dashboard).
    const cas = await prisma.whitelistRequest.updateMany({
      where: { id: requestId, guildId: reqRow.guildId, status: 'PENDING' },
      data: {
        status: isApprove ? 'APPROVED' : 'DENIED',
        decidedByDiscordId: btn.user.id, decidedAt: new Date(),
      },
    });
    if (cas.count !== 1) {
      await btn.followUp({ content: 'Diese Anfrage wurde bereits von jemand anderem bearbeitet.', flags: MessageFlags.Ephemeral }).catch(() => null);
      // Buttons trotzdem entfernen (Embed reflektieren lassen)
      await btn.message.edit({ components: [] }).catch(() => null);
      return;
    }

    if (isApprove) {
      // Side-Effects ausserhalb des CAS — sind idempotent (upsert + Job-Outbox)
      await prisma.whitelistEntry.upsert({
        where: { guildId_nitradoConnId_gameId: { guildId: reqRow.guildId, nitradoConnId: reqRow.nitradoConnId, gameId: reqRow.gameId } },
        update: {},
        create: {
          guildId: reqRow.guildId, nitradoConnId: reqRow.nitradoConnId, gameId: reqRow.gameId,
          source: 'REQUEST', approvedByDiscordId: btn.user.id,
        },
      });
      await prisma.nitradoJob.create({
        data: {
          guildId: reqRow.guildId, nitradoConnId: reqRow.nitradoConnId,
          operation: 'WHITELIST_ADD', payload: { gameId: reqRow.gameId },
        },
      });
      logAudit('WL_REQUEST_APPROVED', 'WHITELIST', { guildId: reqRow.guildId, requestId, gameId: reqRow.gameId, by: btn.user.id });
    } else {
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
