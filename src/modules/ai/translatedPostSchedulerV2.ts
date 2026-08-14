import { existsSync } from 'node:fs';
import type { Client, Guild, TextChannel, NewsChannel, ThreadChannel } from 'discord.js';
import { AttachmentBuilder, ChannelType, EmbedBuilder } from 'discord.js';
import prisma from '../../database/prisma';
import { logger } from '../../utils/logger';
import { Colors, Brand } from '../../utils/embedDesign';
import { safeEmbedDescription, safeEmbedTitle, safeEmbedAuthor } from '../../utils/embedSanitize';
import { resolveTranslatedPostImage, saveTranslatedPostImageFromUrl } from './translatedPostImage';
import { translate, getLanguageName, SUPPORTED_LANGUAGES } from './translator';

export function buildTranslatePostEmbed(opts: { guild: Guild | null; translated: string; targetLang: string; imageUrl?: string | null; customTitle?: string | null }): EmbedBuilder {
  const lang = SUPPORTED_LANGUAGES.find((l) => l.code === opts.targetLang);
  const flag = lang?.emoji ?? '🌐';
  const langName = lang?.name ?? getLanguageName(opts.targetLang);
  const guildName = opts.guild?.name ?? 'Server';
  const guildIcon = opts.guild?.iconURL({ size: 128 }) ?? undefined;
  const body = opts.translated && opts.translated.trim().length > 0 ? opts.translated : '_(leer)_';
  const title = opts.customTitle && opts.customTitle.trim().length > 0 ? `${flag} ${opts.customTitle.trim().slice(0, 240)}` : `${flag} Übersetzte Nachricht · ${langName}`;
  const embed = new EmbedBuilder().setColor(Colors.Info).setAuthor({ name: safeEmbedAuthor(`${flag}  ${guildName}`), iconURL: guildIcon }).setTitle(safeEmbedTitle(title)).setDescription(safeEmbedDescription(`${Brand.divider}\n${body}\n${Brand.divider}`)).setFooter({ text: Brand.name, iconURL: guildIcon }).setTimestamp();
  if (opts.imageUrl) embed.setImage(opts.imageUrl);
  return embed;
}

const POLL_INTERVAL_MS = 30_000;
const WEEKDAY_MAP: Record<string, number> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
let scheduler: NodeJS.Timeout | null = null;
let running = false;

export function parseRecurrence(spec: string): { kind: 'hourly' | 'daily' | 'weekly' | 'monthly'; weekday?: number; day?: number; hour: number; minute: number } | null {
  const parts = spec.toUpperCase().split(':');
  if (parts[0] === 'HOURLY' && parts.length === 2) { const m = Number(parts[1]); if (Number.isInteger(m) && m >= 0 && m < 60) return { kind: 'hourly', hour: 0, minute: m }; }
  if (parts[0] === 'DAILY' && parts.length === 3) { const h = Number(parts[1]); const m = Number(parts[2]); if (Number.isInteger(h) && Number.isInteger(m) && h >= 0 && h < 24 && m >= 0 && m < 60) return { kind: 'daily', hour: h, minute: m }; }
  if (parts[0] === 'WEEKLY' && parts.length === 4) { const wd = WEEKDAY_MAP[parts[1]]; const h = Number(parts[2]); const m = Number(parts[3]); if (wd !== undefined && Number.isInteger(h) && Number.isInteger(m) && h >= 0 && h < 24 && m >= 0 && m < 60) return { kind: 'weekly', weekday: wd, hour: h, minute: m }; }
  if (parts[0] === 'MONTHLY' && parts.length === 4) { const d = Number(parts[1]); const h = Number(parts[2]); const m = Number(parts[3]); if (Number.isInteger(d) && Number.isInteger(h) && Number.isInteger(m) && d >= 1 && d <= 31 && h >= 0 && h < 24 && m >= 0 && m < 60) return { kind: 'monthly', day: d, hour: h, minute: m }; }
  return null;
}

