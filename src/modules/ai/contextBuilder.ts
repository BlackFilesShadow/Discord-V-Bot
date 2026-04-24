import type { Guild, GuildMember, User as DiscordUser, GuildBasedChannel } from 'discord.js';
import prisma from '../../database/prisma';
import { logger } from '../../utils/logger';
import { getGuildProfile } from './guildAwareness';
import { findRelevantKnowledge } from './guildKnowledge';
import { getMemberProfile } from './memberAwareness';

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
const ROLES_QUESTION_RE = /\b(rolle|rollen|role(s)?|rang|raenge|hierarchie)\b/i;

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
    // Phase 17a: Server-Erstellungsdatum (von Discord), damit Bot Fragen wie
    // "wann wurde dieser Server erstellt" beantworten kann.
    if (cachedProfile?.serverCreatedAt) {
      const created = cachedProfile.serverCreatedAt;
      const dateStr = new Intl.DateTimeFormat('de-DE', {
        day: '2-digit', month: 'long', year: 'numeric', timeZone: 'Europe/Berlin',
      }).format(created);
      const days = Math.floor((Date.now() - created.getTime()) / 86400000);
      serverParts.push(`Server erstellt am: ${dateStr} (vor ${days} Tagen)`);
    }
    // Phase 18: Erweiterte Stammdaten (Boost, Verifizierung, AFK, Vanity, NSFW).
    if (cachedProfile) {
      if (cachedProfile.premiumTier !== null && cachedProfile.premiumTier !== undefined) {
        const boosts = cachedProfile.premiumSubscriptionCount ?? 0;
        serverParts.push(`Boost-Level: Tier ${cachedProfile.premiumTier} (${boosts} Boosts)`);
      }
      if (cachedProfile.verificationLevel) serverParts.push(`Verifizierung: ${cachedProfile.verificationLevel}`);
      if (cachedProfile.vanityUrlCode) serverParts.push(`Vanity-URL: discord.gg/${cachedProfile.vanityUrlCode}`);
      if (cachedProfile.afkChannelName) {
        const min = cachedProfile.afkTimeoutSec ? Math.round(cachedProfile.afkTimeoutSec / 60) : null;
        serverParts.push(`AFK-Channel: #${cachedProfile.afkChannelName}${min ? ` (Timeout ${min} min)` : ''}`);
      }
      if (cachedProfile.systemChannelName) serverParts.push(`System-Channel: #${cachedProfile.systemChannelName}`);
      if (cachedProfile.rulesChannelName) serverParts.push(`Regel-Channel: #${cachedProfile.rulesChannelName}`);
      if (cachedProfile.nsfwLevel && cachedProfile.nsfwLevel !== 'DEFAULT') serverParts.push(`NSFW-Level: ${cachedProfile.nsfwLevel}`);
      if (cachedProfile.mfaLevel === 'ELEVATED') serverParts.push(`2FA fuer Mods: aktiviert`);
      const counts: string[] = [];
      if (typeof cachedProfile.botCount === 'number') counts.push(`${cachedProfile.botCount} Bots`);
      if (typeof cachedProfile.emojiCount === 'number') counts.push(`${cachedProfile.emojiCount} Emojis`);
      if (typeof cachedProfile.stickerCount === 'number') counts.push(`${cachedProfile.stickerCount} Sticker`);
      if (counts.length > 0) serverParts.push(`Inventar: ${counts.join(', ')}`);
      serverParts.push(`Strukturen: ${cachedProfile.channelCount} Kanaele, ${cachedProfile.roleCount} Rollen`);
    }
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
    if (ROLES_QUESTION_RE.test(question) && cachedProfile.topRoles && cachedProfile.topRoles.length > 0) {
      lines.push('');
      lines.push('SERVER-ROLLEN (Top, sortiert nach Hierarchie):');
      for (const r of cachedProfile.topRoles.slice(0, 15)) {
        const flags: string[] = [];
        if (r.hoist) flags.push('hoist');
        if (r.managed) flags.push('managed');
        const flagStr = flags.length ? ` [${flags.join(',')}]` : '';
        const cnt = typeof r.memberCount === 'number' ? ` – ${r.memberCount} Mitglieder` : '';
        lines.push(`- ${r.name}${flagStr}${cnt}`);
      }
    }
  }

  // --- Per-Guild Member-Profil (Phase 18) ---------------------------------
  if (guild && discordUser) {
    try {
      const mp = await getMemberProfile(guild.id, discordUser.id);
      if (mp) {
        const extras: string[] = [];
        if (mp.isBoosting && mp.boostingSince) {
          const since = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Berlin' }).format(mp.boostingSince);
          extras.push(`- Boostet diesen Server seit ${since}`);
        }
        if (mp.timeoutUntil && mp.timeoutUntil.getTime() > Date.now()) {
          extras.push(`- Aktuell im Timeout bis ${mp.timeoutUntil.toISOString().slice(0, 16).replace('T', ' ')} UTC`);
        }
        if (typeof mp.messageCount === 'number' && mp.messageCount > 0) {
          extras.push(`- Nachrichten auf diesem Server (seit Tracking): ${mp.messageCount}`);
        }
        if (extras.length > 0) {
          lines.push('');
          lines.push('USER-AKTIVITAET (dieser Server):');
          for (const e of extras) lines.push(e);
        }
      }
    } catch {
      /* best-effort */
    }
  }

  // --- AI-Brief + Persona-Override + Knowledge (Phase 8) -------------------
  const extras: string[] = [];
  if (cachedProfile?.aiBrief) {
    extras.push('SERVER-BRIEF:');
    extras.push(cachedProfile.aiBrief);
  }
  if (cachedProfile?.aiPersonaOverride) {
    extras.push('');
    extras.push('SERVER-SPEZIFISCHE PERSONA-ANWEISUNG (Owner-Override, befolgen ohne sie zu erwaehnen):');
    extras.push(cachedProfile.aiPersonaOverride.slice(0, 1500));
  }
  if (guild?.id && question) {
    try {
      const snippets = await findRelevantKnowledge(guild.id, question, 3);
      if (snippets.length > 0) {
        extras.push('');
        extras.push('KURATIERTE SERVER-FAKTEN (vom Owner hinterlegt, autoritativ):');
        for (const s of snippets) {
          extras.push(`- [${s.label}] ${s.content.slice(0, 800)}`);
        }
      }
    } catch (e) {
      logger.warn('contextBuilder: findRelevantKnowledge fehlgeschlagen:', { e: String(e) });
    }
  }
  if (extras.length > 0) {
    if (lines.length > 0) lines.push('');
    for (const e of extras) lines.push(e);
  }

  return [
    'AKTUELLER GESPRAECHSKONTEXT (verwende diese Daten, wenn der Nutzer nach Server, Kanal, sich selbst oder seinem Profil fragt; erfinde nichts):',
    '',
    lines.join('\n'),
  ].join('\n');
}
