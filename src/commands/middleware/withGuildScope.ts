/**
 * `withGuildScope` — Wrapper fuer Slash-Command-Handler, der
 * **garantiert** einen vollstaendig validierten `GuildScope` an den
 * inneren Handler durchreicht.
 */

import type { ChatInputCommandInteraction, InteractionReplyOptions } from 'discord.js';
import { MessageFlags } from 'discord.js';
import prisma from '../../database/prisma';
import { asGuildId, asUserDiscordId, asNitradoConnId, hasCommandPermission } from '../../types/scope';
import type { GuildScope, NitradoConnId, PermissionScope } from '../../types/scope';
import { resolveGuildPermissionAccess } from '../../modules/permissions/access';
import {
  MAX_GAME_SERVERS_PER_GUILD,
  resolveOrPromptGameServerScope,
  type ScopeCandidate,
} from '../../modules/nitrado/gameServerScope';
import {
  assertEconomyScopeReady,
  EconomyMigrationRequiredError,
  EconomyScopeMismatchError,
} from '../../modules/economy/scopeMigration';
import { logger, logAudit } from '../../utils/logger';
import { buildStatusEmbed, type EmbedStatus } from '../../utils/statusEmbed';

export type ScopedHandler = (
  interaction: ChatInputCommandInteraction,
  scope: GuildScope,
) => Promise<void>;

export interface WithGuildScopeOptions {
  requirePerm?: PermissionScope;
  guildOnly?: boolean;
  acceptSlotOption?: boolean;
  requireSlotToggle?: 'whitelistActive' | 'economyActive';
}

const ECONOMY_GUARD_EXEMPT_COMMANDS = new Set(['link', 'unlink', 'force-link', 'force-unlink']);

function requiresLegacyEconomyGuard(commandName: string, opts: WithGuildScopeOptions): boolean {
  if (ECONOMY_GUARD_EXEMPT_COMMANDS.has(commandName)) return false;
  if (opts.requireSlotToggle === 'economyActive') return true;
  const perm = opts.requirePerm ?? '';
  return perm.startsWith('economy.') || perm.startsWith('casino.');
}

async function statusReply(
  interaction: ChatInputCommandInteraction,
  status: EmbedStatus,
  title: string,
  description: string,
  fields?: { name: string; value: string }[],
): Promise<void> {
  const payload: InteractionReplyOptions = {
    embeds: [buildStatusEmbed({ status, title, description, fields, footerText: 'V-Bot Command-System' })],
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  };
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp(payload).catch(() => undefined);
  } else {
    await interaction.reply(payload).catch(() => undefined);
  }
}

