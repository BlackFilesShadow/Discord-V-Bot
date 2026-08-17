import { Events, User } from 'discord.js';
import type { BotEvent } from '../types';
import { logger } from '../utils/logger';
import { syncDiscordUserIdentity, syncMemberProfile } from '../modules/ai/memberAwareness';

/**
 * User-1: Globaler Discord-Rename.
 *
 * Der globale Username wird im vorhandenen User-Stamm aktualisiert. Fuer jede
 * aktuell im Client-Cache bestaetigte Guild-Mitgliedschaft wird danach das
 * jeweilige GuildMemberProfile aus genau diesem GuildMember neu aufgebaut.
 * Dadurch bleiben Nickname und Rollen strikt pro Guild getrennt.
 */
const userUpdateEvent: BotEvent = {
  name: Events.UserUpdate,
  execute: async (_oldUser: unknown, newUserValue: unknown) => {
    const user = newUserValue as User;
    try {
      await syncDiscordUserIdentity(user);

      for (const guild of user.client.guilds.cache.values()) {
        const member = guild.members.cache.get(user.id);
        if (!member) continue;
        await syncMemberProfile(member);
      }
    } catch (error) {
      logger.warn(`userUpdate Recognition-Sync fehlgeschlagen (${user.id}): ${String(error)}`);
    }
  },
};

export default userUpdateEvent;
