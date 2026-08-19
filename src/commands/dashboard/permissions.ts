/**
 * Guild-Permissions.
 *
 * Invarianten:
 * - ausschliesslich Guild-Owner duerfen User-Grants veraendern/einsehen;
 * - NON_DELEGABLE/unknown scopes werden niemals autorisiert;
 * - Ziel-User muss aktuelles Nicht-Bot-Mitglied der exakten Guild sein;
 * - Dashboard und Slashcommands verwenden dieselbe cross-process serialisierte
 *   Mutationsengine, damit parallele Writes keine Updates verlieren;
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
import prisma from '../../database/prisma';
import { withGuildScope } from '../middleware/withGuildScope';
import { PERMISSION_SCOPES, NON_DELEGABLE_SCOPES, asUserDiscordId } from '../../types/scope';
import type { PermissionScope } from '../../types/scope';
import { mutatePermissionGrant } from '../../modules/permissions/mutationService';
import { isDelegablePermissionScope, sanitizeDelegablePermissionScopes } from '../../modules/permissions/policy';
import { resolveDelegableUserTarget } from '../../modules/permissions/targetValidation';
import { logAudit } from '../../utils/logger';
import { emitGuildEvent } from '../../dashboard/socket/emitter';
import { buildStatusEmbed, type EmbedStatus } from '../../utils/statusEmbed';

const DELEGABLE: PermissionScope[] = PERMISSION_SCOPES.filter(scope => !NON_DELEGABLE_SCOPES.has(scope));

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
    const guild = interaction.guild;
    if (!guild) {
      await statusReply(interaction, 'ERROR', 'Guild nicht aufloesbar', 'Der Discord-Server konnte nicht sicher aufgeloest werden.');
      return;
    }
    const member = await resolveDelegableUserTarget(guild, target.id);
    if (!member) {
      await statusReply(interaction, 'ERROR', 'Mitglied nicht erlaubt', 'Permissions koennen nur aktuellen Nicht-Bot-Mitgliedern dieses Servers erteilt werden.');
      return;
    }
    const rawPerm = interaction.options.getString('scope', true).trim();
    if (!isDelegablePermissionScope(rawPerm)) {
      await statusReply(interaction, 'ERROR', 'Permission nicht delegierbar', 'Waehle eine bekannte delegierbare Permission aus dem Autocomplete.');
      return;
    }
    const perm = rawPerm;
    const targetId = asUserDiscordId(target.id);

    const result = await mutatePermissionGrant({
      guildId: scope.guildId,
      targetKind: 'USER',
      targetId,
      action: 'GRANT',
      permission: perm,
      grantedBy: scope.actorDiscordId,
    });

    if (!result.changed) {
      await statusReply(interaction, 'INFO', 'Permission bereits vorhanden', `<@${target.id}> besitzt \`${perm}\` bereits.`);
      return;
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
    await statusReply(interaction, 'SUCCESS', 'Permission vergeben', `\`${perm}\` wurde <@${target.id}> fuer diesen Discord-Server vergeben.`);
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

    const result = await mutatePermissionGrant({
      guildId: scope.guildId,
      targetKind: 'USER',
      targetId,
      action: 'REVOKE',
      permission: perm,
      grantedBy: scope.actorDiscordId,
    });

    if (!result.existed) {
      await statusReply(interaction, 'INFO', 'Keine Permissions', `<@${target.id}> besitzt keinen User-Permission-Grant.`);
      return;
    }
    if (!result.changed) {
      await statusReply(interaction, 'INFO', 'Permission nicht vorhanden', `<@${target.id}> besitzt \`${perm}\` nicht.`);
      return;
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
    await statusReply(interaction, 'SUCCESS', 'Permission entzogen', `\`${perm}\` wurde <@${target.id}> fuer diesen Discord-Server entzogen.`);
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

    const rows = await prisma.guildPermissionGrant.findMany({
      where: { guildId: scope.guildId },
      orderBy: { updatedAt: 'desc' },
    });
    if (rows.length === 0) {
      await statusReply(interaction, 'INFO', 'Keine Grants', 'In diesem Discord-Server existieren keine User-Permission-Grants.');
      return;
    }

    const embeds: EmbedBuilder[] = [];
    for (let offset = 0; offset < rows.length; offset += 25) {
      const page = rows.slice(offset, offset + 25);
      const pageNo = Math.floor(offset / 25) + 1;
      const pageCount = Math.ceil(rows.length / 25);
      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(`Permission-Grants${pageCount > 1 ? ` · ${pageNo}/${pageCount}` : ''}`)
        .setDescription(`**${rows.length}** User-Grant(s) auf diesem Server`)
        .setTimestamp();
      for (const row of page) {
        const delegable = sanitizeDelegablePermissionScopes(row.permissions);
        embed.addFields({
          name: `User ${row.userDiscordId}`,
          value: delegable.length > 0 ? delegable.map(value => `\`${value}\``).join(' ').slice(0, 1024) : '_keine delegierbaren Permissions_',
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
