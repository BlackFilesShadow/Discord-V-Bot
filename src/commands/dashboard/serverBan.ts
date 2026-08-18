/**
 * Nitrado-Server-Bans fuer einen einzelnen Alias oder alle verknuepften Server.
 *
 * Invarianten:
 * - exakter Gameserver-Identifier reicht; kein Discord-/Bot-Link;
 * - leerer Alias = alle aktiven verknuepften Gameserver;
 * - Ban markiert einen vorhandenen lokalen Whitelist-Eintrag PENDING_REMOVE,
 *   statt ihn vor Remote-Bestaetigung zu loeschen;
 * - SERVER_BAN_ADD entfernt remote zuerst exakt denselben Identifier aus
 *   general.whitelist und schreibt erst danach die Gameserver-Banlist;
 * - `appliedRemotely` bleibt ein bestaetigter Zustand. /server-unban liest
 *   deshalb zuerst die echte Remote-Banlist und erfindet diesen Wert nie;
 * - Klartext-Identifier landen weder im ServerBanEntry noch in Audit-Logs.
 */

import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
} from 'discord.js';
import type { Command } from '../../types';
import prisma from '../../database/prisma';
import { withGuildScope } from '../middleware/withGuildScope';
import { addBan, type BanClient } from '../../modules/bans/banRegistry';
import { hashBanIdentifier, matchesBanIdentifier } from '../../modules/bans/banTarget';
import {
  enqueueServerBanAdd,
  enqueueServerBanRemove,
  type BanOutboxClient,
} from '../../modules/bans/banOutbox';
import { config } from '../../config';
import { decrypt, encrypt } from '../../utils/security';
import { logAudit } from '../../utils/logger';
import { NitradoClient } from '../../modules/nitrado/nitradoClient';
import {
  readCurrentAdmBinding,
  withFreshAdmBinding,
} from '../../modules/nitrado/adm/bindingFence';
import {
  autocompleteServerAlias,
  resolveSelectedOrAllServers,
  targetLabel,
  type CommandServerTarget,
} from './serverTargetSelection';
import { buildStatusEmbed, type EmbedStatus } from '../../utils/statusEmbed';

const MAX_BAN_MINUTES = 365 * 24 * 60;
const MAX_REASON_LENGTH = 300;
const IDENTIFIER_RE = /^[^\r\n\t]{1,128}$/;
const LIST_PAGE_SIZE = 20;

