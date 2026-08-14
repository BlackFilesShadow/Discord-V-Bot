/**
 * Whitelist-Commands mit Alias-basierter Serverauswahl.
 *
 * - /whitelist: Member-Antrag fuer genau einen Server. Bei mehreren Servern ist
 *   die Alias-Auswahl erforderlich, weil Approval-Kanaele serverspezifisch sind.
 * - /wl-add, /wl-remove, /wl-list: optionaler Server-Alias; ohne Auswahl gilt
 *   die Aktion fuer ALLE aktiven verknuepften Gameserver der Guild.
 * - /wl-list liest die echte Nitrado-Whitelist und zeigt jeden Server separat.
 */

import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, MessageFlags,
} from 'discord.js';
import type { Command } from '../../types';
import prisma from '../../database/prisma';
import { withGuildScope } from '../middleware/withGuildScope';
import { logAudit } from '../../utils/logger';
import { emitGuildEvent } from '../../dashboard/socket/emitter';
import { config } from '../../config';
import { decrypt } from '../../utils/security';
import { NitradoClient } from '../../modules/nitrado/nitradoClient';
import {
  autocompleteServerAlias,
  resolveSelectedOrAllServers,
  resolveSingleServer,
  targetLabel,
  type CommandServerTarget,
} from './serverTargetSelection';

const NAME_RE = /^[^\r\n\t]{1,64}$/;
const LIST_PAGE_SIZE = 25;
function isValidName(s: string): boolean { return NAME_RE.test(s) && s.length >= 1; }

async function reply(i: ChatInputCommandInteraction, content: string, ephemeral = true): Promise<void> {
  if (ephemeral) await i.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  else await i.reply({ content, allowedMentions: { parse: [] } });
}

function safeLine(value: string | null | undefined, fallback = '—'): string {
  const cleaned = (value ?? '').replace(/[\r\n]+/g, ' ').replace(/`/g, "'").trim();
  return cleaned || fallback;
}

function clientForTarget(target: CommandServerTarget): NitradoClient {
  const token = decrypt(target.encryptedToken, config.security.encryptionKey);
  return new NitradoClient(token);
}

async function replyEmbeds(i: ChatInputCommandInteraction, embeds: EmbedBuilder[]): Promise<void> {
  const chunks: EmbedBuilder[][] = [];
  for (let idx = 0; idx < embeds.length; idx += 10) chunks.push(embeds.slice(idx, idx + 10));
  const first = chunks.shift() ?? [];
  await i.reply({ embeds: first, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  for (const chunk of chunks) {
    await i.followUp({ embeds: chunk, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  }
}

// ============================================================
// /whitelist — Member stellt Anfrage fuer genau einen Alias
// ============================================================
export const whitelistCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('whitelist')
    .setDescription('Stellt eine Whitelist-Anfrage fuer deinen Spielernamen.')
    .addStringOption(o => o.setName('id').setDescription('Spielername (1-64 Zeichen)').setRequired(true).setMinLength(1).setMaxLength(64))
    .addStringOption(o => o.setName('slot').setDescription('Server ueber Alias auswaehlen').setRequired(false).setAutocomplete(true)) as SlashCommandBuilder,

  autocomplete: autocompleteServerAlias,

  execute: withGuildScope({ guildOnly: true }, async (i, scope) => {
    const id = i.options.getString('id', true).trim();
    if (!isValidName(id)) { await reply(i, 'Ungueltiger Name (1-64 Zeichen).'); return; }

    const target = await resolveSingleServer(i, scope.guildId);
    if (!target) return;

    const settings = await prisma.serverSettings.findUnique({
      where: { guildId_nitradoConnId: { guildId: scope.guildId, nitradoConnId: target.id } },
    });
    if (!settings?.whitelistActive) {
      await reply(i, `Das Whitelist-System ist fuer **${targetLabel(target)}** deaktiviert.`);
      return;
    }
    if (!settings.whitelistChannelId || !settings.whitelistRequestChannelId) {
      await reply(i, 'Whitelist-System ist noch nicht vollstaendig eingerichtet. Bitte einen Admin um Konfiguration der Kanaele.');
      return;
    }
    if (i.channelId !== settings.whitelistChannelId) {
      await reply(i, `Whitelist-Anfragen sind fuer **${targetLabel(target)}** ausschliesslich in <#${settings.whitelistChannelId}> erlaubt.`);
      return;
    }

    const existing = await prisma.whitelistEntry.findUnique({
      where: { guildId_nitradoConnId_gameId: { guildId: scope.guildId, nitradoConnId: target.id, gameId: id } },
    });
    if (existing) { await reply(i, 'Dieser Spielername ist auf diesem Server bereits auf der Whitelist.'); return; }

    const openSame = await prisma.whitelistRequest.findFirst({
      where: { guildId: scope.guildId, nitradoConnId: target.id, gameId: id, status: 'PENDING' },
    });
    if (openSame) { await reply(i, 'Es gibt bereits eine offene Anfrage fuer diesen Spielernamen auf diesem Server.'); return; }

    const MAX_REQUESTS_PER_USER = 8;
    const activeCount = await prisma.whitelistRequest.count({
      where: {
        guildId: scope.guildId,
        nitradoConnId: target.id,
        requesterDiscordId: scope.actorDiscordId,
        status: { in: ['PENDING', 'APPROVED'] },
      },
    });
    if (activeCount >= MAX_REQUESTS_PER_USER) {
      await reply(i, `Du hast auf diesem Server bereits ${activeCount} aktive Whitelist-Eintraege/Anfragen (Maximum: ${MAX_REQUESTS_PER_USER}).`);
      return;
    }

    const created = await prisma.whitelistRequest.create({
      data: {
        guildId: scope.guildId,
        nitradoConnId: target.id,
        channelId: settings.whitelistRequestChannelId,
        requesterDiscordId: scope.actorDiscordId,
        gameId: id,
      },
    });

    let messageId: string | null = null;
    try {
      const { postWhitelistApprovalEmbed } = await import('../../modules/whitelist/whitelistChannels.js');
      messageId = await postWhitelistApprovalEmbed({
        guildId: scope.guildId,
        nitradoConnId: target.id,
        requestId: created.id,
        requesterDiscordId: scope.actorDiscordId,
        gameId: id,
      });
    } catch { /* unten behandelt */ }

    if (!messageId) {
      await prisma.whitelistRequest.delete({ where: { id: created.id, guildId: scope.guildId } }).catch(() => null);
      await reply(i, 'Annahme-Kanal nicht erreichbar. Bitte einen Admin um Pruefung der Kanal-Konfiguration.');
      return;
    }

    logAudit('WL_REQUEST_CREATED', 'WHITELIST', {
      guildId: scope.guildId,
      slotId: target.id,
      slot: target.slot,
      alias: target.alias,
      requestId: created.id,
      requester: scope.actorDiscordId,
    });
    emitGuildEvent(scope.guildId, { type: 'whitelist.changed', payload: { guildId: scope.guildId, action: 'requested', entryId: created.id } });

    const ack = new EmbedBuilder()
      .setTitle('Whitelist-Anfrage gestellt')
      .setColor(0x5865F2)
      .setDescription(`Deine Anfrage wurde fuer **${targetLabel(target)}** an das Server-Team weitergeleitet.`)
      .addFields({ name: 'Beantragter Name', value: `\`${id}\`` })
      .setFooter({ text: `Request-ID: ${created.id}` })
      .setTimestamp(new Date());
    await i.reply({ embeds: [ack], flags: MessageFlags.Ephemeral });
  }),
};

