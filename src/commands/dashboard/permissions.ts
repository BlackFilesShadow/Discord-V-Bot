/**
 * Guild-Permissions.
 *
 * Invarianten:
 * - ausschliesslich Guild-Owner duerfen User-Grants veraendern/einsehen;
 * - NON_DELEGABLE_SCOPES werden weder Autocomplete noch freier Eingabe akzeptiert;
 * - Dashboard und Slashcommands nutzen EXAKT dasselbe serialisierte Repository;
 * - auch idempotente Command-Intents laufen durch die serialisierte Mutation;
 * - Direct-Grants werden an die live validierte Mitgliedschaftsepoche gebunden;
 * - /perms listet alle Grants ueber mehrere Embeds statt still nach 50 zu enden.
 */

import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  EmbedBuilder,
  MessageFlags,
} from 'discord.js';
import type { Command } from '../../types';
import { withGuildScope } from '../middleware/withGuildScope';
import {
  PERMISSION_SCOPES,
  NON_DELEGABLE_SCOPES,
  asUserDiscordId,
} from '../../types/scope';
import type { PermissionScope } from '../../types/scope';
import {
  deleteGrantForMembershipEpoch,
  listGrants,
  setGrantScope,
  PermissionMembershipEpochConflictError,
} from '../../modules/permissions/repository';
import { logAudit } from '../../utils/logger';
import { emitGuildEvent } from '../../dashboard/socket/emitter';
import { vEmbed } from '../../utils/embedDesign';
import { buildStatusEmbed, type EmbedStatus } from '../../utils/statusEmbed';

const DELEGABLE: PermissionScope[] = PERMISSION_SCOPES.filter(scope => !NON_DELEGABLE_SCOPES.has(scope));

function isDelegablePermissionScope(value: string): value is PermissionScope {
  return DELEGABLE.includes(value as PermissionScope);
}

