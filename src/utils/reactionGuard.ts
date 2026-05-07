/**
 * Reaction-Event-Guard.
 *
 * Zweck (P0-Hardening): Zentralisiert die Validierung von Reaction-Events
 * vor dem teuren DB-Pfad. Verhindert:
 *   - DB-Spam durch Bot-User (separate Hard-Filter ist sowieso da, hier nur
 *     defense-in-depth).
 *   - Cross-Guild-Leakage (DM-Reactions ohne guildId schlagen sonst potenziell
 *     auf Guild-Tabellen durch).
 *   - Reactions von ex-Members (User hat Guild verlassen → Membership-Fetch
 *     schlaegt fehl → Skip statt Logging-Spam).
 *   - Spam-Reactions (Per-User-Per-Message Token-Bucket).
 *
 * Nutzt den vorhandenen `tokenBucketAllow` aus rateLimit.ts. Der Bucket ist
 * pro (userId:messageId) gehasht und zeitlich extrem grosszuegig (10 Reactions
 * pro 10s) — er greift nur bei aggressivem Auto-Click-Spam.
 */
import type { GuildMember, MessageReaction, PartialMessageReaction, PartialUser, User } from 'discord.js';
import { logger } from './logger';

/**
 * Mini Token-Bucket fuer Reactions. Pro Key (z.B. user:msg) `capacity` Tokens
 * in `windowMs` ms; aelter Eintraege werden lazy bereinigt. Memory bounded
 * durch Map-Size-Cap (10k Keys → ~250KB Worst-Case bei langen Strings).
 */
const reactionBuckets = new Map<string, number[]>();
const BUCKETS_MAX = 10_000;
function tokenBucketAllow(key: string, capacity: number, windowMs: number): boolean {
  const now = Date.now();
  const arr = reactionBuckets.get(key) ?? [];
  const filtered = arr.filter(t => now - t < windowMs);
  if (filtered.length >= capacity) {
    reactionBuckets.set(key, filtered);
    return false;
  }
  filtered.push(now);
  reactionBuckets.set(key, filtered);
  // Lazy GC: wenn Cap erreicht, aeltesten 10 % der Keys verwerfen.
  if (reactionBuckets.size > BUCKETS_MAX) {
    const drop = Math.ceil(BUCKETS_MAX * 0.1);
    let i = 0;
    for (const k of reactionBuckets.keys()) {
      reactionBuckets.delete(k);
      if (++i >= drop) break;
    }
  }
  return true;
}

export interface ReactionGuardResult {
  ok: boolean;
  /** Pre-fetched GuildMember falls vorhanden (Optimierung fuer downstream). */
  member?: GuildMember;
  /** Vollstaendiger User (nach evtl. .fetch()), nie ein Partial. */
  fullUser?: User;
  /** Grund der Ablehnung — nur fuer Logging/Debug. */
  reason?: 'bot' | 'partial_fetch_failed' | 'no_guild' | 'not_member' | 'rate_limited';
}

/**
 * Validiert eine Reaction. Liefert ok=false (mit reason) wenn die Reaction
 * verworfen werden soll. Bei ok=true sind member + fullUser optional vorgefuellt.
 */
export async function validateReaction(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
  opts: { requireGuild?: boolean } = { requireGuild: true },
): Promise<ReactionGuardResult> {
  // 1. Hartfilter: Bot-Accounts (incl. Self).
  if (user.bot) return { ok: false, reason: 'bot' };

  // 2. Partial-Reaction nachladen (Discord.js liefert Partials wenn Bot zur
  //    Boot-Time die Message nicht im Cache hatte).
  if (reaction.partial) {
    try {
      await reaction.fetch();
    } catch {
      return { ok: false, reason: 'partial_fetch_failed' };
    }
  }

  // 3. Guild-Pflicht (DM-Reactions per Default verwerfen — wir haben aktuell
  //    keinen DM-Reaction-Use-Case; Guild-Tickets nutzen Buttons).
  const guild = reaction.message.guild;
  if (opts.requireGuild !== false && !guild) {
    return { ok: false, reason: 'no_guild' };
  }

  // 4. Per-User-Per-Message Spam-Schutz: 10 Reactions / 10s.
  //    Wert ist defensiv hoch — User darf normales Klicken; nur Skript-Spam
  //    wird gefiltert.
  const bucketKey = `react:${user.id}:${reaction.message.id}`;
  if (!tokenBucketAllow(bucketKey, 10, 10_000)) {
    logger.debug(`reactionGuard: rate-limit user=${user.id} msg=${reaction.message.id}`);
    return { ok: false, reason: 'rate_limited' };
  }

  // 5. Vollstaendiger User (Partial → Full).
  let fullUser: User | undefined;
  if (user.partial) {
    try { fullUser = await user.fetch(); } catch { /* best-effort */ }
  } else {
    fullUser = user as User;
  }

  // 6. Guild-Membership best-effort vorpruefen (nur wenn Guild da).
  let member: GuildMember | undefined;
  if (guild) {
    try {
      member = await guild.members.fetch(user.id);
    } catch {
      // Ex-Member oder Discord-API-Fehler → Reaction verwerfen.
      return { ok: false, reason: 'not_member' };
    }
  }

  return { ok: true, member, fullUser };
}
