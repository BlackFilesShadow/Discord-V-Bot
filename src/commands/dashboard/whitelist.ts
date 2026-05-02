/**
 * Phase 3 — Whitelist-Commands (4 Stueck).
 *
 * /whitelist erstellt eine Anfrage (Member). /wl-add, /wl-remove, /wl-list
 * verlangen `whitelist.manage` bzw. `whitelist.view`. Nitrado-Push
 * laeuft asynchron via `NitradoJob`-Outbox (Worker bringt es zur API).
 */

import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, MessageFlags,
} from 'discord.js';
import type { Command } from '../../types';
import prisma from '../../database/prisma';
import { withGuildScope } from '../middleware/withGuildScope';
import { logAudit } from '../../utils/logger';
import { emitGuildEvent } from '../../dashboard/socket/emitter';

// Nitrado verwaltet die Whitelist per Spielername. Wir validieren nur Form
// und Laenge — alles andere geht 1:1 an Nitrado.
const NAME_RE = /^[^\r\n\t]{1,64}$/;
function isValidName(s: string): boolean { return NAME_RE.test(s) && s.length >= 1; }

async function reply(i: ChatInputCommandInteraction, content: string, ephemeral = true): Promise<void> {
  if (ephemeral) await i.reply({ content, flags: MessageFlags.Ephemeral });
  else await i.reply({ content });
}

