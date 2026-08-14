/**
 * `withGuildScope` — Wrapper fuer Slash-Command-Handler, der
 * **garantiert** einen vollstaendig validierten `GuildScope` an den
 * inneren Handler durchreicht.
 *
 * Garantien:
 *  1. interaction.guildId existiert (sonst ephemeral-Reply).
 *  2. Gameserver-Scope wird NIE durch eine implizite "kleinster Slot"-Regel
 *     geraten: genau ein aktiver Slot darf automatisch aufgeloest werden;
 *     mehrere aktive Slots verlangen eine explizite Auswahl.
 *  3. Legacy-Slots > MAX_GAME_SERVERS_PER_GUILD werden fail-closed abgewiesen.
 *  4. Owner-Status + Permissions-Set ist aufgeloest.
 *  5. Falls `requirePerm` gesetzt: scoped Permission validiert.
 */

import type { ChatInputCommandInteraction } from 'discord.js';
import { MessageFlags } from 'discord.js';
import prisma from '../../database/prisma';
import { asGuildId, asUserDiscordId, asNitradoConnId, hasPermission } from '../../types/scope';
import type { GuildScope, NitradoConnId, PermissionScope } from '../../types/scope';
import {
  MAX_GAME_SERVERS_PER_GUILD,
  resolveOrPromptGameServerScope,
  type ScopeCandidate,
} from '../../modules/nitrado/gameServerScope';
import { logger, logAudit } from '../../utils/logger';

export type ScopedHandler = (
  interaction: ChatInputCommandInteraction,
  scope: GuildScope,
) => Promise<void>;

export interface WithGuildScopeOptions {
  /** Scope-Permission, die der Caller braucht. Owner umgeht alles. */
  requirePerm?: PermissionScope;
  /** Falls true, wird KEIN Nitrado-Slot aufgeloest (Guild-only Cmd, z.B. /perms). */
  guildOnly?: boolean;
  /**
   * Falls true, akzeptiert die `slot`-Slash-Option als explizite Auswahl
   * (1..MAX_GAME_SERVERS_PER_GUILD). Ohne Auswahl wird nur dann automatisch
   * aufgeloest, wenn exakt ein nutzbarer aktiver Server existiert.
   */
  acceptSlotOption?: boolean;
  /**
   * Wenn gesetzt: prueft ob das Toggle in `ServerSettings` (per Slot) `true` ist.
   */
  requireSlotToggle?: 'whitelistActive' | 'economyActive';
}

