import type { Guild, GuildMember, Role } from 'discord.js';

export async function resolveDelegableUserTarget(
  guild: Guild,
  userDiscordId: string,
): Promise<GuildMember | null> {
  const member = guild.members.cache.get(userDiscordId)
    ?? await guild.members.fetch(userDiscordId).catch(() => null);
  if (!member || member.user.bot) return null;
  return member;
}

export async function resolveDelegableRoleTarget(
  guild: Guild,
  roleDiscordId: string,
): Promise<Role | null> {
  if (roleDiscordId === guild.id) return null;
  const role = guild.roles.cache.get(roleDiscordId)
    ?? await guild.roles.fetch(roleDiscordId).catch(() => null);
  if (!role || role.managed || role.id === guild.id) return null;
  return role;
}
