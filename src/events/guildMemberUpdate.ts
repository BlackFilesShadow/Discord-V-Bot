import { Events, GuildMember } from 'discord.js';
import type { BotEvent } from '../types';
import { logger } from '../utils/logger';
import { syncDiscordUserIdentity, syncMemberProfile } from '../modules/ai/memberAwareness';

/**
 * User-1: Aktualisiert Recognition-Daten unmittelbar bei GuildMember-Aenderungen.
 *
 * Nickname, Rollen, Boost/Pending/Timeout und der vom Event bekannte Username
 * werden exakt fuer diese Guild persistiert. Persistierte Rollen bleiben reine
 * Kontext-/Historienwerte und werden niemals als Authorization verwendet.
 */
const guildMemberUpdateEvent: BotEvent = {
  name: Events.GuildMemberUpdate,
  execute: async (_oldMember: unknown, newMember: unknown) => {
    const member = newMember as GuildMember;
    try {
      await syncDiscordUserIdentity(member.user);
      await syncMemberProfile(member);
    } catch (error) {
      logger.warn(
        `guildMemberUpdate Recognition-Sync fehlgeschlagen (${member.user.id}@${member.guild.id}): ${String(error)}`,
      );
    }
  },
};

export default guildMemberUpdateEvent;