async function resolveCommandServerScope(
  interaction: ChatInputCommandInteraction,
  guildId: ReturnType<typeof asGuildId>,
  actorId: ReturnType<typeof asUserDiscordId>,
  acceptSlotOption: boolean,
): Promise<NitradoConnId | null> {
  const rows = await prisma.nitradoConnection.findMany({
    where: { guildId },
    select: { id: true, slot: true, alias: true, status: true, nitradoServerId: true },
    orderBy: [{ slot: 'asc' }, { id: 'asc' }],
  });

  const connections: ScopeCandidate[] = rows
    .filter(row => typeof row.nitradoServerId === 'string' && row.nitradoServerId.length > 0)
    .map(row => ({
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
        await statusReply(
          interaction,
          'ERROR',
          'Ungueltiger Gameserver-Slot',
          `Slot muss zwischen 1 und ${MAX_GAME_SERVERS_PER_GUILD} liegen. Historische Slots ausserhalb dieses Bereichs sind nur noch Legacy und fuer Mutationen gesperrt.`,
        );
        return null;
      }
      requestedNitradoConnId = connections.find(c => c.slot === requestedSlot)?.id;
      if (!requestedNitradoConnId) {
        await statusReply(interaction, 'ERROR', 'Gameserver nicht nutzbar', `Slot ${requestedSlot} ist nicht als aktiver Gameserver nutzbar.`);
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
      await statusReply(
        interaction,
        'ERROR',
        'Kein Gameserver verbunden',
        'Kein aktiver Nitrado-Gameserver ist konfiguriert. Bitte zuerst im Dashboard einen Slot mit einem Gameserver verbinden.',
      );
      return null;
    case 'SERVER_NOT_FOUND':
      await statusReply(interaction, 'ERROR', 'Gameserver nicht gefunden', 'Der ausgewaehlte Gameserver existiert nicht.');
      return null;
    case 'SERVER_INACTIVE':
      await statusReply(interaction, 'ERROR', 'Gameserver inaktiv', 'Der ausgewaehlte Gameserver ist nicht aktiv.');
      return null;
    case 'LEGACY_SLOT':
      await statusReply(
        interaction,
        'ERROR',
        'Legacy-Slot gesperrt',
        `Slot ${resolution.scope.slot} ist ein Legacy-Slot. Maximal ${MAX_GAME_SERVERS_PER_GUILD} aktive Gameserver sind erlaubt; migriere den Slot zuerst im Dashboard.`,
      );
      return null;
    case 'PROMPT_REQUIRED': {
      const options = resolution.options
        .map(s => `• Slot ${s.slot}: **${s.alias}**`)
        .join('\n');
      const instruction = acceptSlotOption
        ? 'Fuehre den Befehl erneut mit der Option `slot` aus.'
        : 'Dieser Befehl hat noch keine explizite Slot-Auswahl und wird deshalb sicherheitshalber nicht ausgefuehrt.';
      await statusReply(
        interaction,
        'INFO',
        'Gameserver auswaehlen',
        `Mehrere aktive Gameserver wurden gefunden. Eine explizite Auswahl ist erforderlich.\n\n${options}\n\n${instruction}`,
      );
      return null;
    }
  }
}

export function withGuildScope(opts: WithGuildScopeOptions, handler: ScopedHandler) {
  return async (interaction: ChatInputCommandInteraction): Promise<void> => {
    if (!interaction.inGuild() || !interaction.guildId) {
      await statusReply(interaction, 'ERROR', 'Server erforderlich', 'Dieser Befehl ist nur auf Discord-Servern verfuegbar.');
      return;
    }

    let guildId, actorId;
    try {
      guildId = asGuildId(interaction.guildId);
      actorId = asUserDiscordId(interaction.user.id);
    } catch {
      await statusReply(interaction, 'ERROR', 'Ungueltiger Kontext', 'Guild- oder User-ID konnte nicht sicher validiert werden.');
      return;
    }

    const guild = interaction.guild;
    if (!guild) {
      await statusReply(interaction, 'ERROR', 'Server nicht aufloesbar', 'Der Discord-Server konnte nicht sicher aufgeloest werden.');
      return;
    }

    let access;
    try {
      access = await resolveGuildPermissionAccess(guild, actorId);
    } catch (e) {
      logger.error('Guild-Permission-Aufloesung fehlgeschlagen:', e as Error);
      await statusReply(interaction, 'ERROR', 'Berechtigungen nicht aufloesbar', 'Die Server-Berechtigungen konnten nicht sicher geprueft werden.');
      return;
    }
    if (!access.isMember) {
      logAudit('CMD_STALE_MEMBER_DENIED', 'SECURITY', {
        guildId, actorId, command: interaction.commandName,
      });
      await statusReply(interaction, 'ERROR', 'Keine Server-Mitgliedschaft', 'Deine aktuelle Mitgliedschaft auf diesem Server konnte nicht bestaetigt werden.');
      return;
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
      isOwner: access.isOwner,
      permissions: access.permissions,
    };

    if (opts.requirePerm && !hasCommandPermission(scope, opts.requirePerm)) {
      logAudit('CMD_PERM_DENIED', 'SECURITY', {
        guildId, actorId, perm: opts.requirePerm, command: interaction.commandName,
      });
      await statusReply(
        interaction,
        'ERROR',
        'Keine Berechtigung',
        'Du darfst diese Aktion auf diesem Server nicht ausfuehren.',
        [{ name: 'Erforderliche Berechtigung', value: `\`${opts.requirePerm}\`` }],
      );
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
          whitelistActive: 'Das Whitelist-System ist fuer diesen Gameserver deaktiviert.',
          economyActive: 'Das Economy-System ist fuer diesen Gameserver deaktiviert.',
        };
        await statusReply(
          interaction,
          'ERROR',
          'Funktion deaktiviert',
          `${labels[opts.requireSlotToggle]} Aktivierung: Dashboard → Server → Slot → Server-Toggles.`,
        );
        return;
      }
    }

    if (nitradoConnId && requiresLegacyEconomyGuard(interaction.commandName, opts)) {
      try {
        await assertEconomyScopeReady(guildId, nitradoConnId);
      } catch (error) {
        if (error instanceof EconomyMigrationRequiredError || error instanceof EconomyScopeMismatchError) {
          logAudit('ECONOMY_SCOPE_BLOCKED', 'ECONOMY', {
            guildId,
            nitradoConnId,
            actorDiscordId: actorId,
            command: interaction.commandName,
            code: error.code,
          });
          await statusReply(
            interaction,
            'ERROR',
            'Economy-Scope nicht bereit',
            `${error.message}\n\nDie Economy wurde sicherheitshalber nicht gelesen oder veraendert.`,
          );
          return;
        }
        throw error;
      }
    }

    try {
      await handler(interaction, scope);
    } catch (err) {
      logger.error(`Slash-Cmd /${interaction.commandName} fehlgeschlagen:`, err as Error);
      logAudit('CMD_ERROR', 'COMMAND', {
        guildId,
        actorId,
        command: interaction.commandName,
        error: err instanceof Error ? err.message : String(err),
      });
      await statusReply(
        interaction,
        'ERROR',
        'Interner Fehler',
        'Die Aktion konnte wegen eines internen Fehlers nicht abgeschlossen werden. Bitte versuche es erneut oder informiere einen Administrator.',
      );
    }
  };
}

export function assertGuildScope(data: { guildId: string }, expectedGuildId: string): void {
  if (data.guildId !== expectedGuildId) {
    throw new Error(`Scope-Verstoss: Daten gehoeren zu ${data.guildId}, Kontext ist ${expectedGuildId}.`);
  }
}
