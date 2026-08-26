import type { GuildMember } from 'discord.js';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import prisma from '../../database/prisma';
import { logger } from '../../utils/logger';
import { getMemberProfile } from '../ai/memberAwareness';
import { resolveCustomEmotes } from '../ai/emoteResolver';
import {
  buildStructuredGoodbyeEmbed,
  initialGoodbyeCleanupSnapshot,
  sanitizeGoodbyeVisibleText,
  type GoodbyeCleanupSnapshot,
} from './goodbyeStatus';

/**
 * Goodbye-1: Abschiedskonfiguration pro Guild.
 *
 * Absichtlich im bestehenden Welcome-Modul angesiedelt: gleiche BotConfig-
 * Architektur, gleiche sichere Discord-Zustellung und gleiche Dashboard-
 * Permission-Familie. Es entsteht keine zweite, konkurrierende Messaging-
 * Architektur.
 */
export interface GoodbyeConfig {
  enabled: boolean;
  channelId: string;
  message: string;
}

export interface GoodbyeIdentity {
  discordId: string;
  username: string;
  nickname: string | null;
  displayName: string;
  mention: string;
}

type StoredIdentity = {
  username?: string | null;
  nickname?: string | null;
} | null;

export type GoodbyeDeliveryResult = 'disabled' | 'missing_channel' | 'sent';

export interface GoodbyeLifecycleContext {
  leaveOccurredAt: Date;
  cleanupEnabled: boolean;
  cleanupRequestId?: string | null;
}

const KEY = (guildId: string) => `goodbye:${guildId}`;

export async function getGoodbyeConfig(guildId: string): Promise<GoodbyeConfig | null> {
  const cfg = await prisma.botConfig.findUnique({ where: { key: KEY(guildId) } });
  if (!cfg) return null;
  return cfg.value as unknown as GoodbyeConfig;
}

export async function setGoodbyeConfig(guildId: string, cfg: GoodbyeConfig, updatedBy: string): Promise<void> {
  await prisma.botConfig.upsert({
    where: { key: KEY(guildId) },
    create: {
      key: KEY(guildId),
      value: cfg as unknown as object,
      category: 'welcome',
      description: `Goodbye-Konfiguration fuer Guild ${guildId}`,
      updatedBy,
    },
    update: { value: cfg as unknown as object, updatedBy },
  });
}

export async function disableGoodbye(guildId: string, updatedBy: string): Promise<void> {
  const existing = await getGoodbyeConfig(guildId);
  if (!existing) return;
  await setGoodbyeConfig(guildId, { ...existing, enabled: false }, updatedBy);
}

/**
 * Die persistierte guild-spezifische Identitaet hat Vorrang vor dem Gateway-
 * Fallback. Rollen/Permissions aus dem Recognition-Profil werden bewusst nicht
 * gelesen und koennen daher niemals Authorization beeinflussen.
 *
 * Eine Discord-ID ist KEIN gueltiger sichtbarer Namens-Fallback. Selbst wenn
 * ein alter Datensatz oder eine defekte Gateway-Antwort eine Snowflake als
 * Namen liefert, wird sie vor Persistenz/Rendern auf einen neutralen Text
 * reduziert.
 */
export function resolveGoodbyeIdentity(
  fallback: { discordId: string; username: string; nickname?: string | null },
  stored: StoredIdentity,
): GoodbyeIdentity {
  const usernameCandidate = stored?.username?.trim() || fallback.username.trim();
  const username = sanitizeGoodbyeVisibleText(usernameCandidate, 'Discord-Nutzer', 256);
  const nicknameCandidate = stored?.nickname?.trim() || fallback.nickname?.trim() || '';
  const nickname = nicknameCandidate
    ? sanitizeGoodbyeVisibleText(nicknameCandidate, '', 256) || null
    : null;
  const displayName = nickname || username || 'Discord-Nutzer';
  return {
    discordId: fallback.discordId,
    username,
    nickname,
    displayName,
    mention: `<@${fallback.discordId}>`,
  };
}

export async function resolveLastKnownGoodbyeIdentity(member: GuildMember): Promise<GoodbyeIdentity> {
  const stored = await getMemberProfile(member.guild.id, member.user.id);
  return resolveGoodbyeIdentity(
    {
      discordId: member.user.id,
      username: member.user.username,
      nickname: member.nickname ?? null,
    },
    stored,
  );
}