// ============================================================
// /wl-add — Alias oder alle Server
// ============================================================
export const wlAddCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('wl-add')
    .setDescription('Fuegt einen Spielernamen auf einem Alias oder allen Servern zur Whitelist hinzu.')
    .addStringOption(o => o.setName('id').setDescription('Spielername (1-64 Zeichen)').setRequired(true).setMinLength(1).setMaxLength(64))
    .addStringOption(o => o.setName('slot').setDescription('Server-Alias; leer = ALLE verknuepften Server').setRequired(false).setAutocomplete(true)) as SlashCommandBuilder,

  autocomplete: autocompleteServerAlias,

  execute: withGuildScope({ requirePerm: 'whitelist.manage', guildOnly: true }, async (i, scope) => {
    const id = i.options.getString('id', true).trim();
    if (!isValidName(id)) { await reply(i, 'Ungueltiger Name (1-64 Zeichen).'); return; }

    const targets = await resolveSelectedOrAllServers(i, scope.guildId);
    if (!targets) return;

    const results: string[] = [];
    for (const target of targets) {
      try {
        await prisma.$transaction(async tx => {
          await tx.whitelistEntry.upsert({
            where: { guildId_nitradoConnId_gameId: { guildId: scope.guildId, nitradoConnId: target.id, gameId: id } },
            create: {
              guildId: scope.guildId,
              nitradoConnId: target.id,
              gameId: id,
              source: 'DIRECT',
              approvedByDiscordId: scope.actorDiscordId,
            },
            update: {
              source: 'DIRECT',
              approvedByDiscordId: scope.actorDiscordId,
              approvedAt: new Date(),
              syncState: 'LOCAL_ONLY',
              lastSyncedAt: null,
            },
          });
          await tx.nitradoJob.create({
            data: { guildId: scope.guildId, nitradoConnId: target.id, operation: 'WHITELIST_ADD', payload: { gameId: id } },
          });
        });
        logAudit('WL_ADD', 'WHITELIST', { guildId: scope.guildId, slotId: target.id, slot: target.slot, alias: target.alias, actor: scope.actorDiscordId });
        results.push(`✅ **${targetLabel(target)}** — Add-Sync eingereiht.`);
      } catch (error) {
        results.push(`❌ **${targetLabel(target)}** — ${safeLine(error instanceof Error ? error.message : String(error))}`);
      }
    }

    emitGuildEvent(scope.guildId, { type: 'whitelist.changed', payload: { guildId: scope.guildId, action: 'added' } });
    await reply(i, `Whitelist-Add verarbeitet:\n${results.join('\n')}`);
  }),
};

