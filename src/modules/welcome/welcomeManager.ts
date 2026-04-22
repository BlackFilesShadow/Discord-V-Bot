import prisma from '../../database/prisma';
import { renderTemplate } from '../ai/triggers';

/**
 * Welcome-System pro Guild (BotConfig key=`welcome:<guildId>`).
 *
 * Modi:
 *  - text:  statische Begr\u00fc\u00dfung mit {user}-Platzhalter etc.
 *  - ai:    AI generiert pers\u00f6nliche Begr\u00fc\u00dfung basierend auf aiPrompt
 */

export interface WelcomeConfig {
  enabled: boolean;
  channelId: string;
  message: string;        // Text bei mode=text ODER AI-Prompt-Vorgabe bei mode=ai
  mediaUrl?: string;      // optional JPG/PNG/GIF/MP4
  mode: 'text' | 'ai';
}

const KEY = (guildId: string) => `welcome:${guildId}`;

export async function getWelcomeConfig(guildId: string): Promise<WelcomeConfig | null> {
  const cfg = await prisma.botConfig.findUnique({ where: { key: KEY(guildId) } });
  if (!cfg) return null;
  return cfg.value as unknown as WelcomeConfig;
}

export async function setWelcomeConfig(guildId: string, cfg: WelcomeConfig, updatedBy: string): Promise<void> {
  await prisma.botConfig.upsert({
    where: { key: KEY(guildId) },
    create: {
      key: KEY(guildId),
      value: cfg as unknown as object,
      category: 'welcome',
      description: `Welcome-Konfiguration f\u00fcr Guild ${guildId}`,
      updatedBy,
    },
    update: { value: cfg as unknown as object, updatedBy },
  });
}

export async function disableWelcome(guildId: string, updatedBy: string): Promise<void> {
  const existing = await getWelcomeConfig(guildId);
  if (!existing) return;
  await setWelcomeConfig(guildId, { ...existing, enabled: false }, updatedBy);
}

export function renderWelcomeMessage(message: string, vars: { user: string; guild: string; memberCount: number }): string {
  return renderTemplate(message, { user: vars.user })
    .replace(/\{guild\}/g, vars.guild)
    .replace(/\{count\}/g, String(vars.memberCount))
    .replace(/\{member_count\}/g, String(vars.memberCount));
}
