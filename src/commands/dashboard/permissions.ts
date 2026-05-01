/**
 * Phase 3 — Permissions-Commands (3 Stueck). Owner-only via withGuildScope
 * (Owner-Bypass deckt `permissions.manage` ab; NON_DELEGABLE_SCOPES sind
 * weder im Choice-Set noch ueber DB-Schmuggel akzeptiert).
 */

import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, MessageFlags,
} from 'discord.js';
import type { Command } from '../../types';
import prisma from '../../database/prisma';
import { withGuildScope } from '../middleware/withGuildScope';
import {
  PERMISSION_SCOPES, NON_DELEGABLE_SCOPES, asUserDiscordId,
} from '../../types/scope';
import type { PermissionScope } from '../../types/scope';
import { logAudit } from '../../utils/logger';
import { emitGuildEvent } from '../../dashboard/socket/emitter';

async function reply(i: ChatInputCommandInteraction, content: string, ephemeral = true): Promise<void> {
  if (ephemeral) await i.reply({ content, flags: MessageFlags.Ephemeral });
  else await i.reply({ content });
}

const DELEGABLE: PermissionScope[] = PERMISSION_SCOPES.filter(s => !NON_DELEGABLE_SCOPES.has(s));
const PERM_CHOICES = DELEGABLE.map(s => ({ name: s, value: s }));

// ============================================================
// /perm-add
// ============================================================
export const permAddCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('perm-add')
    .setDescription('Owner: Vergibt einem User eine Scope-Permission fuer diesen Server.')
    .addUserOption(o => o.setName('user').setDescription('Ziel-User').setRequired(true))
    .addStringOption(o => o.setName('scope').setDescription('Permission').setRequired(true).addChoices(...PERM_CHOICES)) as SlashCommandBuilder,
  execute: withGuildScope({ guildOnly: true, requirePerm: 'permissions.manage' }, async (i, scope) => {
    if (!scope.isOwner) { await reply(i, 'Nur der Server-Owner kann Permissions vergeben.'); return; }
    const target = i.options.getUser('user', true);
    if (target.bot) { await reply(i, 'Bots koennen keine Permissions erhalten.'); return; }
    const perm = i.options.getString('scope', true) as PermissionScope;
    if (NON_DELEGABLE_SCOPES.has(perm)) { await reply(i, `\`${perm}\` ist nicht delegierbar.`); return; }

    const existing = await prisma.guildPermissionGrant.findUnique({
      where: { guildId_userDiscordId: { guildId: scope.guildId, userDiscordId: asUserDiscordId(target.id) } },
    });
    const current = Array.isArray(existing?.permissions) ? (existing!.permissions as string[]) : [];
    const set = new Set<string>(current.filter(p => !NON_DELEGABLE_SCOPES.has(p as PermissionScope)));
    if (set.has(perm)) { await reply(i, 'User hat diese Permission bereits.'); return; }
    set.add(perm);
    const arr = [...set];

    await prisma.guildPermissionGrant.upsert({
      where: { guildId_userDiscordId: { guildId: scope.guildId, userDiscordId: asUserDiscordId(target.id) } },
      create: {
        guildId: scope.guildId, userDiscordId: target.id,
        permissions: arr, grantedByDiscordId: scope.actorDiscordId,
      },
      update: { permissions: arr, grantedByDiscordId: scope.actorDiscordId },
    });
    logAudit('PERM_GRANTED', 'SECURITY', { guildId: scope.guildId, target: target.id, perm, actor: scope.actorDiscordId });
    emitGuildEvent(scope.guildId, { type: 'permissions.updated', payload: { guildId: scope.guildId, userDiscordId: target.id } });
    await reply(i, `\`${perm}\` an <@${target.id}> vergeben.`);
  }),
};

// ============================================================
// /perm-remove
// ============================================================
export const permRemoveCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('perm-remove')
    .setDescription('Owner: Entzieht eine Scope-Permission.')
    .addUserOption(o => o.setName('user').setDescription('Ziel-User').setRequired(true))
    .addStringOption(o => o.setName('scope').setDescription('Permission').setRequired(true).addChoices(...PERM_CHOICES)) as SlashCommandBuilder,
  execute: withGuildScope({ guildOnly: true, requirePerm: 'permissions.manage' }, async (i, scope) => {
    if (!scope.isOwner) { await reply(i, 'Nur der Server-Owner kann Permissions entziehen.'); return; }
    const target = i.options.getUser('user', true);
    const perm = i.options.getString('scope', true) as PermissionScope;
    const existing = await prisma.guildPermissionGrant.findUnique({
      where: { guildId_userDiscordId: { guildId: scope.guildId, userDiscordId: asUserDiscordId(target.id) } },
    });
    if (!existing) { await reply(i, 'User hat keine Permissions.'); return; }
    const current = Array.isArray(existing.permissions) ? (existing.permissions as string[]) : [];
    const filtered = current.filter(p => p !== perm && !NON_DELEGABLE_SCOPES.has(p as PermissionScope));
    if (filtered.length === current.length) { await reply(i, 'User hatte diese Permission nicht.'); return; }

    if (filtered.length === 0) {
      await prisma.guildPermissionGrant.delete({
        where: { guildId_userDiscordId: { guildId: scope.guildId, userDiscordId: asUserDiscordId(target.id) } },
      });
    } else {
      await prisma.guildPermissionGrant.update({
        where: { guildId_userDiscordId: { guildId: scope.guildId, userDiscordId: asUserDiscordId(target.id) } },
        data: { permissions: filtered, grantedByDiscordId: scope.actorDiscordId },
      });
    }
    logAudit('PERM_REVOKED', 'SECURITY', { guildId: scope.guildId, target: target.id, perm, actor: scope.actorDiscordId });
    emitGuildEvent(scope.guildId, { type: 'permissions.updated', payload: { guildId: scope.guildId, userDiscordId: target.id } });
    await reply(i, `\`${perm}\` von <@${target.id}> entzogen.`);
  }),
};

// ============================================================
// /perms
// ============================================================
export const permsCommand: Command = {
  data: new SlashCommandBuilder().setName('perms').setDescription('Owner: Listet alle Permission-Grants in diesem Server.'),
  execute: withGuildScope({ guildOnly: true, requirePerm: 'permissions.manage' }, async (i, scope) => {
    if (!scope.isOwner) { await reply(i, 'Nur der Server-Owner kann Permissions einsehen.'); return; }
    const rows = await prisma.guildPermissionGrant.findMany({
      where: { guildId: scope.guildId }, orderBy: { updatedAt: 'desc' }, take: 50,
    });
    if (rows.length === 0) { await reply(i, '_keine Grants_'); return; }
    const lines = rows.map(r => {
      const perms = Array.isArray(r.permissions) ? (r.permissions as string[]) : [];
      return `<@${r.userDiscordId}> — ${perms.length === 0 ? '_(leer)_' : perms.map(p => `\`${p}\``).join(' ')}`;
    }).join('\n');
    const e = new EmbedBuilder().setTitle(`Permission-Grants (${rows.length})`).setDescription(lines.slice(0, 4000));
    await i.reply({ embeds: [e], flags: MessageFlags.Ephemeral });
  }),
};