// ============================================================
// /whitelist — Member stellt Anfrage
// ============================================================
export const whitelistCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('whitelist')
    .setDescription('Stellt eine Whitelist-Anfrage fuer deinen Spielernamen.')
    .addStringOption(o => o.setName('id').setDescription('Spielername (1-64 Zeichen)').setRequired(true).setMinLength(1).setMaxLength(64)) as SlashCommandBuilder,
  execute: withGuildScope({ requireSlotToggle: 'whitelistActive' }, async (i, scope) => {
    const id = i.options.getString('id', true).trim();
    if (!isValidName(id)) { await reply(i, 'Ungueltiger Name (1-64 Zeichen).'); return; }

    // ----------------------------------------------------------------
    // Strikte Vorbedingung: Beide Pflicht-Kanaele MUESSEN konfiguriert
    // sein, sonst kann kein Antrag gestellt werden. Verhindert Geist-
    // Anfragen, DM-Missbrauch und Anfragen in beliebigen Kanaelen.
    // ----------------------------------------------------------------
    const settings = await prisma.serverSettings.findUnique({
      where: { guildId_nitradoConnId: { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId! } },
    });
    if (!settings?.whitelistChannelId || !settings.whitelistRequestChannelId) {
      await reply(i, 'Whitelist-System ist noch nicht vollstaendig eingerichtet. Bitte einen Admin um Konfiguration der Kanaele.');
      return;
    }
    if (i.channelId !== settings.whitelistChannelId) {
      await reply(i, `Whitelist-Anfragen sind ausschliesslich in <#${settings.whitelistChannelId}> erlaubt.`);
      return;
    }

    // Schon auf Whitelist?
    const existing = await prisma.whitelistEntry.findUnique({
      where: { guildId_nitradoConnId_gameId: { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId!, gameId: id } },
    });
    if (existing) { await reply(i, 'Diese ID ist bereits auf der Whitelist.'); return; }

    // Schon offene Anfrage fuer diese gameId?
    const openSame = await prisma.whitelistRequest.findFirst({
      where: { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId!, gameId: id, status: 'PENDING' },
    });
    if (openSame) { await reply(i, 'Es gibt bereits eine offene Anfrage fuer diese ID.'); return; }

    // Spam-Schutz: max 8 aktive Anfragen pro User (PENDING + APPROVED).
    // APPROVED zaehlt mit, damit ein Discord-Account nicht beliebig viele
    // Spielernamen sammeln kann. Wird ein Whitelist-Eintrag spaeter geloescht,
    // setzt der Loesch-Pfad die zugehoerige APPROVED-Anfrage auf CANCELLED,
    // sodass der Cap automatisch frei wird.
    const MAX_REQUESTS_PER_USER = 8;
    const activeCount = await prisma.whitelistRequest.count({
      where: {
        guildId: scope.guildId, nitradoConnId: scope.nitradoConnId!,
        requesterDiscordId: scope.actorDiscordId,
        status: { in: ['PENDING', 'APPROVED'] },
      },
    });
    if (activeCount >= MAX_REQUESTS_PER_USER) {
      await reply(i, `Du hast bereits ${activeCount} aktive Whitelist-Eintraege/Anfragen (Maximum: ${MAX_REQUESTS_PER_USER}). Bitte einen Admin um Entfernung eines bestehenden Eintrags.`);
      return;
    }

    // Embed-Post in den Request-Kanal IST Pflicht. Erst pruefen ob er
    // erreichbar ist, DANN Request anlegen, DANN Embed senden. Wenn der
    // Embed-Post am Ende doch failed, rollen wir den Request zurueck.
    const created = await prisma.whitelistRequest.create({
      data: {
        guildId: scope.guildId, nitradoConnId: scope.nitradoConnId!,
        channelId: settings.whitelistRequestChannelId, // bereits korrekt: Approval-Channel
        requesterDiscordId: scope.actorDiscordId, gameId: id,
      },
    });

    let messageId: string | null = null;
    try {
      const { postWhitelistApprovalEmbed } = await import('../../modules/whitelist/whitelistChannels.js');
      messageId = await postWhitelistApprovalEmbed({
        guildId: scope.guildId, nitradoConnId: scope.nitradoConnId!, requestId: created.id,
        requesterDiscordId: scope.actorDiscordId, gameId: id,
      });
    } catch { /* unten behandelt */ }

    if (!messageId) {
      // Rollback: Request loeschen, sonst Geist-Anfrage in DB.
      // guildId-Scoping als Defense-in-depth (id ist UUID + global eindeutig, aber Doktrin: nie ohne guildId).
      await prisma.whitelistRequest.delete({ where: { id: created.id, guildId: scope.guildId } }).catch(() => null);
      await reply(i, 'Annahme-Kanal nicht erreichbar. Bitte einen Admin um Pruefung der Kanal-Konfiguration.');
      return;
    }

    logAudit('WL_REQUEST_CREATED', 'WHITELIST', { guildId: scope.guildId, requestId: created.id, requester: scope.actorDiscordId, gameId: id });
    emitGuildEvent(scope.guildId, { type: 'whitelist.changed', payload: { guildId: scope.guildId, action: 'requested', entryId: created.id } });

    // Bestaetigung an User STRIKT in-channel ephemeral. Keine DM.
    const ack = new EmbedBuilder()
      .setTitle('Whitelist-Anfrage gestellt')
      .setColor(0x5865F2)
      .setDescription('Deine Anfrage wurde dem zustaendigen Server-Team weitergeleitet. Bitte warte auf die Entscheidung.')
      .addFields({ name: 'Beantragter Name', value: `\`${id}\`` })
      .setFooter({ text: `Request-ID: ${created.id}` })
      .setTimestamp(new Date());
    await i.reply({ embeds: [ack], flags: MessageFlags.Ephemeral });
  }),
};