export function nextRunFromRecurrence(spec: string, after: Date = new Date()): Date | null {
  const r = parseRecurrence(spec);
  if (!r) return null;
  const formatter = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', timeZoneName: 'shortOffset' });
  const zone = formatter.formatToParts(after).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+1';
  const match = zone.match(/([+-]?\d{1,2})/);
  const offsetH = match ? Number(match[1]) : 1;
  const now = new Date(after.getTime() + offsetH * 3_600_000);
  const candidate = new Date(now);
  candidate.setUTCHours(r.hour, r.minute, 0, 0);
  if (r.kind === 'hourly') {
    candidate.setUTCHours(now.getUTCHours(), r.minute, 0, 0);
    if (candidate.getTime() <= now.getTime()) candidate.setUTCHours(candidate.getUTCHours() + 1);
  } else if (r.kind === 'daily') {
    if (candidate.getTime() <= now.getTime()) candidate.setUTCDate(candidate.getUTCDate() + 1);
  } else if (r.kind === 'weekly' && r.weekday !== undefined) {
    let delta = (r.weekday - candidate.getUTCDay() + 7) % 7;
    if (delta === 0 && candidate.getTime() <= now.getTime()) delta = 7;
    candidate.setUTCDate(candidate.getUTCDate() + delta);
  } else if (r.kind === 'monthly' && r.day !== undefined) {
    const day: number = r.day;
    candidate.setUTCDate(day);
    candidate.setUTCHours(r.hour, r.minute, 0, 0);
    if (candidate.getTime() <= now.getTime() || candidate.getUTCDate() !== day) {
      let shift = 1;
      while (shift <= 12) {
        const probe: Date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + shift, day, r.hour, r.minute, 0));
        if (probe.getUTCDate() === day) { candidate.setTime(probe.getTime()); break; }
        shift += 1;
      }
      if (shift > 12) return null;
    }
  }
  return new Date(candidate.getTime() - offsetH * 3_600_000);
}

async function runDuePosts(client: Client): Promise<void> {
  if (running) return;
  running = true;
  try {
    const due = await prisma.translatedPost.findMany({ where: { isActive: true, nextRunAt: { lte: new Date() } }, take: 20 }).catch((error) => { logger.warn(`translatedPostScheduler: DB-Read fehlgeschlagen: ${String(error)}`); return []; });
    for (const post of due) {
      try { await sendPost(client, post); } catch (error) { logger.warn(`translatedPostScheduler: Versand fehlgeschlagen ${post.id}: ${String(error)}`); }
    }
  } finally { running = false; }
}

