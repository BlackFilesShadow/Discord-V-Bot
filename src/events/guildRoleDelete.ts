import { Events, type Role } from 'discord.js';
import type { BotEvent } from '../types';
import prisma from '../database/prisma';
import { logger, logAudit } from '../utils/logger';

/**
 * Role-Grants referenzieren Discord-Rollen, nicht lokale DB-Entities. Wenn eine
 * Rolle geloescht wird, kann ihr Grant konstruktiv nie wieder wirksam werden.
 * Die Zeile wird deshalb best-effort sofort entfernt, damit kein Orphan im
 * Permission-Dashboard/DB-Scan verbleibt. Authorization bleibt unabhaengig
 * davon fail-closed, weil nur aktuell am Member vorhandene Rollen aufgeloest
 * werden.
 */
const guildRoleDeleteEvent: BotEvent = {
  name: Events.GuildRoleDelete,
  execute: async (role: unknown) => {
    const deletedRole = role as Role;
    try {
      const removed = await prisma.guildPermissionRoleGrant.deleteMany({
        where: {
          guildId: deletedRole.guild.id,
          roleDiscordId: deletedRole.id,
        },
      });
      if (removed.count > 0) {
        logAudit('PERM_ROLE_GRANT_REMOVED_ON_ROLE_DELETE', 'SECURITY', {
          guildId: deletedRole.guild.id,
          roleDiscordId: deletedRole.id,
          count: removed.count,
        });
      }
    } catch (error) {
      logger.error(
        `Role-Grant-Cleanup fehlgeschlagen (${deletedRole.id}@${deletedRole.guild.id}):`,
        error,
      );
    }
  },
};

export default guildRoleDeleteEvent;