// ============================================================
// /wl-add — direkter Eintrag (managed)
// ============================================================
export const wlAddCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('wl-add')
    .setDescription('Owner/Berechtigt: Fuegt einen Spielernamen direkt zur Whitelist hinzu (synced).')
    .addStringOption(o => o.setName('id').setDescription('Spielername (1-64 Zeichen)').setRequired(true).setMinLength(1).setMaxLength(64)) as SlashCommandBuilder,
  execute: withGuildScope({ requirePerm: 'whitelist.manage' }, async (i, scope) => {
    const id = i.options.getString('id', true).trim();
    if (!isValidName(id)) { await reply(i, 'Ungueltiger Name (1-64 Zeichen).'); return; }
    try {
      await prisma.$transaction(async tx => {
        await tx.whitelistEntry.create({
          data: {
            guildId: scope.guildId, nitradoConnId: scope.nitradoConnId!,
            gameId: id, source: 'DIRECT', approvedByDiscordId: scope.actorDiscordId,
          },
        });
        await tx.nitradoJob.create({
          data: { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId!, operation: 'WHITELIST_ADD', payload: { gameId: id } },
        });
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') { await reply(i, 'Bereits auf der Whitelist.'); return; }
      throw e;
    }
    logAudit('WL_ADD', 'WHITELIST', { guildId: scope.guildId, slotId: scope.nitradoConnId, gameId: id, actor: scope.actorDiscordId });
    emitGuildEvent(scope.guildId, { type: 'whitelist.changed', payload: { guildId: scope.guildId, action: 'added' } });
    await reply(i, `\`${id}\` zur Whitelist hinzugefuegt (Sync laeuft).`);
  }),
};

// ============================================================
// /wl-remove
// ============================================================
export const wlRemoveCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('wl-remove')
    .setDescription('Owner/Berechtigt: Entfernt einen Spielernamen von der Whitelist.')
    .addStringOption(o => o.setName('id').setDescription('Spielername (1-64 Zeichen)').setRequired(true).setMinLength(1).setMaxLength(64)) as SlashCommandBuilder,
  execute: withGuildScope({ requirePerm: 'whitelist.manage' }, async (i, scope) => {
    const id = i.options.getString('id', true).trim();
    if (!isValidName(id)) { await reply(i, 'Ungueltiger Name (1-64 Zeichen).'); return; }
    const result = await prisma.$transaction(async tx => {
      const out = await tx.whitelistEntry.deleteMany({
        where: { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId!, gameId: id },
      });
      if (out.count > 0) {
        await tx.nitradoJob.create({
          data: { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId!, operation: 'WHITELIST_REMOVE', payload: { gameId: id } },
        });
        // Cap-Reset: zugehoerige APPROVED-Requests auf CANCELLED setzen,
        // damit der Spam-Cap des urspruenglichen Antragstellers wieder frei wird.
        await tx.whitelistRequest.updateMany({
          where: { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId!, gameId: id, status: 'APPROVED' },
          data: { status: 'CANCELLED' },
        });
      }
      return out.count;
    });
    if (result === 0) { await reply(i, 'ID nicht in der Whitelist.'); return; }
    logAudit('WL_REMOVE', 'WHITELIST', { guildId: scope.guildId, slotId: scope.nitradoConnId, gameId: id, actor: scope.actorDiscordId });
    emitGuildEvent(scope.guildId, { type: 'whitelist.changed', payload: { guildId: scope.guildId, action: 'removed' } });
    await reply(i, `\`${id}\` entfernt (Sync laeuft).`);
  }),
};

// ============================================================
// /wl-list — listet lokale DB-Spiegel
// ============================================================
export const wlListCommand: Command = {
  data: new SlashCommandBuilder().setName('wl-list').setDescription('Owner/Berechtigt: Zeigt aktuelle Whitelist (max 50 Eintraege).'),
  execute: withGuildScope({ requirePerm: 'whitelist.view' }, async (i, scope) => {
    const rows = await prisma.whitelistEntry.findMany({
      where: { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId! },
      orderBy: { approvedAt: 'desc' },
      take: 50,
    });
    if (rows.length === 0) { await reply(i, '_Whitelist leer_'); return; }
    const lines = rows.map(r => `\`${r.gameId}\` ⟵ <@${r.approvedByDiscordId}> (${r.source})`).join('\n');
    const e = new EmbedBuilder().setTitle(`Whitelist (${rows.length})`).setDescription(lines.slice(0, 4000));
    await i.reply({ embeds: [e], flags: MessageFlags.Ephemeral });
  }),
};
