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
  /**
   * Phase 7: Original-Frage des Nutzers. Wird genutzt, um Kanal-/Regel-Snapshot
   * nur bei thematisch passenden Anfragen einzublenden (Token-Schutz).
   */
  question?: string | null;
}

const CHANNELS_QUESTION_RE = /\b(kanal|kanaele|kanäle|channel(s)?|wo (kann|finde|soll)|welcher channel|welcher kanal|in welchem)\b/i;
const RULES_QUESTION_RE = /\b(regel|regeln|rules|regelwerk|verhalten|kodex|netiquette|verboten|erlaubt)\b/i;

export async function buildServerUserContext(opts: ServerUserContextOptions): Promise<string | null> {
  const { guild, channel, member, user, question } = opts;

  const lines: string[] = [];

  // --- Server-Block ---------------------------------------------------------
  let cachedProfile: Awaited<ReturnType<typeof getGuildProfile>> = null;
  if (guild) {
    const serverParts: string[] = [
      `Servername: ${guild.name}`,
      `Mitglieder: ${guild.memberCount}`,
    ];
    // Owner: bevorzugt aus GuildProfile-Cache (kein Discord-API-Call), sonst fetchOwner.
    let ownerName: string | null = null;
    try {
      cachedProfile = await getGuildProfile(guild.id);
      if (cachedProfile?.ownerName) ownerName = cachedProfile.ownerName;
      if (cachedProfile?.description) serverParts.push(`Beschreibung: ${cachedProfile.description.slice(0, 200)}`);
      if (cachedProfile?.preferredLocale) serverParts.push(`Sprache: ${cachedProfile.preferredLocale}`);
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

  // --- Channels-/Rules-Block (Phase 7) -------------------------------------
  // Nur einblenden, wenn die Frage thematisch passt – sonst Token-Verschwendung.
  if (cachedProfile && question) {
    if (CHANNELS_QUESTION_RE.test(question) && cachedProfile.channels && cachedProfile.channels.length > 0) {
      const grouped: Record<string, string[]> = {};
      for (const c of cachedProfile.channels) {
        const key = c.parent ?? '(ohne Kategorie)';
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(`#${c.name} (${c.type})`);
      }
      const out: string[] = [];
      for (const [cat, list] of Object.entries(grouped)) {
        out.push(`${cat}: ${list.slice(0, 12).join(', ')}`);
        if (out.join('\n').length > 1500) break;
      }
      lines.push('');
      lines.push('SERVER-KANAELE (Snapshot):');
      for (const o of out) lines.push(`- ${o}`);
    }
    if (RULES_QUESTION_RE.test(question) && cachedProfile.rulesText) {
      lines.push('');
      lines.push('SERVER-REGELN (Snapshot, Auszug):');
      lines.push(cachedProfile.rulesText.slice(0, 2000));
    }
  }

  return [
    'AKTUELLER GESPRAECHSKONTEXT (verwende diese Daten, wenn der Nutzer nach Server, Kanal, sich selbst oder seinem Profil fragt; erfinde nichts):',
    '',
    lines.join('\n'),
  ].join('\n');
}
