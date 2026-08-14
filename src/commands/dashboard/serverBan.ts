/**
 * Phase 7 — Bedienebene fuer die lokale Server-Ban-Registry.
 *
 * Wichtig: Es existiert aktuell keine verifizierte Nitrado-/DayZ-Ban-Capability
 * im Client. Diese Commands verwalten daher die DB-Wahrheit und kennzeichnen
 * offen, ob ein Bann remote durchgesetzt wurde. Keine rohe Game-ID wird
 * gespeichert oder angezeigt; Ziel ist der VERIFIED GameIdentityLink-HMAC.
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
  localOnlyBanProvider,
  type BanClient,
  type BanListClient,
} from '../../modules/bans/banRegistry';
import {
  resolveVerifiedBanIdentityHash,
  type BanTargetClient,
} from '../../modules/bans/banTarget';
import { logAudit } from '../../utils/logger';

const MAX_BAN_MINUTES = 365 * 24 * 60;
const MAX_REASON_LENGTH = 300;

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
  return 'Lokal aktiv • Nicht remote angewendet';
}

// ============================================================
// /server-ban — lokalen Server-Bann setzen / reaktivieren
// ============================================================
export const serverBanCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('server-ban')
    .setDescription('Registriert einen Server-Bann fuer einen verifizierten Spieler-Link.')
    .addUserOption(o =>
      o.setName('user').setDescription('Verifizierter Discord-Nutzer').setRequired(true),
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
    const reason = interaction.options.getString('grund', true).trim();
    const durationMinutes = interaction.options.getInteger('dauer');
    const banScope = { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId! };

    const identityHash = await resolveVerifiedBanIdentityHash(
      prisma as unknown as BanTargetClient,
      banScope,
      target.id,
    );
    if (!identityHash) {
      await reply(interaction, 'Dieser Nutzer hat in diesem Slot keine VERIFIED Game-Verknuepfung. Ein sicherer Server-Bann kann deshalb nicht angelegt werden.');
      return;
    }

    const now = new Date();
    const expiresAt = durationMinutes
      ? new Date(now.getTime() + durationMinutes * 60_000)
      : null;

    await addBan(
      prisma as unknown as BanClient,
      banScope,
      {
        identityHash,
        reason,
        bannedByDiscordId: scope.actorDiscordId,
        expiresAt,
      },
      now,
    );

    const stored = await prisma.serverBanEntry.findUnique({
      where: {
        guildId_nitradoConnId_identityHash: {
          guildId: scope.guildId,
          nitradoConnId: scope.nitradoConnId!,
          identityHash,
        },
      },
      select: { id: true, appliedRemotely: true },
    });

    logAudit('SERVER_BAN_SET', 'MODERATION', {
      guildId: scope.guildId,
      slotId: scope.nitradoConnId,
      actor: scope.actorDiscordId,
      targetDiscordId: target.id,
      banId: stored?.id,
      expiresAt: expiresAt?.toISOString() ?? null,
      appliedRemotely: stored?.appliedRemotely ?? false,
    });

    const capability = localOnlyBanProvider.capabilities();
    const enforcement = stored?.appliedRemotely
      ? 'Remote-Durchsetzung ist fuer diesen Eintrag als aktiv markiert.'
      : capability.canApplyRemote
        ? 'Remote-Durchsetzung ist verfuegbar, wurde fuer diesen Eintrag aber noch nicht bestaetigt.'
        : 'Aktuell existiert keine verifizierte Gameserver-Ban-Capability. Der Bann ist nur lokal in V-Bot registriert.';

    await reply(
      interaction,
      `Server-Bann fuer <@${target.id}> registriert.\n` +
      `Ban-ID: \`${stored?.id ?? 'unbekannt'}\`\n` +
      `Dauer: ${expiresAt ? `<t:${Math.floor(expiresAt.getTime() / 1000)}:R>` : 'Permanent'}\n` +
      `Status: ${enforcement}`,
    );
  }),
};

// ============================================================
// /server-unban — ueber User oder Ban-ID aufheben
// ============================================================
export const serverUnbanCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('server-unban')
    .setDescription('Hebt einen lokalen Server-Bann per Nutzer oder Ban-ID auf.')
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
    let lifted = false;
    let selectedBanId: string | null = banId;
    let appliedRemotely = false;
    const targetDiscordId: string | null = target?.id ?? null;

    if (banId) {
      const row = await prisma.serverBanEntry.findFirst({
        where: { id: banId, guildId: scope.guildId, nitradoConnId: scope.nitradoConnId! },
        select: { id: true, appliedRemotely: true },
      });
      if (!row) {
        await reply(interaction, 'Keine Ban-ID in diesem Guild+Slot-Scope gefunden.');
        return;
      }
      appliedRemotely = row.appliedRemotely;
      selectedBanId = row.id;
      lifted = await liftBanById(prisma as unknown as BanClient, banScope, row.id, now);
    } else if (target) {
      const identityHash = await resolveVerifiedBanIdentityHash(
        prisma as unknown as BanTargetClient,
        banScope,
        target.id,
      );
      if (!identityHash) {
        await reply(interaction, 'Kein aktueller VERIFIED Link gefunden. Nutze bei einem alten/unlinkten Bann die `ban-id` aus `/server-ban-list`.');
        return;
      }
      const row = await prisma.serverBanEntry.findUnique({
        where: {
          guildId_nitradoConnId_identityHash: {
            guildId: scope.guildId,
            nitradoConnId: scope.nitradoConnId!,
            identityHash,
          },
        },
        select: { id: true, appliedRemotely: true },
      });
      if (!row) {
        await reply(interaction, 'Fuer diesen verifizierten Nutzer existiert in diesem Slot kein Server-Bann.');
        return;
      }
      selectedBanId = row.id;
      appliedRemotely = row.appliedRemotely;
      lifted = await liftBan(prisma as unknown as BanClient, banScope, identityHash, now);
    }

    if (!lifted) {
      await reply(interaction, 'Der gefundene Bann ist bereits aufgehoben oder nicht mehr aktiv.');
      return;
    }

    logAudit('SERVER_BAN_LIFT', 'MODERATION', {
      guildId: scope.guildId,
      slotId: scope.nitradoConnId,
      actor: scope.actorDiscordId,
      targetDiscordId,
      banId: selectedBanId,
      appliedRemotely,
    });

    const remoteWarning = appliedRemotely
      ? '\nAchtung: Der Eintrag war als remote angewendet markiert. V-Bot besitzt aktuell keine verifizierte Remove-Ban-Capability; der Eintrag bleibt deshalb als REMOTE-ABWEICHUNG in `/server-ban-list` sichtbar, bis die Gameserver-Seite geklaert ist.'
      : '';
    await reply(interaction, `Server-Bann \`${selectedBanId ?? 'unbekannt'}\` lokal aufgehoben.${remoteWarning}`);
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
      .setFooter({ text: 'V-Bot • Lokale Registry; Remote-Abweichungen bleiben sichtbar' })
      .setTimestamp(now);

    await interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  }),
};