async function sendPost(client: Client, post: { id: string; guildId: string; channelId: string; sourceText: string; sourceLang: string; targetLang: string; translatedText: string | null; imageUrl: string | null; rolePings: string | null; mode: string; recurrenceCron: string | null; customTitle?: string | null }): Promise<void> {
  const rawChannel = await client.channels.fetch(post.channelId).catch(() => null);
  if (!rawChannel || !('send' in rawChannel)) { await prisma.translatedPost.update({ where: { id: post.id }, data: { isActive: false } }); return; }
  let translated = post.translatedText;
  if (!translated) {
    translated = await translate(post.sourceText, post.targetLang, post.sourceLang);
    if (!translated) translated = post.sourceText;
    else await prisma.translatedPost.update({ where: { id: post.id }, data: { translatedText: translated } });
  }
  const allRoles = (post.rolePings ?? '').split(',').map((s) => s.trim()).filter((s) => /^\d+$/.test(s));
  const wantsEveryone = allRoles.includes(post.guildId);
  const roleIds = allRoles.filter((id) => id !== post.guildId);
  const pings = [...(wantsEveryone ? ['@everyone'] : []), ...roleIds.map((id) => `<@&${id}>`)].join(' ');
  const segments: string[] = [];
  let rest = translated;
  while (rest.length > 3800) { const cut = rest.lastIndexOf('\n', 3800); const at = cut > 500 ? cut : 3800; segments.push(rest.slice(0, at)); rest = rest.slice(at); }
  if (rest.length) segments.push(rest);
  if (!segments.length) segments.push('_(leer)_');
  const channel = rawChannel as TextChannel | NewsChannel | ThreadChannel;

  // Phase 9: Neue wie auch bereits gespeicherte Legacy-http(s)-Bilder duerfen
  // niemals direkt von Discord als Remote-Embed geladen werden. Vor dem Versand
  // werden sie SSRF-sicher heruntergeladen, per Magic Bytes validiert und in das
  // persistente Upload-Volume ueberfuehrt. Bei Fehlern wird fail-closed ohne Bild
  // gesendet, statt die ungepruefte Remote-URL weiterzureichen.
  let imageRef = post.imageUrl;
  let managed = resolveTranslatedPostImage(imageRef);
  if (!managed && imageRef && /^https?:\/\//i.test(imageRef)) {
    try {
      imageRef = await saveTranslatedPostImageFromUrl(post.guildId, imageRef);
      await prisma.translatedPost.update({ where: { id: post.id }, data: { imageUrl: imageRef } });
      managed = resolveTranslatedPostImage(imageRef);
    } catch (error) {
      logger.warn(`translatedPostScheduler: Remote-Bild fuer ${post.id} verworfen: ${String(error)}`);
      imageRef = null;
      managed = null;
    }
  }
  const local = managed && existsSync(managed.path) ? managed : null;
  if (managed && !local) logger.warn(`translatedPostScheduler: Bilddatei fuer ${post.id} fehlt.`);

  let first = true;
  for (const segment of segments) {
    const attachment = first && local ? new AttachmentBuilder(local.path, { name: local.name }) : null;
    const imageUrl = first && attachment ? `attachment://${local!.name}` : null;
    const embed = buildTranslatePostEmbed({ guild: channel.guild ?? null, translated: segment, targetLang: post.targetLang, imageUrl, customTitle: post.customTitle });
    try {
      await channel.send({ content: first && pings ? pings : undefined, embeds: [embed], files: attachment ? [attachment] : undefined, allowedMentions: { roles: roleIds, parse: wantsEveryone ? ['everyone'] : [] } });
    } catch (error) {
      if (!attachment) throw error;
      const fallback = buildTranslatePostEmbed({ guild: channel.guild ?? null, translated: segment, targetLang: post.targetLang, imageUrl: null, customTitle: post.customTitle });
      await channel.send({ content: first && pings ? pings : undefined, embeds: [fallback], allowedMentions: { roles: roleIds, parse: wantsEveryone ? ['everyone'] : [] } });
    }
    first = false;
  }
  if (post.mode === 'recurring' && post.recurrenceCron) {
    const next = nextRunFromRecurrence(post.recurrenceCron, new Date(Date.now() + 1000));
    await prisma.translatedPost.update({ where: { id: post.id }, data: { lastRunAt: new Date(), nextRunAt: next ?? null, isActive: Boolean(next) } });
  } else await prisma.translatedPost.update({ where: { id: post.id }, data: { lastRunAt: new Date(), isActive: false } });
}

export function startTranslatedPostScheduler(client: Client): void {
  if (scheduler) return;
  scheduler = setInterval(() => { void runDuePosts(client); }, POLL_INTERVAL_MS);
  scheduler.unref?.();
  logger.info(`translatedPostScheduler: gestartet (alle ${POLL_INTERVAL_MS / 1000}s).`);
}

export function stopTranslatedPostScheduler(): void {
  if (!scheduler) return;
  clearInterval(scheduler);
  scheduler = null;
}

export function isTextSendable(type: ChannelType): boolean {
  return type === ChannelType.GuildText || type === ChannelType.GuildAnnouncement || type === ChannelType.PublicThread || type === ChannelType.PrivateThread || type === ChannelType.AnnouncementThread;
}