function safeLine(value: string | null | undefined, fallback = '—'): string {
  const cleaned = (value ?? '').replace(/[\r\n]+/g, ' ').replace(/`/g, "'").trim();
  return cleaned || fallback;
}

function safeErrorMessage(error: unknown, sensitiveIdentifier?: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = sensitiveIdentifier ? raw.split(sensitiveIdentifier).join('[REDACTED]') : raw;
  return safeLine(redacted, 'Unbekannter Fehler');
}

function clientForTarget(target: CommandServerTarget): NitradoClient {
  const token = decrypt(target.encryptedToken, config.security.encryptionKey);
  return new NitradoClient(token);
}

async function statusReply(
  interaction: ChatInputCommandInteraction,
  status: EmbedStatus,
  title: string,
  description: string,
): Promise<void> {
  await interaction.reply({
    embeds: [buildStatusEmbed({ status, title, description, footerText: 'V-Bot Nitrado Bans' })],
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

async function replyEmbeds(interaction: ChatInputCommandInteraction, embeds: EmbedBuilder[]): Promise<void> {
  for (let index = 0; index < embeds.length; index += 10) {
    const chunk = embeds.slice(index, index + 10);
    if (index === 0) {
      await interaction.reply({ embeds: chunk, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    } else {
      await interaction.followUp({ embeds: chunk, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    }
  }
}

export const serverBanCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('server-ban')
    .setDescription('Bannt eine Game-ID auf einem Alias oder allen verknuepften Nitrado-Servern.')
    .addStringOption(option =>
      option.setName('identifier').setDescription('Exakter Spielername / Gameserver-Identifier').setRequired(true).setMinLength(1).setMaxLength(128),
    )
    .addStringOption(option =>
      option.setName('grund').setDescription('Grund fuer den Server-Bann').setRequired(true).setMinLength(1).setMaxLength(MAX_REASON_LENGTH),
    )
    .addIntegerOption(option =>
      option.setName('dauer').setDescription('Dauer in Minuten; leer = permanent').setRequired(false).setMinValue(1).setMaxValue(MAX_BAN_MINUTES),
    )
    .addStringOption(option =>
      option.setName('slot').setDescription('Server-Alias auswaehlen; leer = ALLE verknuepften Server').setRequired(false).setAutocomplete(true),
    ) as SlashCommandBuilder,
  autocomplete: autocompleteServerAlias,

  execute: withGuildScope({ requirePerm: 'bans.manage', guildOnly: true }, async (interaction, scope) => {
    const identifier = interaction.options.getString('identifier', true).trim();
    const reason = interaction.options.getString('grund', true).trim();
    const durationMinutes = interaction.options.getInteger('dauer');
    if (!IDENTIFIER_RE.test(identifier)) {
      await statusReply(interaction, 'ERROR', 'Ungueltiger Identifier', 'Der Gameserver-Identifier darf 1-128 Zeichen und keine Zeilenumbrueche oder Tabulatoren enthalten.');
      return;
    }

    const targets = await resolveSelectedOrAllServers(interaction, scope.guildId);
    if (!targets) return;

    const identityHash = hashBanIdentifier(identifier, config.security.encryptionKey);
    const now = new Date();
    const expiresAt = durationMinutes ? new Date(now.getTime() + durationMinutes * 60_000) : null;
    const noticeIdentifierEnc = expiresAt ? encrypt(identifier, config.security.encryptionKey) : null;
    const results: string[] = [];
    let failures = 0;

    for (const target of targets) {
      const label = targetLabel(target);
      try {
        const stored = await prisma.$transaction(async tx => {
          // Nicht vor Remote-Bestaetigung loeschen. PENDING_REMOVE verhindert
          // gleichzeitig ein Re-Add durch den Whitelist-Reconciler.
          await tx.whitelistEntry.updateMany({
            where: { guildId: scope.guildId, nitradoConnId: target.id, gameId: identifier },
            data: { syncState: 'PENDING_REMOVE', lastSyncedAt: null },
          });
          await tx.whitelistRequest.updateMany({
            where: {
              guildId: scope.guildId,
              nitradoConnId: target.id,
              gameId: identifier,
              status: { in: ['PENDING', 'APPROVED'] },
            },
            data: { status: 'CANCELLED' },
          });

          const banScope = { guildId: scope.guildId, nitradoConnId: target.id };
          await addBan(
            tx as unknown as BanClient,
            banScope,
            {
              identityHash,
              reason,
              bannedByDiscordId: scope.actorDiscordId,
              expiresAt,
            },
            now,
          );

          const row = await tx.serverBanEntry.findUnique({
            where: {
              guildId_nitradoConnId_identityHash: {
                guildId: scope.guildId,
                nitradoConnId: target.id,
                identityHash,
              },
            },
            select: { id: true },
          });
          if (!row) throw new Error('Server-Ban konnte nach dem Anlegen nicht wiedergefunden werden.');

          if (expiresAt && noticeIdentifierEnc) {
            await tx.serverBanExpiryNotice.upsert({
              where: { banId: row.id },
              create: {
                banId: row.id,
                guildId: scope.guildId,
                nitradoConnId: target.id,
                channelId: interaction.channelId,
                identifierEnc: noticeIdentifierEnc,
                expiresAt,
                status: 'PENDING',
                nextAttemptAt: expiresAt,
              },
              update: {
                guildId: scope.guildId,
                nitradoConnId: target.id,
                channelId: interaction.channelId,
                identifierEnc: noticeIdentifierEnc,
                expiresAt,
                status: 'PENDING',
                attempts: 0,
                nextAttemptAt: expiresAt,
                leaseUntil: null,
                remoteRemovedAt: null,
                sentAt: null,
                messageId: null,
                lastError: null,
              },
            });
          } else {
            await tx.serverBanExpiryNotice.deleteMany({ where: { banId: row.id } });
          }

          const queued = await enqueueServerBanAdd(
            tx as unknown as BanOutboxClient,
            banScope,
            row.id,
            identifier,
            config.security.encryptionKey,
          );
          return { id: row.id, queued };
        });

        logAudit('SERVER_BAN_SET', 'MODERATION', {
          guildId: scope.guildId,
          slotId: target.id,
          slot: target.slot,
          alias: target.alias,
          actor: scope.actorDiscordId,
          banId: stored.id,
          expiresAt: expiresAt?.toISOString() ?? null,
          expiryNoticeChannelId: expiresAt ? interaction.channelId : null,
          remoteQueued: stored.queued,
          whitelistState: 'PENDING_REMOVE',
          remoteSequence: 'WHITELIST_REMOVE_THEN_BAN',
        });
        results.push(`✅ **${label}** — Whitelist-Entfernung und Bann ${stored.queued ? 'sicher eingereiht' : 'bereits in Bearbeitung'}.`);
      } catch (error) {
        failures++;
        const internalMessage = safeErrorMessage(error, identifier);
        logAudit('SERVER_BAN_SET_FAILED', 'MODERATION', {
          guildId: scope.guildId,
          slotId: target.id,
          slot: target.slot,
          alias: target.alias,
          actor: scope.actorDiscordId,
          error: internalMessage,
        });
        results.push(`❌ **${label}** — Bann konnte nicht sicher eingereiht werden.`);
      }
    }

    const scopeText = targets.length === 1 ? targetLabel(targets[0]) : `alle ${targets.length} verknuepften Server`;
    await statusReply(
      interaction,
      failures === 0 ? 'SUCCESS' : failures === targets.length ? 'ERROR' : 'INFO',
      'Server-Bann verarbeitet',
      `Ziel: **${scopeText}**\nDauer: ${expiresAt ? `<t:${Math.floor(expiresAt.getTime() / 1000)}:R>` : 'Permanent'}\n\n${results.join('\n')}`,
    );
  }),
};

export const serverUnbanCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('server-unban')
    .setDescription('Entbannt eine Game-ID auf einem Alias oder allen verknuepften Nitrado-Servern.')
    .addStringOption(option =>
      option.setName('identifier').setDescription('Exakter Spielername / Gameserver-Identifier').setRequired(true).setMinLength(1).setMaxLength(128),
    )
    .addStringOption(option =>
      option.setName('slot').setDescription('Server-Alias auswaehlen; leer = ALLE verknuepften Server').setRequired(false).setAutocomplete(true),
    ) as SlashCommandBuilder,
  autocomplete: autocompleteServerAlias,

  execute: withGuildScope({ requirePerm: 'bans.manage', guildOnly: true }, async (interaction, scope) => {
    const identifier = interaction.options.getString('identifier', true).trim();
    if (!IDENTIFIER_RE.test(identifier)) {
      await statusReply(interaction, 'ERROR', 'Ungueltiger Identifier', 'Der Gameserver-Identifier darf 1-128 Zeichen und keine Zeilenumbrueche oder Tabulatoren enthalten.');
      return;
    }

    const targets = await resolveSelectedOrAllServers(interaction, scope.guildId);
    if (!targets) return;

    const identityHash = hashBanIdentifier(identifier, config.security.encryptionKey);
    const now = new Date();
    const results: string[] = [];
    let failures = 0;

    for (const target of targets) {
      const label = targetLabel(target);
      try {
        // Nitrado-1Q: Der Alias-Snapshot aus der Command-Aufloesung ist nur
        // Zielauswahl. Token + Service werden unter dem kanonischen kurzen
        // Connection-Lock frisch gelesen. Remote-I/O findet ohne Lock statt.
        const binding = await readCurrentAdmBinding({ id: target.id, guildId: scope.guildId });
        if (!binding) {
          throw new Error('Nitrado-Bindung ist nicht mehr ACTIVE oder besitzt keine Service-ID.');
        }
        const token = decrypt(binding.encryptedToken, config.security.encryptionKey);
        const remoteRows = await new NitradoClient(token).getBanlist(binding.nitradoServerId);
        const existsRemotely = remoteRows.some(row =>
          matchesBanIdentifier(row.identifier, identityHash, config.security.encryptionKey),
        );

        // Erst wenn exakt dieselbe ACTIVE Token-/Service-/Binding-Version noch
        // gueltig ist, darf die Remote-Beobachtung lokalen Ban-Zustand oder eine
        // Remove-Outbox beeinflussen. Der DB-Commit liegt dabei unter dem Lock.
        const result = await withFreshAdmBinding(binding, () => prisma.$transaction(async tx => {
          const row = await tx.serverBanEntry.upsert({
            where: {
              guildId_nitradoConnId_identityHash: {
                guildId: scope.guildId,
                nitradoConnId: target.id,
                identityHash,
              },
            },
            create: {
              guildId: scope.guildId,
              nitradoConnId: target.id,
              identityHash,
              reason: 'Remote-Unban-Reconcile',
              bannedByDiscordId: scope.actorDiscordId,
              bannedAt: now,
              active: false,
              appliedRemotely: existsRemotely,
              liftedAt: now,
            },
            update: {
              active: false,
              appliedRemotely: existsRemotely,
              liftedAt: now,
            },
            select: { id: true },
          });

          await tx.serverBanExpiryNotice.updateMany({
            where: {
              banId: row.id,
              guildId: scope.guildId,
              nitradoConnId: target.id,
              status: { in: ['PENDING', 'READY', 'SENDING', 'FAILED'] },
            },
            data: {
              status: 'CANCELLED',
              identifierEnc: null,
              leaseUntil: null,
              lastError: null,
            },
          });

          const queued = existsRemotely
            ? await enqueueServerBanRemove(
                tx as unknown as BanOutboxClient,
                { guildId: scope.guildId, nitradoConnId: target.id },
                row.id,
                { bypassRecentDeadCooldown: true },
              )
            : false;
          return { banId: row.id, existsRemotely, queued };
        }));

        logAudit('SERVER_BAN_LIFT', 'MODERATION', {
          guildId: scope.guildId,
          slotId: target.id,
          slot: target.slot,
          alias: target.alias,
          actor: scope.actorDiscordId,
          banId: result.banId,
          remoteObserved: result.existsRemotely,
          remoteQueued: result.queued,
          directIdentifier: true,
          automaticExpiryNotice: false,
        });

        results.push(result.existsRemotely
          ? `✅ **${label}** — Remote-Ban bestaetigt; Unban ${result.queued ? 'eingereiht' : 'bereits in Bearbeitung'}.`
          : `✅ **${label}** — Identifier ist remote bereits nicht gebannt; lokaler Zustand bestaetigt.`);
      } catch (error) {
        failures++;
        const internalMessage = safeErrorMessage(error, identifier);
        logAudit('SERVER_BAN_LIFT_FAILED', 'MODERATION', {
          guildId: scope.guildId,
          slotId: target.id,
          slot: target.slot,
          alias: target.alias,
          actor: scope.actorDiscordId,
          error: internalMessage,
        });
        results.push(`❌ **${label}** — Remote-Zustand konnte nicht sicher geprueft; kein falscher lokaler Endzustand geschrieben.`);
      }
    }

    const scopeText = targets.length === 1 ? targetLabel(targets[0]) : `alle ${targets.length} verknuepften Server`;
    await statusReply(
      interaction,
      failures === 0 ? 'SUCCESS' : failures === targets.length ? 'ERROR' : 'INFO',
      'Server-Unban verarbeitet',
      `Ziel: **${scopeText}**\n\n${results.join('\n')}`,
    );
  }),
};

export const serverBanListCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('server-ban-list')
    .setDescription('Zeigt die Nitrado-Banlist pro Server-Alias getrennt an.')
    .addStringOption(option =>
      option.setName('slot').setDescription('Server-Alias auswaehlen; leer = ALLE verknuepften Server').setRequired(false).setAutocomplete(true),
    ) as SlashCommandBuilder,
  autocomplete: autocompleteServerAlias,

  execute: withGuildScope({ requirePerm: 'bans.view', guildOnly: true }, async (interaction, scope) => {
    const targets = await resolveSelectedOrAllServers(interaction, scope.guildId);
    if (!targets) return;

    const embeds: EmbedBuilder[] = [];
    for (const target of targets) {
      try {
        const rows = await clientForTarget(target).getBanlist(target.nitradoServerId);
        if (rows.length === 0) {
          embeds.push(new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle(`Banlist • ${targetLabel(target)}`)
            .setDescription('_Banlist leer_')
            .setFooter({ text: 'Quelle: Nitrado Gameserver Banlist' })
            .setTimestamp());
          continue;
        }

        for (let offset = 0; offset < rows.length; offset += LIST_PAGE_SIZE) {
          const page = rows.slice(offset, offset + LIST_PAGE_SIZE);
          const pageNo = Math.floor(offset / LIST_PAGE_SIZE) + 1;
          const pages = Math.ceil(rows.length / LIST_PAGE_SIZE);
          const lines = page.map((row, index) => {
            const added = row.added_at ? ` • seit ${safeLine(row.added_at)}` : '';
            return `${offset + index + 1}. \`${safeLine(row.identifier)}\`${added}`;
          });
          embeds.push(new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle(`Banlist • ${targetLabel(target)}${pages > 1 ? ` • ${pageNo}/${pages}` : ''}`)
            .setDescription(lines.join('\n').slice(0, 4096))
            .setFooter({ text: `${rows.length} Eintraege • Quelle: Nitrado` })
            .setTimestamp());
        }
      } catch (error) {
        const internalMessage = safeErrorMessage(error);
        logAudit('SERVER_BAN_LIST_READ_FAILED', 'MODERATION', {
          guildId: scope.guildId,
          slotId: target.id,
          slot: target.slot,
          alias: target.alias,
          actor: scope.actorDiscordId,
          error: internalMessage,
        });
        embeds.push(new EmbedBuilder()
          .setColor(0xED4245)
          .setTitle(`Banlist • ${targetLabel(target)}`)
          .setDescription('❌ Die Nitrado-Banlist konnte fuer diesen Server nicht sicher gelesen werden.')
          .setTimestamp());
      }
    }

    await replyEmbeds(interaction, embeds);
  }),
};