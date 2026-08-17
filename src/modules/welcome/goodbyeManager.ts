import type { GuildMember } from 'discord.js';
import prisma from '../../database/prisma';
import { getMemberProfile } from '../ai/memberAwareness';
import { resolveCustomEmotes } from '../ai/emoteResolver';
import { renderTemplate } from '../ai/triggers';
import { sendWelcomeMessages } from './welcomeManager';

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
 */
export function resolveGoodbyeIdentity(
  fallback: { discordId: string; username: string; nickname?: string | null },
  stored: StoredIdentity,
): GoodbyeIdentity {
  const username = stored?.username?.trim() || fallback.username.trim() || fallback.discordId;
  const nickname = stored?.nickname?.trim() || fallback.nickname?.trim() || null;
  return {
    discordId: fallback.discordId,
    username,
    nickname,
    displayName: nickname || username,
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
  vars: { identity: GoodbyeIdentity; guild: string; memberCount: number },
): string {
  return renderTemplate(message, { user: vars.identity.displayName })
    .replace(/\{username\}/g, vars.identity.username)
    .replace(/\{nickname\}/g, vars.identity.nickname || vars.identity.username)
    .replace(/\{mention\}/g, vars.identity.mention)
    .replace(/\{guild\}/g, vars.guild)
    .replace(/\{count\}/g, String(vars.memberCount))
    .replace(/\{member_count\}/g, String(vars.memberCount));
}

/**
 * Runtime-Zustellung beim GuildMemberRemove.
 * Mentions werden absichtlich NICHT freigeschaltet: {mention} kann im Text
 * angezeigt werden, pingt den bereits ausgetretenen Nutzer aber nicht.
 */
export async function sendConfiguredGoodbye(member: GuildMember): Promise<GoodbyeDeliveryResult> {
  const cfg = await getGoodbyeConfig(member.guild.id);
  if (!cfg?.enabled || !cfg.channelId || !cfg.message.trim()) return 'disabled';

  const channel = await member.guild.channels.fetch(cfg.channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || channel.isDMBased()) return 'missing_channel';

  const identity = await resolveLastKnownGoodbyeIdentity(member);
  const rendered = renderGoodbyeMessage(cfg.message, {
    identity,
    guild: member.guild.name,
    memberCount: member.guild.memberCount,
  });
  const finalText = resolveCustomEmotes(rendered, member.guild);

  await sendWelcomeMessages(channel, { text: finalText });
  return 'sent';
}
