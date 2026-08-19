/**
 * Guild-Permissions.
 *
 * Invarianten:
 * - ausschliesslich Guild-Owner duerfen User-Grants veraendern/einsehen;
 * - NON_DELEGABLE_SCOPES werden weder Autocomplete noch freier Eingabe akzeptiert;
 * - Dashboard und Slashcommands nutzen EXAKT dasselbe serialisierte Repository;
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
import { getGrant, listGrants, setGrantScope } from '../../modules/permissions/repository';
import { logAudit } from '../../utils/logger';
import { emitGuildEvent } from '../../dashboard/socket/emitter';
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

    const rawPerm = interaction.options.getString('scope', true).trim();
    if (!isDelegablePermissionScope(rawPerm)) {
      await statusReply(interaction, 'ERROR', 'Permission nicht delegierbar', 'Waehle eine bekannte delegierbare Permission aus dem Autocomplete.');
      return;
    }
    const perm = rawPerm;
    const targetId = asUserDiscordId(target.id);
    const before = await getGrant(scope.guildId, targetId);
    if (before?.permissions.includes(perm)) {
      await statusReply(interaction, 'INFO', 'Permission bereits vorhanden', `<@${target.id}> besitzt \`${perm}\` bereits.`);
      return;
    }

    await setGrantScope(scope.guildId, targetId, perm, true, scope.actorDiscordId);
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
    const before = await getGrant(scope.guildId, targetId);
    if (!before) {
      await statusReply(interaction, 'INFO', 'Keine Permissions', `<@${target.id}> besitzt keinen User-Permission-Grant.`);
      return;
    }
    if (!before.permissions.includes(perm)) {
      await statusReply(interaction, 'INFO', 'Permission nicht vorhanden', `<@${target.id}> besitzt \`${perm}\` nicht.`);
      return;
    }

    await setGrantScope(scope.guildId, targetId, perm, false, scope.actorDiscordId);
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
      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
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
