import type { Client, Guild, TextChannel, NewsChannel, ThreadChannel } from 'discord.js';
import { ChannelType, EmbedBuilder } from 'discord.js';
import prisma from '../../database/prisma';
import { logger } from '../../utils/logger';
import { Colors, Brand } from '../../utils/embedDesign';
import { translate, getLanguageName, SUPPORTED_LANGUAGES } from './translator';

/**
 * Baut das Standard-Embed fuer uebersetzte Posts.
 * - Blaues Branding (Colors.Info)
 * - Server-Name automatisch aus Guild
 * - Flagge + Sprachname als Author
 * - Optionales Bild
 */
export function buildTranslatePostEmbed(opts: {
  guild: Guild | null;
  translated: string;
  targetLang: string;
  imageUrl?: string | null;
}): EmbedBuilder {
  const lang = SUPPORTED_LANGUAGES.find((l) => l.code === opts.targetLang);
  const flag = lang?.emoji ?? '🌐';
  const langName = lang?.name ?? getLanguageName(opts.targetLang);
  const guildName = opts.guild?.name ?? 'Server';
  const guildIcon = opts.guild?.iconURL({ size: 128 }) ?? undefined;

  const embed = new EmbedBuilder()
    .setColor(Colors.Info) // Blau – wie gewuenscht
    .setAuthor({ name: `${flag}  ${guildName}`, iconURL: guildIcon })
    .setTitle(`${flag} Übersetzte Nachricht · ${langName}`)
    .setDescription(`${Brand.divider}\n${opts.translated}\n${Brand.divider}`)
    .setFooter({ text: `${Brand.name} • ${guildName}`, iconURL: guildIcon })
    .setTimestamp();

  if (opts.imageUrl) embed.setImage(opts.imageUrl);
  return embed;
}

/**
 * Phase 17: Scheduler fuer TranslatedPosts.
 *
 * Polling-Loop (alle 30s) prueft, ob Posts faellig sind. Berechnet bei
 * Recurrence den naechsten nextRunAt. Sehr einfaches Cron-Format, weil wir
 * keinen externen Cron-Parser brauchen:
 *   - "HOURLY:MM"                 (z.B. "HOURLY:15" -> jede Stunde xx:15)
 *   - "DAILY:HH:MM"               (z.B. "DAILY:09:00")
 *   - "WEEKLY:MON:HH:MM"          (MON|TUE|WED|THU|FRI|SAT|SUN)
 *   - "MONTHLY:DD:HH:MM"          (z.B. "MONTHLY:23:11:45" -> jeden 23. um 11:45)
 */

const POLL_INTERVAL_MS = 30 * 1000;
const WEEKDAY_MAP: Record<string, number> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };

let scheduler: NodeJS.Timeout | null = null;

export function parseRecurrence(spec: string): { kind: 'hourly' | 'daily' | 'weekly' | 'monthly'; weekday?: number; day?: number; hour: number; minute: number } | null {
  const parts = spec.toUpperCase().split(':');
  if (parts[0] === 'HOURLY' && parts.length === 2) {
    const m = Number(parts[1]);
    if (Number.isInteger(m) && m >= 0 && m < 60) {
      return { kind: 'hourly', hour: 0, minute: m };
    }
  }
  if (parts[0] === 'DAILY' && parts.length === 3) {
    const h = Number(parts[1]); const m = Number(parts[2]);
    if (Number.isInteger(h) && Number.isInteger(m) && h >= 0 && h < 24 && m >= 0 && m < 60) {
      return { kind: 'daily', hour: h, minute: m };
    }
  }
  if (parts[0] === 'WEEKLY' && parts.length === 4) {
    const wd = WEEKDAY_MAP[parts[1]];
    const h = Number(parts[2]); const m = Number(parts[3]);
    if (wd !== undefined && Number.isInteger(h) && Number.isInteger(m) && h >= 0 && h < 24 && m >= 0 && m < 60) {
      return { kind: 'weekly', weekday: wd, hour: h, minute: m };
    }
  }
  if (parts[0] === 'MONTHLY' && parts.length === 4) {
    const d = Number(parts[1]); const h = Number(parts[2]); const m = Number(parts[3]);
    if (Number.isInteger(d) && Number.isInteger(h) && Number.isInteger(m) && d >= 1 && d <= 31 && h >= 0 && h < 24 && m >= 0 && m < 60) {
      return { kind: 'monthly', day: d, hour: h, minute: m };
    }
  }
  return null;
}

