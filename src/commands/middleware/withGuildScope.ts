/**
 * `withGuildScope` — Wrapper fuer Slash-Command-Handler, der
 * **garantiert** einen vollstaendig validierten `GuildScope` an den
 * inneren Handler durchreicht.
 *
 * Garantien:
 *  1. interaction.guildId existiert (sonst ephemeral-Reply).
 *  2. ein aktiver Nitrado-Slot ist konfiguriert (oder per Option ausgewaehlt).
 *  3. Owner-Status + Permissions-Set ist aufgeloest.
 *  4. Falls `requirePerm` gesetzt: scoped Permission validiert.
 *  5. Bei Fehlern saubere ephemerale Replies, kein Leak von Stack-Traces.
 */

import type { ChatInputCommandInteraction } from 'discord.js';
import { MessageFlags } from 'discord.js';
import prisma from '../../database/prisma';
import { asGuildId, asUserDiscordId, asNitradoConnId, hasPermission } from '../../types/scope';
import type { GuildScope, NitradoConnId, PermissionScope } from '../../types/scope';
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
   * Falls true, akzeptiert die `slot`-Slash-Option als Override (1..5).
   * Sonst wird der "aktive" Slot der Guild benutzt (Lowest active slot).
   */
  acceptSlotOption?: boolean;
  /**
   * Wenn gesetzt: prueft ob das Toggle in `ServerSettings` (per Slot) `true` ist.
   * Ist es `false`, wird der Command mit einer freundlichen Meldung abgewiesen.
   * Greift nur, wenn `nitradoConnId` aufgeloest werden konnte (also nicht
   * fuer `guildOnly`-Commands).
   */
  requireSlotToggle?: 'whitelistActive' | 'economyActive';
}

async function resolveActiveSlotId(guildId: string, slotOverride?: number): Promise<NitradoConnId | null> {
  if (typeof slotOverride === 'number') {
    const row = await prisma.nitradoConnection.findUnique({
      where: { guildId_slot: { guildId, slot: slotOverride } },
      select: { id: true },
    });
    return row ? asNitradoConnId(row.id) : null;
  }
  // Default: kleinster aktiver Slot
  const row = await prisma.nitradoConnection.findFirst({
    where: { guildId, status: 'ACTIVE' },
    orderBy: { slot: 'asc' },
    select: { id: true },
  });
  return row ? asNitradoConnId(row.id) : null;
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

    // Owner-Check via Bot-Cache (Guild MUSS gecacht sein, sonst Fehler).
    const guild = interaction.guild;
    const isOwner = !!guild && guild.ownerId === actorId;

    let permsSet = new Set<PermissionScope>();
    if (!isOwner) {
      try {
        const grant = await prisma.guildPermissionGrant.findUnique({
          where: { guildId_userDiscordId: { guildId, userDiscordId: actorId } },
        });
        const list = Array.isArray(grant?.permissions) ? (grant!.permissions as string[]) : [];
        permsSet = new Set(list as PermissionScope[]);
      } catch (e) {
        logger.error('GuildPermissionGrant-Lookup fehlgeschlagen:', e as Error);
      }
    }

    let nitradoConnId: NitradoConnId | null = null;
    if (!opts.guildOnly) {
      const slotOpt = opts.acceptSlotOption ? interaction.options.getInteger('slot') ?? undefined : undefined;
      nitradoConnId = await resolveActiveSlotId(guildId, slotOpt);
      if (!nitradoConnId) {
        await interaction.reply({
          content: typeof slotOpt === 'number'
            ? `Slot ${slotOpt} existiert nicht in diesem Server.`
            : 'Kein aktiver Nitrado-Server konfiguriert. Bitte erst im Dashboard einen Slot anbinden.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
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

/**
 * Embed-Schutz: assert dass dieselbe guildId mitgegeben wurde, die
 * der Interaction-Kontext hat. Wirft sofort, wenn fremder Scope.
 */
export function assertGuildScope(data: { guildId: string }, expectedGuildId: string): void {
  if (data.guildId !== expectedGuildId) {
    throw new Error(`Scope-Verstoss: Daten geh\u00f6ren zu ${data.guildId}, Kontext ist ${expectedGuildId}.`);
  }
}
