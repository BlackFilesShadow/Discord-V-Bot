/**
 * Guild-Permissions.
 *
 * Invarianten:
 * - ausschliesslich Guild-Owner duerfen User-Grants veraendern/einsehen;
 * - NON_DELEGABLE_SCOPES werden weder Autocomplete noch freier Eingabe akzeptiert;
 * - Read/Modify/Write auf dem JSON-Permissionsarray laeuft SERIALIZABLE mit
 *   Retry, damit parallele Grants/Revokes keinen Lost-Update erzeugen;
 * - /perms listet alle Grants ueber mehrere Embeds statt still nach 50 zu enden.
 */

import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  EmbedBuilder,
  MessageFlags,
} from 'discord.js';
import { Prisma } from '@prisma/client';
import type { Command } from '../../types';
import prisma from '../../database/prisma';
import { withGuildScope } from '../middleware/withGuildScope';
import {
  PERMISSION_SCOPES,
  NON_DELEGABLE_SCOPES,
  asUserDiscordId,
} from '../../types/scope';
import type { PermissionScope } from '../../types/scope';
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

async function serializableGrantMutation<T>(
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await prisma.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      const retryable = code === 'P2034' || code === 'P2002';
      if (!retryable || attempt === maxAttempts) throw error;
    }
  }
  throw new Error('Permission-Transaktion konnte nicht abgeschlossen werden.');
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
    const rawPerm = interaction.options.getString('scope', true).trim();
    if (!isDelegablePermissionScope(rawPerm)) {
      await statusReply(interaction, 'ERROR', 'Permission nicht delegierbar', 'Waehle eine bekannte delegierbare Permission aus dem Autocomplete.');
      return;
    }
    const perm = rawPerm;
    const targetId = asUserDiscordId(target.id);

    const result = await serializableGrantMutation(async tx => {
      const existing = await tx.guildPermissionGrant.findUnique({
        where: { guildId_userDiscordId: { guildId: scope.guildId, userDiscordId: targetId } },
      });
      const current = Array.isArray(existing?.permissions) ? (existing!.permissions as string[]) : [];
      const set = new Set<string>(current.filter(value => !NON_DELEGABLE_SCOPES.has(value as PermissionScope)));
      if (set.has(perm)) return 'already' as const;
      set.add(perm);
      const permissions = [...set].sort();

      await tx.guildPermissionGrant.upsert({
        where: { guildId_userDiscordId: { guildId: scope.guildId, userDiscordId: targetId } },
        create: {
          guildId: scope.guildId,
          userDiscordId: targetId,
          permissions,
          grantedByDiscordId: scope.actorDiscordId,
        },
        update: { permissions, grantedByDiscordId: scope.actorDiscordId },
      });
      return 'changed' as const;
    });

    if (result === 'already') {
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

    const result = await serializableGrantMutation(async tx => {
      const existing = await tx.guildPermissionGrant.findUnique({
        where: { guildId_userDiscordId: { guildId: scope.guildId, userDiscordId: targetId } },
      });
      if (!existing) return 'no-grant' as const;

      const current = Array.isArray(existing.permissions) ? (existing.permissions as string[]) : [];
      const hadPermission = current.includes(perm);
      if (!hadPermission) return 'missing' as const;
      const filtered = current
        .filter(value => value !== perm && !NON_DELEGABLE_SCOPES.has(value as PermissionScope))
        .sort();

      if (filtered.length === 0) {
        await tx.guildPermissionGrant.delete({
          where: { guildId_userDiscordId: { guildId: scope.guildId, userDiscordId: targetId } },
        });
      } else {
        await tx.guildPermissionGrant.update({
          where: { guildId_userDiscordId: { guildId: scope.guildId, userDiscordId: targetId } },
          data: { permissions: filtered, grantedByDiscordId: scope.actorDiscordId },
        });
      }
      return 'changed' as const;
    });

    if (result === 'no-grant') {
      await statusReply(interaction, 'INFO', 'Keine Permissions', `<@${target.id}> besitzt keinen User-Permission-Grant.`);
      return;
    }
    if (result === 'missing') {
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
        const permissions = Array.isArray(row.permissions) ? (row.permissions as string[]) : [];
        const delegable = permissions.filter(value => !NON_DELEGABLE_SCOPES.has(value as PermissionScope));
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