/**
 * Berechnet das naechste Ausfuehrungsdatum in Europe/Berlin und gibt es als
 * UTC-Date zurueck (Discord/DB rechnen in UTC). Naive Implementierung ohne
 * DST-Edgecases - reicht fuer Discord-Bot-Reminder.
 */
export function nextRunFromRecurrence(spec: string, after: Date = new Date()): Date | null {
  const r = parseRecurrence(spec);
  if (!r) return null;

  // Berlin-Offset bestimmen anhand des aktuellen Datums.
  const berlinFmt = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', timeZoneName: 'shortOffset' });
  const offsetPart = berlinFmt.formatToParts(after).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+1';
  const offsetMatch = offsetPart.match(/([+-]?\d{1,2})/);
  const offsetH = offsetMatch ? Number(offsetMatch[1]) : 1;

  // Berlin "jetzt" als plain Date konstruieren.
  const nowBerlin = new Date(after.getTime() + offsetH * 3_600_000);
  const candidate = new Date(nowBerlin);
  candidate.setUTCHours(r.hour, r.minute, 0, 0);

  if (r.kind === 'hourly') {
    // Stuendlich: setze auf naechste Stunde mit Minute=r.minute.
    candidate.setUTCHours(nowBerlin.getUTCHours(), r.minute, 0, 0);
    if (candidate.getTime() <= nowBerlin.getTime()) candidate.setUTCHours(candidate.getUTCHours() + 1);
  } else if (r.kind === 'daily') {
    if (candidate.getTime() <= nowBerlin.getTime()) candidate.setUTCDate(candidate.getUTCDate() + 1);
  } else if (r.kind === 'weekly' && r.weekday !== undefined) {
    const currentWd = candidate.getUTCDay();
    let delta = (r.weekday - currentWd + 7) % 7;
    if (delta === 0 && candidate.getTime() <= nowBerlin.getTime()) delta = 7;
    candidate.setUTCDate(candidate.getUTCDate() + delta);
  } else if (r.kind === 'monthly' && r.day !== undefined) {
    candidate.setUTCDate(r.day);
    candidate.setUTCHours(r.hour, r.minute, 0, 0);
    if (candidate.getTime() <= nowBerlin.getTime() || candidate.getUTCDate() !== r.day) {
      // entweder schon vorbei, oder Tag existiert in diesem Monat nicht (z.B. 31. Februar)
      // -> in Folgemonat verschieben, ggf. weiter, bis Tag existiert
      let monthShift = 1;
      // Reset auf 1. damit setUTCMonth nicht ueberlaeuft.
      while (true) {
        const probe: Date = new Date(Date.UTC(nowBerlin.getUTCFullYear(), nowBerlin.getUTCMonth() + monthShift, r.day, r.hour, r.minute, 0));
        if (probe.getUTCDate() === r.day) {
          candidate.setTime(probe.getTime());
          break;
        }
        monthShift += 1;
        if (monthShift > 12) return null;
      }
    }
  }
  // Zurueck nach UTC.
  return new Date(candidate.getTime() - offsetH * 3_600_000);
}

async function runDuePosts(client: Client): Promise<void> {
  let due;
  try {
    due = await prisma.translatedPost.findMany({
      where: { isActive: true, nextRunAt: { lte: new Date() } },
      take: 20,
    });
  } catch (e) {
    logger.warn(`translatedPostScheduler: DB-Read fehlgeschlagen: ${String(e)}`);
    return;
  }
  for (const p of due) {
    try {
      await sendPost(client, p);
    } catch (e) {
      logger.warn(`translatedPostScheduler: Versand fehlgeschlagen ${p.id}: ${String(e)}`);
    }
  }
}

