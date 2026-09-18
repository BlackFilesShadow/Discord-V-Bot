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
  SlashCommandBuilder, ChatInputCommandInteraction, MessageFlags,
} from 'discord.js';
import type { Command } from '../../types';
import prisma from '../../database/prisma';
import { withGuildScope } from '../middleware/withGuildScope';
import { logAudit, logger } from '../../utils/logger';
import { emitGuildEvent } from '../../dashboard/socket/emitter';
import { Colors, vEmbed } from '../../utils/embedDesign';
import { type BanClient } from '../../modules/bans/banRegistry';
import {
  ACTIVE_BAN_WHITELIST_WARNING,
  isWhitelistBlockedByActiveServerBan,
} from '../../modules/bans/whitelistBanGuard';
import {
  enqueueWhitelistAdd,
  enqueueWhitelistRemove,
  type WhitelistOutboxClient,
} from '../../modules/whitelist/whitelistOutbox';
import { isAlreadyOnRemoteWhitelist } from '../../modules/whitelist/whitelistRequestPreflight';
import {
  claimWhitelistRequest,
  type WhitelistRequestClaimClient,
} from '../../modules/whitelist/whitelistRequestClaim';
import {
  autocompleteServerAlias,
  resolveSelectedOrAllServers,
  resolveSingleServer,
  targetLabel,
} from './serverTargetSelection';

const NAME_RE = /^[^\r\n\t]{1,64}$/;
function isValidName(s: string): boolean { return NAME_RE.test(s) && s.length >= 1; }

type ReplyState = 'INFO' | 'SUCCESS' | 'ERROR';

async function reply(
  i: ChatInputCommandInteraction,
  content: string,
  ephemeral = true,
  state: ReplyState = 'INFO',
  title?: string,
): Promise<void> {
  const color = state === 'SUCCESS' ? Colors.Success : state === 'ERROR' ? Colors.Error : Colors.Info;
  const defaultTitle = state === 'SUCCESS' ? 'Erfolgreich' : state === 'ERROR' ? 'Aktion nicht moeglich' : 'Information';
  const embed = vEmbed(color)
    .setTitle(title ?? defaultTitle)
    .setDescription(content)
    .setTimestamp();
  if (ephemeral) await i.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  else await i.reply({ embeds: [embed], allowedMentions: { parse: [] } });
}