async function resolveCommandServerScope(
  interaction: ChatInputCommandInteraction,
  guildId: ReturnType<typeof asGuildId>,
  actorId: ReturnType<typeof asUserDiscordId>,
  acceptSlotOption: boolean,
): Promise<NitradoConnId | null> {
  const rows = await prisma.nitradoConnection.findMany({
    where: { guildId },
    select: { id: true, slot: true, alias: true, status: true },
    orderBy: [{ slot: 'asc' }, { id: 'asc' }],
  });
  const connections: ScopeCandidate[] = rows.map(row => ({
    id: asNitradoConnId(row.id),
    slot: row.slot,
    alias: row.alias,
    status: row.status,
  }));

  let requestedNitradoConnId: NitradoConnId | undefined;
  let requestedSlot: number | undefined;
  if (acceptSlotOption) {
    requestedSlot = interaction.options.getInteger('slot') ?? undefined;
    if (requestedSlot !== undefined) {
      if (requestedSlot < 1 || requestedSlot > MAX_GAME_SERVERS_PER_GUILD) {
        await interaction.reply({
          content: `Slot muss zwischen 1 und ${MAX_GAME_SERVERS_PER_GUILD} liegen. Historische Slots ausserhalb dieses Bereichs sind nur noch Legacy und fuer Mutationen gesperrt.`,
          flags: MessageFlags.Ephemeral,
        });
        return null;
      }
      requestedNitradoConnId = connections.find(c => c.slot === requestedSlot)?.id;
      if (!requestedNitradoConnId) {
        await interaction.reply({
          content: `Slot ${requestedSlot} existiert in diesem Discord-Server nicht.`,
          flags: MessageFlags.Ephemeral,
        });
        return null;
      }
    }
  }

  const resolution = resolveOrPromptGameServerScope({
    guildId,
    actorDiscordId: actorId,
    connections,
    requestedNitradoConnId,
  });

  switch (resolution.kind) {
    case 'RESOLVED':
      return resolution.scope.nitradoConnId;
    case 'NO_SERVER':
      await interaction.reply({
        content: 'Kein aktiver Nitrado-Server konfiguriert. Bitte zuerst im Dashboard einen Slot anbinden.',
        flags: MessageFlags.Ephemeral,
      });
      return null;
    case 'SERVER_NOT_FOUND':
      await interaction.reply({ content: 'Der ausgewaehlte Gameserver existiert nicht.', flags: MessageFlags.Ephemeral });
      return null;
    case 'SERVER_INACTIVE':
      await interaction.reply({ content: 'Der ausgewaehlte Gameserver ist nicht aktiv.', flags: MessageFlags.Ephemeral });
      return null;
    case 'LEGACY_SLOT':
      await interaction.reply({
        content: `Slot ${resolution.scope.slot} ist ein Legacy-Slot. Maximal ${MAX_GAME_SERVERS_PER_GUILD} aktive Gameserver sind erlaubt; migriere den Slot zuerst im Dashboard.`,
        flags: MessageFlags.Ephemeral,
      });
      return null;
    case 'PROMPT_REQUIRED': {
      const options = resolution.options
        .map(s => `• Slot ${s.slot}: **${s.alias}**`)
        .join('\n');
      const instruction = acceptSlotOption
        ? 'Fuehre den Befehl erneut mit der Option `slot` aus.'
        : 'Dieser Befehl hat noch keine explizite Slot-Auswahl und wird deshalb sicherheitshalber nicht ausgefuehrt.';
      await interaction.reply({
        content: `Mehrere aktive Gameserver gefunden. Eine explizite Auswahl ist erforderlich.\n${options}\n\n${instruction}`,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return null;
    }
  }
}

export function withGuildScope(opts: WithGuildScopeOptions, handler: ScopedHandler) {
  return async (interaction: ChatInputCommandInteraction): Promise<void> => {
    if (!interaction.inGuild() || !interaction.guildId) {
      await interaction.reply({
        content: 'Dieser Befehl ist nur in Servern verfuegbar.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    let guildId, actorId;
    try {
      guildId = asGuildId(interaction.guildId);
      actorId = asUserDiscordId(interaction.user.id);
    } catch {
      await interaction.reply({ content: 'Ungueltige Guild- oder User-ID.', flags: MessageFlags.Ephemeral });
      return;
    }

    const guild = interaction.guild;
    const isOwner = !!guild && guild.ownerId === actorId;

    const permsSet = new Set<PermissionScope>();
    if (!isOwner) {
      try {
        const grant = await prisma.guildPermissionGrant.findUnique({
          where: { guildId_userDiscordId: { guildId, userDiscordId: actorId } },
        });
        const list = Array.isArray(grant?.permissions) ? (grant!.permissions as string[]) : [];
        for (const s of list) permsSet.add(s as PermissionScope);
      } catch (e) {
        logger.error('GuildPermissionGrant-Lookup fehlgeschlagen:', e as Error);
      }
      try {
        const member = guild?.members.cache.get(actorId)
          ?? (guild ? await guild.members.fetch(actorId).catch(() => null) : null);
        const roleIds = member ? Array.from(member.roles.cache.keys()) : [];
        if (roleIds.length > 0) {
          const roleGrants = await prisma.guildPermissionRoleGrant.findMany({
            where: { guildId, roleDiscordId: { in: roleIds } },
            select: { permissions: true },
          });
          for (const r of roleGrants) {
            const arr = Array.isArray(r.permissions) ? (r.permissions as string[]) : [];
            for (const s of arr) permsSet.add(s as PermissionScope);
          }
        }
      } catch (e) {
        logger.warn('GuildPermissionRoleGrant-Lookup fehlgeschlagen:', e as Error);
      }
    }

    let nitradoConnId: NitradoConnId | null = null;
    if (!opts.guildOnly) {
      nitradoConnId = await resolveCommandServerScope(
        interaction,
        guildId,
        actorId,
        opts.acceptSlotOption === true,
      );
      if (!nitradoConnId) return;
    }

    const scope: GuildScope = {
      guildId,
      nitradoConnId,
      actorDiscordId: actorId,
      isOwner,
      permissions: permsSet,
    };

    if (opts.requirePerm && !hasPermission(scope, opts.requirePerm)) {
      logAudit('CMD_PERM_DENIED', 'SECURITY', {
        guildId, actorId, perm: opts.requirePerm, command: interaction.commandName,
      });
      await interaction.reply({
        content: `Dir fehlt die Berechtigung: \`${opts.requirePerm}\``,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (opts.requireSlotToggle && nitradoConnId) {
      const settings = await prisma.serverSettings.findUnique({
        where: { guildId_nitradoConnId: { guildId, nitradoConnId } },
        select: { whitelistActive: true, economyActive: true },
      });
      const enabled = settings ? settings[opts.requireSlotToggle] : false;
      if (!enabled) {
        const labels: Record<string, string> = {
          whitelistActive: 'Das Whitelist-System ist fuer diesen Server deaktiviert.',
          economyActive: 'Das Economy-System ist fuer diesen Server deaktiviert.',
        };
        await interaction.reply({
          content: `${labels[opts.requireSlotToggle]} Aktivierung im Dashboard → Server → Slot → Server-Toggles.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }

    try {
      await handler(interaction, scope);
    } catch (err) {
      logger.error(`Slash-Cmd /${interaction.commandName} fehlgeschlagen:`, err as Error);
      logAudit('CMD_ERROR', 'COMMAND', {
        guildId, actorId, command: interaction.commandName,
        error: (err as Error).message,
      });
      const msg = err instanceof Error ? err.message : 'Unbekannter Fehler.';
      const reply = { content: `Fehler: ${msg}`, flags: MessageFlags.Ephemeral } as const;
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(reply).catch(() => undefined);
      } else {
        await interaction.reply(reply).catch(() => undefined);
      }
    }
  };
}

/** Embed-Schutz gegen fremden Guild-Scope. */
export function assertGuildScope(data: { guildId: string }, expectedGuildId: string): void {
  if (data.guildId !== expectedGuildId) {
    throw new Error(`Scope-Verstoss: Daten gehoeren zu ${data.guildId}, Kontext ist ${expectedGuildId}.`);
  }
}