async function sendPost(client: Client, post: {
  id: string; guildId: string; channelId: string; sourceText: string; sourceLang: string; targetLang: string;
  translatedText: string | null; imageUrl: string | null; rolePings: string | null; mode: string; recurrenceCron: string | null;
}): Promise<void> {
  // Channel laden.
  const ch = await client.channels.fetch(post.channelId).catch(() => null);
  if (!ch || !('send' in ch)) {
    logger.warn(`translatedPostScheduler: Channel ${post.channelId} nicht gefunden, deaktiviere Post.`);
    await prisma.translatedPost.update({ where: { id: post.id }, data: { isActive: false } });
    return;
  }
  // Translation cachen, falls noch nicht gemacht.
  let translated = post.translatedText;
  if (!translated) {
    translated = await translate(post.sourceText, post.targetLang, post.sourceLang);
    if (!translated) {
      logger.warn(`translatedPostScheduler: Uebersetzung fehlgeschlagen, sende Quelltext (${post.id}).`);
      translated = post.sourceText;
    } else {
      await prisma.translatedPost.update({ where: { id: post.id }, data: { translatedText: translated } });
    }
  }
  // Role-Pings vorbereiten. @everyone-Rolle (id === guildId) separat als Literal rendern,
  // sonst zeigt Discord "@@everyone" (Rollenname enthaelt bereits "@").
  const allIds = (post.rolePings ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s));
  const wantsEveryone = allIds.includes(post.guildId);
  const realRoleIds = allIds.filter((id) => id !== post.guildId);
  const prefixParts: string[] = [];
  if (wantsEveryone) prefixParts.push('@everyone');
  prefixParts.push(...realRoleIds.map((id) => `<@&${id}>`));
  const pingContent = prefixParts.join(' ');

  // Embed-Beschreibung darf max 4096 Zeichen haben; bei Overflow splitten.
  const MAX_DESC = 3800;
  const segments: string[] = [];
  let buf = translated;
  while (buf.length > MAX_DESC) {
    const cut = buf.lastIndexOf('\n', MAX_DESC);
    const at = cut > 500 ? cut : MAX_DESC;
    segments.push(buf.slice(0, at));
    buf = buf.slice(at);
  }
  segments.push(buf);

  const channel = ch as TextChannel | NewsChannel | ThreadChannel;
  const guild = channel.guild ?? null;
  const parseTypes: ('everyone' | 'roles' | 'users')[] = wantsEveryone ? ['everyone'] : [];
  let firstSent = true;
  for (const seg of segments) {
    const embed = buildTranslatePostEmbed({
      guild,
      translated: seg,
      targetLang: post.targetLang,
      imageUrl: firstSent ? post.imageUrl : null,
    });
    await channel.send({
      // Pings als Content (Embeds triggern keine Mentions).
      content: firstSent && pingContent ? pingContent : undefined,
      embeds: [embed],
      allowedMentions: { roles: realRoleIds, parse: parseTypes },
    });
    firstSent = false;
  }

  // Update: lastRunAt setzen, nextRunAt fortschreiben oder deaktivieren.
  if (post.mode === 'recurring' && post.recurrenceCron) {
    const next = nextRunFromRecurrence(post.recurrenceCron, new Date(Date.now() + 1000));
    await prisma.translatedPost.update({
      where: { id: post.id },
      data: { lastRunAt: new Date(), nextRunAt: next ?? null, isActive: next ? true : false },
    });
  } else {
    await prisma.translatedPost.update({
      where: { id: post.id },
      data: { lastRunAt: new Date(), isActive: false },
    });
  }
  logger.info(`translatedPostScheduler: Post ${post.id} gesendet (mode=${post.mode}, lang=${post.targetLang}).`);
}

export function startTranslatedPostScheduler(client: Client): void {
  if (scheduler) return;
  scheduler = setInterval(() => { void runDuePosts(client); }, POLL_INTERVAL_MS);
  logger.info(`translatedPostScheduler: gestartet (alle ${POLL_INTERVAL_MS / 1000}s).`);
}

// kleines Helper-Re-Export, damit der Command-Handler den Channel-Typ pruefen kann.
export function isTextSendable(type: ChannelType): boolean {
  return type === ChannelType.GuildText || type === ChannelType.GuildAnnouncement || type === ChannelType.PublicThread || type === ChannelType.PrivateThread || type === ChannelType.AnnouncementThread;
}