// ============================================================
// /wl-remove — Alias oder alle Server; Remote-Remove auch ohne lokale DB-Zeile
// ============================================================
export const wlRemoveCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('wl-remove')
    .setDescription('Entfernt einen Spielernamen auf einem Alias oder allen Servern von der Whitelist.')
    .addStringOption(o => o.setName('id').setDescription('Spielername (1-64 Zeichen)').setRequired(true).setMinLength(1).setMaxLength(64))
    .addStringOption(o => o.setName('slot').setDescription('Server-Alias; leer = ALLE verknuepften Server').setRequired(false).setAutocomplete(true)) as SlashCommandBuilder,

  autocomplete: autocompleteServerAlias,

  execute: withGuildScope({ requirePerm: 'whitelist.manage', guildOnly: true }, async (i, scope) => {
    const id = i.options.getString('id', true).trim();
    if (!isValidName(id)) { await reply(i, 'Ungueltiger Name (1-64 Zeichen).'); return; }

    const targets = await resolveSelectedOrAllServers(i, scope.guildId);
    if (!targets) return;

    const results: string[] = [];
    for (const target of targets) {
      try {
        await prisma.$transaction(async tx => {
          await tx.whitelistEntry.deleteMany({
            where: { guildId: scope.guildId, nitradoConnId: target.id, gameId: id },
          });
          await tx.whitelistRequest.updateMany({
            where: {
              guildId: scope.guildId,
              nitradoConnId: target.id,
              gameId: id,
              status: { in: ['PENDING', 'APPROVED'] },
            },
            data: { status: 'CANCELLED' },
          });
          // Auch ohne lokale Zeile entfernen: Nitrado kann manuelle Eintraege
          // enthalten, die der lokale Spiegel noch nicht kennt.
          await tx.nitradoJob.create({
            data: { guildId: scope.guildId, nitradoConnId: target.id, operation: 'WHITELIST_REMOVE', payload: { gameId: id } },
          });
        });
        logAudit('WL_REMOVE', 'WHITELIST', { guildId: scope.guildId, slotId: target.id, slot: target.slot, alias: target.alias, actor: scope.actorDiscordId });
        results.push(`✅ **${targetLabel(target)}** — Remove-Sync eingereiht.`);
      } catch (error) {
        results.push(`❌ **${targetLabel(target)}** — ${safeLine(error instanceof Error ? error.message : String(error))}`);
      }
    }

    emitGuildEvent(scope.guildId, { type: 'whitelist.changed', payload: { guildId: scope.guildId, action: 'removed' } });
    await reply(i, `Whitelist-Remove verarbeitet:\n${results.join('\n')}`);
  }),
};

// ============================================================
// /wl-list — echte Nitrado-Whitelist, pro Alias immer getrennt
// ============================================================
export const wlListCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('wl-list')
    .setDescription('Zeigt die echte Nitrado-Whitelist pro Server-Alias getrennt an.')
    .addStringOption(o => o.setName('slot').setDescription('Server-Alias; leer = ALLE verknuepften Server').setRequired(false).setAutocomplete(true)) as SlashCommandBuilder,

  autocomplete: autocompleteServerAlias,

  execute: withGuildScope({ requirePerm: 'whitelist.view', guildOnly: true }, async (i, scope) => {
    const targets = await resolveSelectedOrAllServers(i, scope.guildId);
    if (!targets) return;

    const embeds: EmbedBuilder[] = [];
    for (const target of targets) {
      try {
        const rows = await clientForTarget(target).getWhitelist(target.nitradoServerId);
        if (rows.length === 0) {
          embeds.push(new EmbedBuilder()
            .setTitle(`Whitelist • ${targetLabel(target)}`)
            .setDescription('_Whitelist leer_')
            .setFooter({ text: 'Quelle: Nitrado general.whitelist' })
            .setTimestamp());
          continue;
        }

        for (let offset = 0; offset < rows.length; offset += LIST_PAGE_SIZE) {
          const page = rows.slice(offset, offset + LIST_PAGE_SIZE);
          const pageNo = Math.floor(offset / LIST_PAGE_SIZE) + 1;
          const pages = Math.ceil(rows.length / LIST_PAGE_SIZE);
          const lines = page.map((row, index) => `${offset + index + 1}. \`${safeLine(row.identifier)}\``);
          embeds.push(new EmbedBuilder()
            .setTitle(`Whitelist • ${targetLabel(target)}${pages > 1 ? ` • ${pageNo}/${pages}` : ''}`)
            .setDescription(lines.join('\n'))
            .setFooter({ text: `${rows.length} Spielernamen • Quelle: Nitrado` })
            .setTimestamp());
        }
      } catch (error) {
        embeds.push(new EmbedBuilder()
          .setTitle(`Whitelist • ${targetLabel(target)}`)
          .setDescription(`❌ Nitrado-Liste konnte nicht gelesen werden: ${safeLine(error instanceof Error ? error.message : String(error))}`)
          .setTimestamp());
      }
    }

    await replyEmbeds(i, embeds);
  }),
};
