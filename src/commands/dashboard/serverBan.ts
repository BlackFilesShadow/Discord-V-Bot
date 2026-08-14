/**
 * Nitrado-Server-Bans fuer einen einzelnen Alias oder alle verknuepften Server.
 *
 * Fachliche Invarianten:
 * - Der exakte Gameserver-Identifier ist ausreichend; kein Discord-/Bot-Link.
 * - Ohne `slot`-Auswahl gilt Ban/Unban/List fuer alle aktiven verknuepften
 *   Gameserver der Guild.
 * - `slot` ist eine Alias-Autocomplete-Auswahl; intern wird die stabile
 *   NitradoConnection-ID uebertragen.
 * - Beim Ban werden lokaler Whitelist-Desired-State, lokale Ban-Wahrheit und
 *   Ban-Outbox atomar geschrieben. Der SERVER_BAN_ADD-Worker entfernt danach
 *   unter dem per-Connection-Lock zuerst die echte Nitrado-Whitelist und setzt
 *   erst anschliessend die Banlist.
 * - Klartext-Identifier werden nicht in ServerBanEntry oder Audit-Logs gespeichert.
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
import { hashBanIdentifier } from '../../modules/bans/banTarget';
import {
  enqueueServerBanAdd,
  enqueueServerBanRemove,
  type BanOutboxClient,
} from '../../modules/bans/banOutbox';
import { config } from '../../config';
import { decrypt } from '../../utils/security';
import { logAudit } from '../../utils/logger';
import { NitradoClient } from '../../modules/nitrado/nitradoClient';
import {
  autocompleteServerAlias,
  resolveSelectedOrAllServers,
  targetLabel,
  type CommandServerTarget,
} from './serverTargetSelection';

const MAX_BAN_MINUTES = 365 * 24 * 60;
const MAX_REASON_LENGTH = 300;
const IDENTIFIER_RE = /^[^\r\n\t]{1,128}$/;
const LIST_PAGE_SIZE = 25;

async function reply(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
  await interaction.reply({
    content,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

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

async function replyEmbeds(interaction: ChatInputCommandInteraction, embeds: EmbedBuilder[]): Promise<void> {
  const chunks: EmbedBuilder[][] = [];
  for (let i = 0; i < embeds.length; i += 10) chunks.push(embeds.slice(i, i + 10));
  const first = chunks.shift() ?? [];
  await interaction.reply({
    embeds: first,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
  for (const chunk of chunks) {
    await interaction.followUp({
      embeds: chunk,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  }
}

// ============================================================
// /server-ban — Identifier reicht; optional Alias, leer = alle Server
// ============================================================
export const serverBanCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('server-ban')
    .setDescription('Bannt eine Game-ID auf einem Alias oder allen verknuepften Nitrado-Servern.')
    .addStringOption(o =>
      o.setName('identifier').setDescription('Exakter Spielername / Gameserver-Identifier').setRequired(true).setMinLength(1).setMaxLength(128),
    )
    .addStringOption(o =>
      o.setName('grund').setDescription('Grund fuer den Server-Bann').setRequired(true).setMinLength(1).setMaxLength(MAX_REASON_LENGTH),
    )
    .addIntegerOption(o =>
      o.setName('dauer').setDescription('Dauer in Minuten; leer = permanent').setRequired(false).setMinValue(1).setMaxValue(MAX_BAN_MINUTES),
    )
    .addStringOption(o =>
      o.setName('slot').setDescription('Server-Alias auswaehlen; leer = ALLE verknuepften Server').setRequired(false).setAutocomplete(true),
    ) as SlashCommandBuilder,

  autocomplete: autocompleteServerAlias,

  execute: withGuildScope({ requirePerm: 'bans.manage', guildOnly: true }, async (interaction, scope) => {
    const identifier = interaction.options.getString('identifier', true).trim();
    const reason = interaction.options.getString('grund', true).trim();
    const durationMinutes = interaction.options.getInteger('dauer');

    if (!IDENTIFIER_RE.test(identifier)) {
      await reply(interaction, 'Ungueltiger Gameserver-Identifier. Keine Zeilenumbrueche/Tabulatoren; maximal 128 Zeichen.');
      return;
    }

    const targets = await resolveSelectedOrAllServers(interaction, scope.guildId);
    if (!targets) return;

    const identityHash = hashBanIdentifier(identifier, config.security.encryptionKey);
    const now = new Date();
    const expiresAt = durationMinutes
      ? new Date(now.getTime() + durationMinutes * 60_000)
      : null;

    const results: string[] = [];
    for (const target of targets) {
      const label = targetLabel(target);
      try {
        // Eine lokale Transaktion pro Server: Whitelist-Desired-State darf nie
        // ohne die dazugehoerige Ban-Wahrheit/Outbox verschwinden und umgekehrt.
        const stored = await prisma.$transaction(async tx => {
          await tx.whitelistEntry.deleteMany({
            where: { guildId: scope.guildId, nitradoConnId: target.id, gameId: identifier },
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
          remoteQueued: stored.queued,
          whitelistDesiredRemovedFirst: true,
          remoteSequence: 'WHITELIST_REMOVE_THEN_BAN',
        });

        results.push(`✅ **${label}** — Whitelist-Entfernung + Bann ${stored.queued ? 'sicher eingereiht' : 'bereits in Bearbeitung'}.`);
      } catch (error) {
        const message = safeErrorMessage(error, identifier);
        results.push(`❌ **${label}** — nicht gebannt: ${message}`);
        logAudit('SERVER_BAN_SET_FAILED', 'MODERATION', {
          guildId: scope.guildId,
          slotId: target.id,
          slot: target.slot,
          alias: target.alias,
          actor: scope.actorDiscordId,
          error: message,
        });
      }
    }

    const scopeText = targets.length === 1 ? targetLabel(targets[0]) : `alle ${targets.length} verknuepften Server`;
    await reply(
      interaction,
      `Server-Bann fuer den Identifier wurde auf **${scopeText}** verarbeitet.\n` +
      `Dauer: ${expiresAt ? `<t:${Math.floor(expiresAt.getTime() / 1000)}:R>` : 'Permanent'}\n\n` +
      results.join('\n'),
    );
  }),
};

// ============================================================
// /server-unban — exakte ID; funktioniert auch ohne lokale Link-/Ban-Zeile
// ============================================================
export const serverUnbanCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('server-unban')
    .setDescription('Entbannt eine Game-ID auf einem Alias oder allen verknuepften Nitrado-Servern.')
    .addStringOption(o =>
      o.setName('identifier').setDescription('Exakter Spielername / Gameserver-Identifier').setRequired(true).setMinLength(1).setMaxLength(128),
    )
    .addStringOption(o =>
      o.setName('slot').setDescription('Server-Alias auswaehlen; leer = ALLE verknuepften Server').setRequired(false).setAutocomplete(true),
    ) as SlashCommandBuilder,

  autocomplete: autocompleteServerAlias,

  execute: withGuildScope({ requirePerm: 'bans.manage', guildOnly: true }, async (interaction, scope) => {
    const identifier = interaction.options.getString('identifier', true).trim();
    if (!IDENTIFIER_RE.test(identifier)) {
      await reply(interaction, 'Ungueltiger Gameserver-Identifier. Keine Zeilenumbrueche/Tabulatoren; maximal 128 Zeichen.');
      return;
    }

    const targets = await resolveSelectedOrAllServers(interaction, scope.guildId);
    if (!targets) return;

    const identityHash = hashBanIdentifier(identifier, config.security.encryptionKey);
    const now = new Date();
    const results: string[] = [];

    for (const target of targets) {
      const label = targetLabel(target);
      try {
        const queued = await prisma.$transaction(async tx => {
          // Reconcile-Anker: auch ein extern/manuell gesetzter Nitrado-Bann ohne
          // lokale Registry-Zeile kann dadurch ueber die bestehende sichere
          // REMOVE-Outbox per HMAC gefunden und entfernt werden.
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
              appliedRemotely: true,
              liftedAt: now,
            },
            update: {
              active: false,
              appliedRemotely: true,
              liftedAt: now,
            },
            select: { id: true },
          });

          return enqueueServerBanRemove(
            tx as unknown as BanOutboxClient,
            { guildId: scope.guildId, nitradoConnId: target.id },
            row.id,
          );
        });

        logAudit('SERVER_BAN_LIFT', 'MODERATION', {
          guildId: scope.guildId,
          slotId: target.id,
          slot: target.slot,
          alias: target.alias,
          actor: scope.actorDiscordId,
          remoteQueued: queued,
          directIdentifier: true,
        });
        results.push(`✅ **${label}** — Remote-Unban ${queued ? 'eingereiht' : 'bereits in Bearbeitung'}.`);
      } catch (error) {
        const message = safeErrorMessage(error, identifier);
        results.push(`❌ **${label}** — Unban fehlgeschlagen: ${message}`);
      }
    }

    const scopeText = targets.length === 1 ? targetLabel(targets[0]) : `alle ${targets.length} verknuepften Server`;
    await reply(interaction, `Server-Unban wurde fuer **${scopeText}** verarbeitet.\n\n${results.join('\n')}`);
  }),
};

// ============================================================
// /server-ban-list — echte Nitrado-Banlist, pro Alias immer getrennt
// ============================================================
export const serverBanListCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('server-ban-list')
    .setDescription('Zeigt die Nitrado-Banlist pro Server-Alias getrennt an.')
    .addStringOption(o =>
      o.setName('slot').setDescription('Server-Alias auswaehlen; leer = ALLE verknuepften Server').setRequired(false).setAutocomplete(true),
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
            .setTitle(`Banlist • ${targetLabel(target)}${pages > 1 ? ` • ${pageNo}/${pages}` : ''}`)
            .setDescription(lines.join('\n'))
            .setFooter({ text: `${rows.length} Eintraege • Quelle: Nitrado` })
            .setTimestamp());
        }
      } catch (error) {
        embeds.push(new EmbedBuilder()
          .setTitle(`Banlist • ${targetLabel(target)}`)
          .setDescription(`❌ Nitrado-Liste konnte nicht gelesen werden: ${safeErrorMessage(error)}`)
          .setTimestamp());
      }
    }

    await replyEmbeds(interaction, embeds);
  }),
};