export function renderGoodbyeMessage(
  message: string,
  vars: { identity: GoodbyeIdentity; guild: string; memberCount: number; occurredAt?: Date },
): string {
  const occurredAt = vars.occurredAt ?? new Date();
  const date = new Intl.DateTimeFormat('de-DE', { dateStyle: 'long', timeZone: 'Europe/Berlin' }).format(occurredAt);
  const time = new Intl.DateTimeFormat('de-DE', { timeStyle: 'short', timeZone: 'Europe/Berlin' }).format(occurredAt);
  const calendarParts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Berlin', year: 'numeric', month: 'numeric', day: 'numeric',
    }).formatToParts(occurredAt).map(part => [part.type, part.value]),
  );
  return message
    .replace(/\{user\}/g, vars.identity.displayName)
    .replace(/\{username\}/g, vars.identity.username)
    .replace(/\{nickname\}/g, vars.identity.nickname || vars.identity.username)
    // Die Mention ist fester Bestandteil der strukturierten Nutzerzeile.
    // Alte Templates mit {mention} bleiben kompatibel, erzeugen aber keine
    // zweite, losgeloeste Mention in der Beschreibung.
    .replace(/\{mention\}/g, '')
    .replace(/\{guild\}/g, vars.guild)
    .replace(/\{count\}/g, String(vars.memberCount))
    .replace(/\{member_count\}/g, String(vars.memberCount))
    .replace(/\{date\}/g, date)
    .replace(/\{time\}/g, time)
    .replace(/\{year\}/g, calendarParts.year ?? '')
    .replace(/\{month\}/g, calendarParts.month ?? '')
    .replace(/\{day\}/g, calendarParts.day ?? '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/**
 * Runtime-Zustellung beim GuildMemberRemove.
 * Die Discord-Mention wird nur aus dem real vorhandenen GuildMember erzeugt
 * und durch allowedMentions nie als Ping freigeschaltet.
 */
export async function sendConfiguredGoodbye(
  member: GuildMember,
  context?: GoodbyeLifecycleContext,
): Promise<GoodbyeDeliveryResult> {
  const cfg = await getGoodbyeConfig(member.guild.id);
  if (!cfg?.enabled || !cfg.channelId || !cfg.message.trim()) return 'disabled';

  const channel = await member.guild.channels.fetch(cfg.channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || channel.isDMBased()) return 'missing_channel';

  const identity = await resolveLastKnownGoodbyeIdentity(member);
  const joinedAt = member.joinedAt ?? null;
  const leaveOccurredAt = context?.leaveOccurredAt ?? new Date();
  const rendered = renderGoodbyeMessage(cfg.message, {
    identity,
    guild: member.guild.name,
    memberCount: member.guild.memberCount,
    occurredAt: leaveOccurredAt,
  });
  const finalText = sanitizeGoodbyeVisibleText(resolveCustomEmotes(rendered, member.guild), '', 4000);
  const cleanupEnabled = context?.cleanupEnabled === true;
  let cleanupSnapshot: GoodbyeCleanupSnapshot | null = null;
  if (cleanupEnabled) {
    try {
      cleanupSnapshot = await initialGoodbyeCleanupSnapshot(member.guild.id, member.user.id);
    } catch (error) {
      // Goodbye is an independent product function. A broken/unavailable
      // identity lookup must never suppress the immediate Discord leave post.
      logger.warn(`Goodbye-Cleanup-Zuordnung fehlgeschlagen (${member.user.id}@${member.guild.id}); Anzeige bleibt fail-closed.`, error);
      cleanupSnapshot = {
        servers: [{
          nitradoConnId: null,
          serverAlias: 'Keine eindeutige Serverzuordnung',
          playerNames: [],
          state: 'NOT_LINKED',
        }],
      };
    }
  }
  const membershipEpoch = joinedAt?.toISOString()
    ?? context?.cleanupRequestId
    ?? member.user.id;
  const membershipKey = createHash('sha256')
    .update(`${member.guild.id}\u0000${member.user.id}\u0000${membershipEpoch}`)
    .digest('hex');

  let delivery: { id: string; messageId: string | null };
  try {
    delivery = await prisma.goodbyeDelivery.create({
      data: {
        guildId: member.guild.id,
        discordId: member.user.id,
        membershipKey,
        cleanupRequestId: context?.cleanupRequestId ?? null,
        channelId: cfg.channelId,
        discordName: identity.displayName,
        guildName: member.guild.name,
        customMessage: finalText,
        joinedAt,
        leaveOccurredAt,
        cleanupEnabled,
        cleanupSnapshot: cleanupSnapshot as unknown as Prisma.InputJsonObject,
      },
      select: { id: true, messageId: true },
    });
  } catch (error) {
    if ((error as { code?: string }).code !== 'P2002') throw error;
    const existing = await prisma.goodbyeDelivery.findUnique({
      where: { guildId_membershipKey: { guildId: member.guild.id, membershipKey } },
      select: { id: true, messageId: true },
    });
    if (!existing) throw error;
    // Der Gewinner dieses Unique-Rennens ist allein fuer den Discord-Send
    // verantwortlich. Ein doppeltes Gateway-Event erzeugt keinen zweiten Post.
    return 'sent';
  }

  let message: { id: string };
  try {
    message = await channel.send({
      embeds: [buildStructuredGoodbyeEmbed({
        discordName: identity.displayName,
        discordMention: identity.mention,
        discordMentionResolved: true,
        customMessage: finalText,
        joinedAt,
        leaveOccurredAt,
        cleanupEnabled,
        cleanupSnapshot,
      })],
      allowedMentions: { parse: [] },
      nonce: delivery.id.slice(0, 25),
      enforceNonce: true,
    });
  } catch (error) {
    await prisma.goodbyeDelivery.updateMany({
      where: { id: delivery.id, messageId: null },
      data: {
        state: 'FAILED',
        lastError: error instanceof Error ? error.message.slice(0, 1000) : 'Discord-Goodbye-Send fehlgeschlagen',
      },
    });
    throw error;
  }
  await prisma.goodbyeDelivery.updateMany({
    where: { id: delivery.id, messageId: null },
    data: { messageId: message.id, state: 'SENT', lastError: null },
  });
  return 'sent';
}
