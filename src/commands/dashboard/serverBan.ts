/**
 * Phase 7 — Bedienebene fuer die Server-Ban-Registry + echte Nitrado-Outbox.
 *
 * Remote-Bans laufen ausschliesslich gegen den offiziellen Gameserver-Banlist-
 * Endpoint. Der echte Gameserver-Identifier wird beim Ban-Aufruf gegen den
 * VERIFIED GameIdentityLink-HMAC geprueft und nie im Klartext persistiert oder
 * geloggt. Unban/Timeout loesen den Identifier spaeter live aus der Remote-
 * Banlist per HMAC auf.
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
import {
  addBan,
  liftBan,
  liftBanById,
  listOperationalBans,
  banOperationalState,
  type BanClient,
  type BanListClient,
} from '../../modules/bans/banRegistry';
import {
  resolveVerifiedBanIdentityHash,
  matchesBanIdentifier,
  type BanTargetClient,
} from '../../modules/bans/banTarget';
import {
  enqueueServerBanAdd,
  enqueueServerBanRemove,
  type BanOutboxClient,
} from '../../modules/bans/banOutbox';
import { config } from '../../config';
import { logAudit } from '../../utils/logger';

const MAX_BAN_MINUTES = 365 * 24 * 60;
const MAX_REASON_LENGTH = 300;
const IDENTIFIER_RE = /^[^\r\n\t]{1,128}$/;

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

function operationalStateLabel(state: ReturnType<typeof banOperationalState>): string {
  if (state === 'REMOTE_DRIFT') return '⚠️ REMOTE-ABWEICHUNG • lokal inaktiv, remote markiert';
  if (state === 'LOCAL_AND_REMOTE') return 'Lokal aktiv • Remote angewendet';
  return 'Lokal aktiv • Remote ausstehend/nicht angewendet';
}

// ============================================================
// /server-ban — lokalen Bann + verifizierten Remote-Ban queued setzen
// ============================================================
export const serverBanCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('server-ban')
    .setDescription('Bannt einen verifizierten Spieler im ausgewaehlten Gameserver.')
    .addUserOption(o =>
      o.setName('user').setDescription('Verifizierter Discord-Nutzer').setRequired(true),
    )
    .addStringOption(o =>
      o.setName('identifier').setDescription('Exakte Game-ID aus ADM/Nitrado; wird nicht im Klartext gespeichert').setRequired(true).setMinLength(1).setMaxLength(128),
    )
    .addStringOption(o =>
      o.setName('grund').setDescription('Grund fuer den Server-Bann').setRequired(true).setMinLength(1).setMaxLength(MAX_REASON_LENGTH),
    )
    .addIntegerOption(o =>
      o.setName('dauer').setDescription('Dauer in Minuten; leer = permanent').setRequired(false).setMinValue(1).setMaxValue(MAX_BAN_MINUTES),
    )
    .addIntegerOption(o =>
      o.setName('slot').setDescription('Nitrado-Slot 1-5; leer = aktiver Slot').setRequired(false).setMinValue(1).setMaxValue(5),
    ) as SlashCommandBuilder,

  execute: withGuildScope({ requirePerm: 'bans.manage', acceptSlotOption: true }, async (interaction, scope) => {
    const target = interaction.options.getUser('user', true);
    const identifier = interaction.options.getString('identifier', true).trim();
    const reason = interaction.options.getString('grund', true).trim();
    const durationMinutes = interaction.options.getInteger('dauer');
    const banScope = { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId! };

    if (!IDENTIFIER_RE.test(identifier)) {
      await reply(interaction, 'Ungueltiger Gameserver-Identifier. Er darf keine Zeilenumbrueche/Tabulatoren enthalten und maximal 128 Zeichen lang sein.');
      return;
    }

    const identityHash = await resolveVerifiedBanIdentityHash(
      prisma as unknown as BanTargetClient,
      banScope,
      target.id,
    );
    if (!identityHash) {
      await reply(interaction, 'Dieser Nutzer hat in diesem Slot keine VERIFIED Game-Verknuepfung. Ein sicherer Server-Bann kann deshalb nicht angelegt werden.');
      return;
    }

    // Kritische Schutzschranke: Der vom Moderator eingegebene Identifier muss
    // exakt zu der bereits per /link verifizierten HMAC-Identitaet gehoeren.
    if (!matchesBanIdentifier(identifier, identityHash, config.security.encryptionKey)) {
      await reply(interaction, 'Der angegebene Gameserver-Identifier passt nicht zur VERIFIED Game-Verknuepfung dieses Nutzers. Es wurde kein Bann angelegt.');
      return;
    }

    const now = new Date();
    const expiresAt = durationMinutes
      ? new Date(now.getTime() + durationMinutes * 60_000)
      : null;

    const result = await prisma.$transaction(async tx => {
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

      const stored = await tx.serverBanEntry.findUnique({
        where: {
          guildId_nitradoConnId_identityHash: {
            guildId: scope.guildId,
            nitradoConnId: scope.nitradoConnId!,
            identityHash,
          },
        },
        select: { id: true, appliedRemotely: true },
      });
      if (!stored) throw new Error('Server-Ban konnte nach dem Anlegen nicht wiedergefunden werden.');

      // Auch bei appliedRemotely=true immer einen Reconcile-ADD sicherstellen.
      // Das schliesst das Rennen mit einem parallel laufenden Remote-Unban:
      // REMOVE und ADD werden pro Connection serialisiert, der spaetere ADD
      // stellt den gewuenschten lokalen Zustand wieder her.
      const queued = await enqueueServerBanAdd(
        tx as unknown as BanOutboxClient,
        banScope,
        stored.id,
        identifier,
        config.security.encryptionKey,
      );

      return { ...stored, queued };
    });

    logAudit('SERVER_BAN_SET', 'MODERATION', {
      guildId: scope.guildId,
      slotId: scope.nitradoConnId,
      actor: scope.actorDiscordId,
      targetDiscordId: target.id,
      banId: result.id,
      expiresAt: expiresAt?.toISOString() ?? null,
      appliedRemotely: result.appliedRemotely,
      remoteQueued: result.queued,
    });

    const enforcement = result.queued
      ? result.appliedRemotely
        ? 'Remote war bereits markiert; ein Reconcile-Job wurde trotzdem sicher eingereiht.'
        : 'Remote-Durchsetzung wurde sicher in die Nitrado-Outbox eingereiht.'
      : 'Ein passender Remote-Reconcile-Job laeuft bereits.';

    await reply(
      interaction,
      `Server-Bann fuer <@${target.id}> registriert.\n` +
      `Ban-ID: \`${result.id}\`\n` +
      `Dauer: ${expiresAt ? `<t:${Math.floor(expiresAt.getTime() / 1000)}:R>` : 'Permanent'}\n` +
      `Status: ${enforcement}`,
    );
  }),
};

// ============================================================
// /server-unban — lokal aufheben + Remote-Removal queued
// ============================================================
export const serverUnbanCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('server-unban')
    .setDescription('Hebt einen Server-Bann per Nutzer oder Ban-ID auf.')
    .addUserOption(o =>
      o.setName('user').setDescription('Aktuell VERIFIED Nutzer-Link').setRequired(false),
    )
    .addStringOption(o =>
      o.setName('ban-id').setDescription('Ban-ID aus /server-ban-list').setRequired(false).setMinLength(1).setMaxLength(64),
    )
    .addIntegerOption(o =>
      o.setName('slot').setDescription('Nitrado-Slot 1-5; leer = aktiver Slot').setRequired(false).setMinValue(1).setMaxValue(5),
    ) as SlashCommandBuilder,

  execute: withGuildScope({ requirePerm: 'bans.manage', acceptSlotOption: true }, async (interaction, scope) => {
    const target = interaction.options.getUser('user');
    const banId = interaction.options.getString('ban-id')?.trim() ?? null;
    if ((!target && !banId) || (target && banId)) {
      await reply(interaction, 'Bitte genau eines angeben: `user` oder `ban-id`.');
      return;
    }

    const banScope = { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId! };
    const now = new Date();
    const targetDiscordId: string | null = target?.id ?? null;

    let identityHash: string | null = null;
    if (target) {
      identityHash = await resolveVerifiedBanIdentityHash(
        prisma as unknown as BanTargetClient,
        banScope,
        target.id,
      );
      if (!identityHash) {
        await reply(interaction, 'Kein aktueller VERIFIED Link gefunden. Nutze bei einem alten/unlinkten Bann die `ban-id` aus `/server-ban-list`.');
        return;
      }
    }

    const result = await prisma.$transaction(async tx => {
      const row = banId
        ? await tx.serverBanEntry.findFirst({
          where: { id: banId, guildId: scope.guildId, nitradoConnId: scope.nitradoConnId! },
          select: { id: true, active: true, appliedRemotely: true },
        })
        : await tx.serverBanEntry.findUnique({
          where: {
            guildId_nitradoConnId_identityHash: {
              guildId: scope.guildId,
              nitradoConnId: scope.nitradoConnId!,
              identityHash: identityHash!,
            },
          },
          select: { id: true, active: true, appliedRemotely: true },
        });

      if (!row) return null;

      let lifted = false;
      if (row.active) {
        lifted = banId
          ? await liftBanById(tx as unknown as BanClient, banScope, row.id, now)
          : await liftBan(tx as unknown as BanClient, banScope, identityHash!, now);
      }

      const remoteQueued = row.appliedRemotely
        ? await enqueueServerBanRemove(
          tx as unknown as BanOutboxClient,
          banScope,
          row.id,
        )
        : false;

      return {
        id: row.id,
        lifted,
        needsRemoteRemoval: row.appliedRemotely,
        remoteQueued,
      };
    });

    if (!result) {
      await reply(interaction, banId
        ? 'Keine Ban-ID in diesem Guild+Slot-Scope gefunden.'
        : 'Fuer diesen verifizierten Nutzer existiert in diesem Slot kein Server-Bann.');
      return;
    }

    if (!result.lifted && !result.needsRemoteRemoval) {
      await reply(interaction, 'Der gefundene Bann ist bereits vollstaendig aufgehoben.');
      return;
    }

    logAudit('SERVER_BAN_LIFT', 'MODERATION', {
      guildId: scope.guildId,
      slotId: scope.nitradoConnId,
      actor: scope.actorDiscordId,
      targetDiscordId,
      banId: result.id,
      remoteQueued: result.remoteQueued,
      needsRemoteRemoval: result.needsRemoteRemoval,
    });

    const remoteStatus = result.needsRemoteRemoval
      ? result.remoteQueued
        ? ' Remote-Unban wurde in die Nitrado-Outbox eingereiht.'
        : ' Ein passender Remote-Unban-Job laeuft bereits.'
      : '';
    await reply(interaction, `Server-Bann \`${result.id}\` lokal aufgehoben.${remoteStatus}`);
  }),
};

// ============================================================
// /server-ban-list — aktive Registry + sichtbare Remote-Abweichungen
// ============================================================
export const serverBanListCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('server-ban-list')
    .setDescription('Zeigt aktive Server-Banns und Remote-Abweichungen des Slots (max. 50).')
    .addIntegerOption(o =>
      o.setName('slot').setDescription('Nitrado-Slot 1-5; leer = aktiver Slot').setRequired(false).setMinValue(1).setMaxValue(5),
    ) as SlashCommandBuilder,

  execute: withGuildScope({ requirePerm: 'bans.view', acceptSlotOption: true }, async (interaction, scope) => {
    const now = new Date();
    const banScope = { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId! };
    const rows = await listOperationalBans(
      prisma as unknown as BanListClient,
      banScope,
      now,
      50,
    );

    if (rows.length === 0) {
      await reply(interaction, 'Keine aktiven Server-Banns oder Remote-Abweichungen in diesem Slot.');
      return;
    }

    const hashes = rows.map(r => r.identityHash);
    const links = await prisma.gameIdentityLink.findMany({
      where: {
        guildId: scope.guildId,
        nitradoConnId: scope.nitradoConnId!,
        identityHash: { in: hashes },
      },
      select: { identityHash: true, userDiscordId: true },
    });
    const userByHash = new Map<string, string>();
    for (const link of links) {
      if (link.identityHash) userByHash.set(link.identityHash, link.userDiscordId);
    }

    const lines = rows.map(row => {
      const userId = userByHash.get(row.identityHash);
      const target = userId ? `<@${userId}>` : `Hash \`${row.identityHash.slice(0, 10)}…\``;
      const expiry = row.expiresAt
        ? `<t:${Math.floor(row.expiresAt.getTime() / 1000)}:R>`
        : 'Permanent';
      const state = operationalStateLabel(banOperationalState(row, now));
      return [
        `**${target}** • ${state} • ${expiry}`,
        `ID: \`${row.id}\` • Grund: ${safeLine(row.reason)}`,
      ].join('\n');
    });

    const embed = new EmbedBuilder()
      .setTitle(`Server-Banns / Remote-Abweichungen (${rows.length})`)
      .setDescription(lines.join('\n\n').slice(0, 4000))
      .setFooter({ text: 'V-Bot • Lokale Registry + Nitrado-Remote-Sync' })
      .setTimestamp(now);

    await interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  }),
};