async function statusReply(
  interaction: ChatInputCommandInteraction,
  status: EmbedStatus,
  title: string,
  description: string,
): Promise<void> {
  await interaction.reply({
    embeds: [buildStatusEmbed({ status, title, description, footerText: 'V-Bot Permissions' })],
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

async function membershipConflictReply(
  interaction: ChatInputCommandInteraction,
  error: unknown,
): Promise<boolean> {
  if (!(error instanceof PermissionMembershipEpochConflictError)) return false;
  await statusReply(
    interaction,
    'ERROR',
    'Mitgliedschaft hat sich geaendert',
    'Die Discord-Mitgliedschaft des Ziel-Users hat sich waehrend der Aktion geaendert. Bitte den Befehl mit dem aktuellen Mitglied erneut ausfuehren.',
  );
  return true;
}

/** Erzwingt nach dem DB-Commit einen frischen Discord-Member-Lookup. */
async function membershipEpochStillCurrent(
  interaction: ChatInputCommandInteraction,
  targetDiscordId: string,
  expectedJoinedAt: Date,
): Promise<boolean> {
  if (!interaction.guild) return false;
  const member = await interaction.guild.members
    .fetch({ user: targetDiscordId, force: true })
    .catch(() => null);
  return !!member?.joinedAt && member.joinedAt.getTime() === expectedJoinedAt.getTime();
}

async function compensateStaleMembershipGeneration(
  interaction: ChatInputCommandInteraction,
  guildId: Parameters<typeof deleteGrantForMembershipEpoch>[0],
  targetId: Parameters<typeof deleteGrantForMembershipEpoch>[1],
  expectedJoinedAt: Date,
): Promise<void> {
  try {
    await deleteGrantForMembershipEpoch(guildId, targetId, expectedJoinedAt);
  } catch (error) {
    // Die alte Generation bleibt authorizer-seitig wirkungslos; der Cleanup-
    // Fehler wird fuer Operations/Audit sichtbar statt verschluckt.
    logAudit('PERM_EPOCH_COMPENSATION_FAILED', 'SECURITY', {
      guildId,
      target: targetId,
      actor: interaction.user.id,
      expectedJoinedAt: expectedJoinedAt.toISOString(),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function autocompletePermissionScope(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused().toString().trim().toLowerCase();
  const matches = DELEGABLE
    .filter(scope => !focused || scope.toLowerCase().includes(focused))
    .slice(0, 25)
    .map(scope => ({ name: scope, value: scope }));
  await interaction.respond(matches);
}

export const permAddCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('perm-add')
    .setDescription('Owner: Vergibt einem User eine Scope-Permission fuer diesen Server.')
    .addUserOption(option => option.setName('user').setDescription('Ziel-User').setRequired(true))
    .addStringOption(option => option.setName('scope').setDescription('Permission').setRequired(true).setAutocomplete(true)) as SlashCommandBuilder,
  autocomplete: autocompletePermissionScope,
  execute: withGuildScope({ guildOnly: true, requirePerm: 'permissions.manage' }, async (interaction, scope) => {
    if (!scope.isOwner) {
      await statusReply(interaction, 'ERROR', 'Nur Server-Owner', 'Nur der Server-Owner kann Permissions vergeben.');
      return;
    }
    const target = interaction.options.getUser('user', true);
    if (target.bot) {
      await statusReply(interaction, 'ERROR', 'Bot nicht erlaubt', 'Bots koennen keine delegierbaren Guild-Permissions erhalten.');
      return;
    }
    if (target.id === scope.actorDiscordId) {
      await statusReply(interaction, 'INFO', 'Owner braucht keinen Grant', 'Der Server-Owner besitzt bereits alle Guild-Berechtigungen.');
      return;
    }
    const member = interaction.guild?.members.cache.get(target.id)
      ?? await interaction.guild?.members.fetch(target.id).catch(() => null);
    if (!member) {
      await statusReply(interaction, 'ERROR', 'Mitglied erforderlich', 'Der Ziel-User ist kein aktuelles Mitglied dieses Discord-Servers.');
      return;
    }
    if (!member.joinedAt) {
      await statusReply(
        interaction,
        'ERROR',
        'Mitgliedschaft nicht sicher bestimmbar',
        'Die aktuelle Beitritts-Epoche des Ziel-Users konnte nicht sicher bestimmt werden. Bitte spaeter erneut versuchen.',
      );
      return;
    }

    const rawPerm = interaction.options.getString('scope', true).trim();
    if (!isDelegablePermissionScope(rawPerm)) {
      await statusReply(interaction, 'ERROR', 'Permission nicht delegierbar', 'Waehle eine bekannte delegierbare Permission aus dem Autocomplete.');
      return;
    }
    const perm = rawPerm;
    const targetId = asUserDiscordId(target.id);
    const expectedJoinedAt = member.joinedAt;

    try {
      await setGrantScope(
        scope.guildId,
        targetId,
        perm,
        true,
        scope.actorDiscordId,
        expectedJoinedAt,
      );

      if (!(await membershipEpochStillCurrent(interaction, target.id, expectedJoinedAt))) {
        await compensateStaleMembershipGeneration(interaction, scope.guildId, targetId, expectedJoinedAt);
        throw new PermissionMembershipEpochConflictError();
      }
    } catch (error) {
      if (await membershipConflictReply(interaction, error)) return;
      throw error;
    }

    logAudit('PERM_GRANTED', 'SECURITY', {
      guildId: scope.guildId,
      target: target.id,
      perm,
      actor: scope.actorDiscordId,
    });
    emitGuildEvent(scope.guildId, {
      type: 'permissions.updated',
      payload: { guildId: scope.guildId, userDiscordId: target.id },
    });
    await statusReply(
      interaction,
      'SUCCESS',
      'Permission gesetzt',
      `\`${perm}\` ist fuer <@${target.id}> in der aktuellen Mitgliedschaft aktiv.`,
    );
  }),
};

export const permRemoveCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('perm-remove')
    .setDescription('Owner: Entzieht eine Scope-Permission.')
    .addUserOption(option => option.setName('user').setDescription('Ziel-User').setRequired(true))
    .addStringOption(option => option.setName('scope').setDescription('Permission').setRequired(true).setAutocomplete(true)) as SlashCommandBuilder,
  autocomplete: autocompletePermissionScope,
  execute: withGuildScope({ guildOnly: true, requirePerm: 'permissions.manage' }, async (interaction, scope) => {
    if (!scope.isOwner) {
      await statusReply(interaction, 'ERROR', 'Nur Server-Owner', 'Nur der Server-Owner kann Permissions entziehen.');
      return;
    }
    const target = interaction.options.getUser('user', true);
    const rawPerm = interaction.options.getString('scope', true).trim();
    if (!isDelegablePermissionScope(rawPerm)) {
      await statusReply(interaction, 'ERROR', 'Permission nicht delegierbar', 'Waehle eine bekannte delegierbare Permission aus dem Autocomplete.');
      return;
    }
    const perm = rawPerm;
    const targetId = asUserDiscordId(target.id);
    const member = interaction.guild?.members.cache.get(target.id)
      ?? await interaction.guild?.members.fetch(target.id).catch(() => null);
    const expectedJoinedAt = member?.joinedAt ?? null;

    try {
      await setGrantScope(
        scope.guildId,
        targetId,
        perm,
        false,
        scope.actorDiscordId,
        expectedJoinedAt,
      );

      if (expectedJoinedAt && !(await membershipEpochStillCurrent(interaction, target.id, expectedJoinedAt))) {
        await compensateStaleMembershipGeneration(interaction, scope.guildId, targetId, expectedJoinedAt);
        throw new PermissionMembershipEpochConflictError();
      }
    } catch (error) {
      if (await membershipConflictReply(interaction, error)) return;
      throw error;
    }

    logAudit('PERM_REVOKED', 'SECURITY', {
      guildId: scope.guildId,
      target: target.id,
      perm,
      actor: scope.actorDiscordId,
    });
    emitGuildEvent(scope.guildId, {
      type: 'permissions.updated',
      payload: { guildId: scope.guildId, userDiscordId: target.id },
    });
    await statusReply(
      interaction,
      'SUCCESS',
      'Permission entzogen',
      `\`${perm}\` ist fuer <@${target.id}> nicht mehr aktiv.`,
    );
  }),
};

export const permsCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('perms')
    .setDescription('Owner: Listet alle Permission-Grants in diesem Server.'),
  execute: withGuildScope({ guildOnly: true, requirePerm: 'permissions.manage' }, async (interaction, scope) => {
    if (!scope.isOwner) {
      await statusReply(interaction, 'ERROR', 'Nur Server-Owner', 'Nur der Server-Owner kann Permission-Grants einsehen.');
      return;
    }

    const rows = (await listGrants(scope.guildId))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    if (rows.length === 0) {
      await statusReply(interaction, 'INFO', 'Keine Grants', 'In diesem Discord-Server existieren keine User-Permission-Grants.');
      return;
    }

    const embeds: EmbedBuilder[] = [];
    for (let offset = 0; offset < rows.length; offset += 25) {
      const page = rows.slice(offset, offset + 25);
      const pageNo = Math.floor(offset / 25) + 1;
      const pageCount = Math.ceil(rows.length / 25);
      const embed = vEmbed()
        .setTitle(`Permission-Grants${pageCount > 1 ? ` · ${pageNo}/${pageCount}` : ''}`)
        .setDescription(`**${rows.length}** User-Grant(s) auf diesem Server`)
        .setTimestamp();
      for (const row of page) {
        embed.addFields({
          name: `User ${row.userDiscordId}`,
          value: row.permissions.length > 0
            ? row.permissions.map(value => `\`${value}\``).join(' ').slice(0, 1024)
            : '_keine delegierbaren Permissions_',
          inline: false,
        });
      }
      embeds.push(embed);
    }

    for (let index = 0; index < embeds.length; index += 10) {
      const chunk = embeds.slice(index, index + 10);
      if (index === 0) {
        await interaction.reply({ embeds: chunk, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      } else {
        await interaction.followUp({ embeds: chunk, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      }
    }
  }),
};
