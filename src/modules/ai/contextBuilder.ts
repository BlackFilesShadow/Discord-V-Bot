import type { Guild, GuildMember, User as DiscordUser, GuildBasedChannel } from 'discord.js';
import prisma from '../../database/prisma';
import { logger } from '../../utils/logger';
import { getGuildProfile } from './guildAwareness';

/**
 * Server-/User-Kontext-Block fuer den AI-Prompt.
 *
 * Ziel: Die AI weiss, AUF WELCHEM Server sie spricht und MIT WEM,
 * ohne dass die Aufrufer sich um die Detail-Beschaffung kuemmern muessen.
 *
 * Bewusst kompakt gehalten: maximal ~25 Zeilen, damit der Prompt nicht
 * unnoetig anwaechst. Reine Stammdaten + Level/Rolle, keine PII darueber hinaus.
 */
export interface ServerUserContextOptions {
  guild?: Guild | null;
  channel?: GuildBasedChannel | null;
  member?: GuildMember | null;
  user?: DiscordUser | null;
}

export async function buildServerUserContext(opts: ServerUserContextOptions): Promise<string | null> {
  const { guild, channel, member, user } = opts;

  const lines: string[] = [];

  // --- Server-Block ---------------------------------------------------------
  if (guild) {
    const serverParts: string[] = [
      `Servername: ${guild.name}`,
      `Mitglieder: ${guild.memberCount}`,
    ];
    // Owner: bevorzugt aus GuildProfile-Cache (kein Discord-API-Call), sonst fetchOwner.
    let ownerName: string | null = null;
    try {
      const profile = await getGuildProfile(guild.id);
      if (profile?.ownerName) ownerName = profile.ownerName;
      if (profile?.description) serverParts.push(`Beschreibung: ${profile.description.slice(0, 200)}`);
      if (profile?.preferredLocale) serverParts.push(`Sprache: ${profile.preferredLocale}`);
    } catch {
      /* optional */
    }
    if (!ownerName) {
      try {
        const owner = await guild.fetchOwner({ cache: true });
        if (owner) ownerName = owner.user.username;
      } catch {
        /* optional */
      }
    }
    if (ownerName) serverParts.push(`Owner: ${ownerName}`);
    if (channel && 'name' in channel && channel.name) {
      serverParts.push(`Kanal: #${channel.name}`);
    }
    lines.push('SERVER-KONTEXT:');
    for (const p of serverParts) lines.push(`- ${p}`);
  }

  // --- User-Block -----------------------------------------------------------
  const discordUser = user ?? member?.user;
  if (discordUser) {
    if (lines.length > 0) lines.push('');
    lines.push('USER-KONTEXT:');
    lines.push(`- Username: ${discordUser.username}`);
    if (member?.nickname && member.nickname !== discordUser.username) {
      lines.push(`- Server-Nickname: ${member.nickname}`);
    }
    if (member?.joinedAt) {
      lines.push(`- Auf dem Server seit: ${member.joinedAt.toISOString().slice(0, 10)}`);
    }
    if (member) {
      const topRoles = member.roles.cache
        .filter((r) => r.name !== '@everyone')
        .sort((a, b) => b.position - a.position)
        .first(3)
        .map((r) => r.name);
      if (topRoles.length > 0) lines.push(`- Top-Rollen: ${topRoles.join(', ')}`);
    }

    // Optionaler DB-Block (Bot-Rolle, Level/XP, Status). Best-effort.
    try {
      const dbUser = await prisma.user.findUnique({
        where: { discordId: discordUser.id },
        select: {
          role: true,
          status: true,
          isManufacturer: true,
          createdAt: true,
          levelData: { select: { level: true, xp: true, totalMessages: true } },
        },
      });
      if (dbUser) {
        lines.push(`- Bot-Rolle: ${dbUser.role}${dbUser.isManufacturer ? ' (Hersteller)' : ''}`);
        if (dbUser.status && dbUser.status !== 'ACTIVE') {
          lines.push(`- Status: ${dbUser.status}`);
        }
        if (dbUser.levelData) {
          const xpStr = dbUser.levelData.xp.toString();
          lines.push(`- Level: ${dbUser.levelData.level} (XP: ${xpStr}, Nachrichten: ${dbUser.levelData.totalMessages})`);
        }
      }
    } catch (e) {
      logger.warn('buildServerUserContext: DB-Lookup fehlgeschlagen:', { e: String(e) });
    }
  }

  if (lines.length === 0) return null;

  return [
    'AKTUELLER GESPRAECHSKONTEXT (verwende diese Daten, wenn der Nutzer nach Server, Kanal, sich selbst oder seinem Profil fragt; erfinde nichts):',
    '',
    lines.join('\n'),
  ].join('\n');
}