function safeLine(value: string | null | undefined, fallback = '—'): string {
  const cleaned = (value ?? '').replace(/[\r\n]+/g, ' ').replace(/`/g, "'").trim();
  return cleaned || fallback;
}

function simpleWhitelistError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message === ACTIVE_BAN_WHITELIST_WARNING) return 'Der Spieler ist auf diesem Gameserver aktuell gesperrt.';
  return safeLine(message, 'Die Aktion konnte nicht durchgeführt werden.');
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
    if (!isValidName(id)) { await reply(i, 'Ungueltiger Name (1-64 Zeichen).', true, 'ERROR'); return; }

    const target = await resolveSingleServer(i, scope.guildId);
    if (!target) return;

    const settings = await prisma.serverSettings.findUnique({
      where: { guildId_nitradoConnId: { guildId: scope.guildId, nitradoConnId: target.id } },
    });
    if (!settings?.whitelistActive) {
      await reply(i, `Das Whitelist-System ist fuer **${targetLabel(target)}** deaktiviert.`, true, 'ERROR');
      return;
    }
    if (!settings.whitelistChannelId || !settings.whitelistRequestChannelId) {
      await reply(i, 'Whitelist-System ist noch nicht vollstaendig eingerichtet. Bitte einen Admin um Konfiguration der Kanaele.', true, 'ERROR');
      return;
    }
    if (i.channelId !== settings.whitelistChannelId) {
      await reply(i, `Whitelist-Anfragen sind fuer **${targetLabel(target)}** ausschliesslich in <#${settings.whitelistChannelId}> erlaubt.`, true, 'ERROR');
      return;
    }

    if (await isWhitelistBlockedByActiveServerBan(
      prisma as unknown as BanClient,
      { guildId: scope.guildId, nitradoConnId: target.id },
      id,
    )) {
      await reply(
        i,
        'Dieser Spieler ist auf diesem Gameserver aktuell gesperrt und kann deshalb nicht zur Whitelist hinzugefügt werden.',
        true,
        'ERROR',
        'Whitelist nicht möglich',
      );
      return;
    }

    const existing = await prisma.whitelistEntry.findFirst({
      where: {
        guildId: scope.guildId,
        nitradoConnId: target.id,
        gameId: { equals: id, mode: 'insensitive' },
      },
    });
    if (existing && existing.syncState !== 'PENDING_REMOVE') {
      await reply(
        i,
        `**${id}** ist auf **${targetLabel(target)}** bereits für die Whitelist freigeschaltet. Ein neuer Antrag ist nicht erforderlich.`,
        true,
        'INFO',
        'Bereits auf der Whitelist',
      );
      return;
    }

    const openSame = await prisma.whitelistRequest.findFirst({
      where: {
        guildId: scope.guildId,
        nitradoConnId: target.id,
        gameId: { equals: id, mode: 'insensitive' },
        status: 'PENDING',
      },
    });
    if (openSame) {
      const createdAt = Math.floor(openSame.createdAt.getTime() / 1000);
      await reply(
        i,
        `Für **${id}** besteht auf **${targetLabel(target)}** bereits ein offener Whitelist-Antrag.\n\nErstellt: <t:${createdAt}:f> · <t:${createdAt}:R>`,
        true,
        'INFO',
        'Whitelist-Antrag bereits vorhanden',
      );
      return;
    }

    let remoteAlreadyWhitelisted: boolean;
    try {
      remoteAlreadyWhitelisted = await isAlreadyOnRemoteWhitelist(
        { guildId: scope.guildId, nitradoConnId: target.id },
        id,
      );
    } catch (error) {
      logger.warn(`Whitelist-Antrag Remote-Preflight fehlgeschlagen (${scope.guildId}/${target.id}/${id}): ${(error as Error).message}`);
      await reply(
        i,
        `Der aktuelle Whitelist-Status auf **${targetLabel(target)}** konnte gerade nicht sicher geprüft werden. Es wurde kein Antrag erstellt. Bitte versuche es erneut.`,
        true,
        'ERROR',
        'Whitelist-Status nicht prüfbar',
      );
      return;
    }

    if (remoteAlreadyWhitelisted) {
      await reply(
        i,
        `**${id}** ist auf **${targetLabel(target)}** bereits für die Whitelist freigeschaltet. Ein neuer Antrag ist nicht erforderlich.`,
        true,
        'INFO',
        'Bereits auf der Whitelist',
      );
      return;
    }

    if (existing?.syncState === 'PENDING_REMOVE') {
      // Bestehende Semantik beibehalten: Ist der Name nach dem frischen Remote-
      // Preflight nicht mehr auf Nitrado vorhanden, darf die neue Anfrage den
      // alten Remove-Intent ersetzen. Ein noch laufender Remove-Job wird dadurch
      // zum No-op. Bei remote weiterhin vorhanden wurde oben bereits abgebrochen.
      await prisma.whitelistEntry.deleteMany({
        where: {
          id: existing.id,
          guildId: scope.guildId,
          nitradoConnId: target.id,
          syncState: 'PENDING_REMOVE',
        },
      });
    }

    const MAX_REQUESTS_PER_USER = 8;
    const claim = await claimWhitelistRequest(
      prisma as unknown as WhitelistRequestClaimClient,
      {
        scope: { guildId: scope.guildId, nitradoConnId: target.id },
        gameId: id,
        channelId: settings.whitelistRequestChannelId,
        requesterDiscordId: scope.actorDiscordId,
        maxActivePerUser: MAX_REQUESTS_PER_USER,
      },
    );

    if (claim.kind === 'ALREADY_PENDING') {
      const createdAt = Math.floor(claim.createdAt.getTime() / 1000);
      await reply(
        i,
        `Für **${id}** besteht auf **${targetLabel(target)}** bereits ein offener Whitelist-Antrag.\n\nErstellt: <t:${createdAt}:f> · <t:${createdAt}:R>`,
        true,
        'INFO',
        'Whitelist-Antrag bereits vorhanden',
      );
      return;
    }
    if (claim.kind === 'LIMIT_REACHED') {
      await reply(i, `Du hast auf diesem Server bereits ${claim.activeCount} aktive Whitelist-Einträge oder Anfragen (Maximum: ${MAX_REQUESTS_PER_USER}).`, true, 'ERROR');
      return;
    }
    const created = claim.request;

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
      await reply(i, 'Der Whitelist-Kanal ist aktuell nicht erreichbar. Bitte wende dich an einen Administrator.', true, 'ERROR');
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

    const ack = vEmbed(Colors.Info)
      .setTitle('Whitelist-Anfrage gestellt')
      .setDescription('Deine Anfrage wurde erfolgreich an das Server-Team weitergeleitet.\n\nDu wirst informiert, sobald dein Antrag bearbeitet wurde.')
      .addFields(
        { name: 'Server', value: targetLabel(target), inline: false },
        { name: 'Beantragter Spielername', value: `\`${id}\``, inline: false },
      )
      .setFooter({ text: 'V-Bot • Whitelist' })
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
    if (!isValidName(id)) { await reply(i, 'Ungueltiger Name (1-64 Zeichen).', true, 'ERROR'); return; }

    const targets = await resolveSelectedOrAllServers(i, scope.guildId);
    if (!targets) return;

    const results: string[] = [];
    let failures = 0;
    for (const target of targets) {
      try {
        await prisma.$transaction(async tx => {
          if (await isWhitelistBlockedByActiveServerBan(
            tx as unknown as BanClient,
            { guildId: scope.guildId, nitradoConnId: target.id },
            id,
          )) {
            throw new Error(ACTIVE_BAN_WHITELIST_WARNING);
          }
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
          await enqueueWhitelistAdd(
            tx as unknown as WhitelistOutboxClient,
            { guildId: scope.guildId, nitradoConnId: target.id },
            id,
          );
        });
        logAudit('WL_ADD', 'WHITELIST', { guildId: scope.guildId, slotId: target.id, slot: target.slot, alias: target.alias, actor: scope.actorDiscordId });
        results.push(`✅ ${targetLabel(target)}`);
      } catch (error) {
        failures++;
        results.push(`❌ ${targetLabel(target)} — ${simpleWhitelistError(error)}`);
      }
    }

    emitGuildEvent(scope.guildId, { type: 'whitelist.changed', payload: { guildId: scope.guildId, action: 'added' } });
    const description = targets.length === 1 && failures === 0
      ? `Der Spieler **${id}** wurde zur Whitelist hinzugefügt.\n\n**Server**\n${targetLabel(targets[0])}`
      : failures === targets.length
        ? `Der Spieler **${id}** konnte nicht zur Whitelist hinzugefügt werden.\n\n${results.join('\n')}`
        : `Der Spieler **${id}** wurde auf folgenden Servern freigeschaltet:\n\n${results.join('\n')}`;
    await reply(
      i,
      description,
      true,
      failures === 0 ? 'SUCCESS' : failures === targets.length ? 'ERROR' : 'INFO',
      'Whitelist aktualisiert',
    );
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
    if (!isValidName(id)) { await reply(i, 'Ungueltiger Name (1-64 Zeichen).', true, 'ERROR'); return; }

    const targets = await resolveSelectedOrAllServers(i, scope.guildId);
    if (!targets) return;

    const results: string[] = [];
    let failures = 0;
    let untracked = 0;
    for (const target of targets) {
      try {
        const hadLocalEntry = await prisma.$transaction(async tx => {
          // Lokalen Spiegel NICHT sofort loeschen. PENDING_REMOVE verhindert,
          // dass ein Remote-Fehler lokal bereits als erfolgreicher Remove gilt.
          // Der Whitelist-Reconciler loescht die Zeile erst nach einem frischen
          // Nitrado-Read, der die Abwesenheit bestaetigt.
          const entryUpdate = await tx.whitelistEntry.updateMany({
            where: { guildId: scope.guildId, nitradoConnId: target.id, gameId: id },
            data: { syncState: 'PENDING_REMOVE', lastSyncedAt: null },
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
          await enqueueWhitelistRemove(
            tx as unknown as WhitelistOutboxClient,
            { guildId: scope.guildId, nitradoConnId: target.id },
            id,
          );
          return entryUpdate.count > 0;
        });
        logAudit('WL_REMOVE', 'WHITELIST', { guildId: scope.guildId, slotId: target.id, slot: target.slot, alias: target.alias, actor: scope.actorDiscordId, hadLocalEntry });
        if (hadLocalEntry) {
          results.push(`✅ ${targetLabel(target)}`);
        } else {
          untracked++;
          results.push(`⚠️ ${targetLabel(target)} — Spieler nicht eindeutig in der Whitelist gefunden.`);
        }
      } catch (error) {
        failures++;
        results.push(`❌ ${targetLabel(target)} — ${simpleWhitelistError(error)}`);
      }
    }

    emitGuildEvent(scope.guildId, { type: 'whitelist.changed', payload: { guildId: scope.guildId, action: 'remove_pending' } });

    if (targets.length === 1 && untracked === 1 && failures === 0) {
      await reply(
        i,
        `Der Spieler **${id}** konnte auf **${targetLabel(targets[0])}** nicht eindeutig in der Whitelist gefunden werden.\n\nBitte überprüfe die Schreibweise oder kontrolliere den Eintrag direkt beim Gameserver.`,
        true,
        'INFO',
        'Spieler nicht gefunden',
      );
      return;
    }

    const description = targets.length === 1 && failures === 0 && untracked === 0
      ? `Der Spieler **${id}** wurde von der Whitelist entfernt.\n\n**Server**\n${targetLabel(targets[0])}`
      : failures === targets.length
        ? `Der Spieler **${id}** konnte nicht von der Whitelist entfernt werden.\n\n${results.join('\n')}`
        : `Der Spieler **${id}** wurde auf folgenden Servern von der Whitelist entfernt:\n\n${results.join('\n')}`;

    await reply(
      i,
      description,
      true,
      failures === targets.length ? 'ERROR' : failures > 0 || untracked > 0 ? 'INFO' : 'SUCCESS',
      'Whitelist aktualisiert',
    );
  }),
};
