/**
 * Welcome-Routen — Begruessungssystem pro Guild (BotConfig key=`welcome:<guildId>`).
 *
 *   GET    /config     Aktuelle Welcome-Konfiguration
 *   POST   /config     Konfiguration speichern (enabled/channel/mode/message/media)
 *   POST   /test        Testnachricht in den Channel senden (rendert wie der Live-Join)
 *   POST   /disable      Welcome deaktivieren (Config bleibt erhalten)
 *
 * Datenhaltung ausschliesslich ueber welcomeManager (kein Parallel-State).
 * Strikte guildId-Scope-Pruefung in jeder Operation.
 */

import { Router } from 'express';
import { AttachmentBuilder, PermissionFlagsBits } from 'discord.js';
import { requireGuildPermission } from '../../middleware/auth';
import prisma from '../../../database/prisma';
import {
  getWelcomeConfig,
  setWelcomeConfig,
  disableWelcome,
  renderWelcomeMessage,
  type WelcomeConfig,
} from '../../../modules/welcome/welcomeManager';
import { answerQuestion } from '../../../modules/ai/aiHandler';
import { sanitizeForPrompt, withTimeout, safeSend } from '../../../utils/safeSend';
import { resolveCustomEmotes } from '../../../modules/ai/emoteResolver';
import { tryGetDashboardClient } from '../../clientRegistry';
import { validateBotChannelAccess } from '../../../utils/discordChannel';
import { logAuditDb } from '../../../utils/logger';
import { emitGuildEvent } from '../../socket/emitter';

export const welcomeRouter = Router({ mergeParams: true });

const SNOWFLAKE_RE = /^\d{17,20}$/;
const SUPPORTED_MEDIA = /^https?:\/\/.+\.(jpe?g|png|gif|webp|mp4|webm|mov)(\?.*)?$/i;
const MAX_MESSAGE = 1000;

interface WelcomeBody {
  enabled?: boolean;
  channelId?: string;
  message?: string;
  mode?: string;
  mediaUrl?: string | null;
}

function validateBody(b: WelcomeBody):
  | { ok: true; data: WelcomeConfig }
  | { ok: false; error: string } {
  if (typeof b.channelId !== 'string' || !SNOWFLAKE_RE.test(b.channelId)) {
    return { ok: false, error: 'channelId muss eine Discord-Snowflake sein.' };
  }
  if (typeof b.message !== 'string' || b.message.trim().length === 0) {
    return { ok: false, error: 'message darf nicht leer sein.' };
  }
  if (b.message.length > MAX_MESSAGE) {
    return { ok: false, error: `message darf maximal ${MAX_MESSAGE} Zeichen lang sein.` };
  }
  if (b.mode !== 'text' && b.mode !== 'ai') {
    return { ok: false, error: 'mode muss "text" oder "ai" sein.' };
  }
  let mediaUrl: string | undefined;
  if (b.mediaUrl != null && b.mediaUrl !== '') {
    if (typeof b.mediaUrl !== 'string' || !SUPPORTED_MEDIA.test(b.mediaUrl)) {
      return { ok: false, error: 'mediaUrl muss ein http(s)-Link auf jpg/png/gif/webp/mp4/webm/mov sein.' };
    }
    mediaUrl = b.mediaUrl;
  }
  return {
    ok: true,
    data: {
      enabled: b.enabled !== false,
      channelId: b.channelId,
      message: b.message,
      mode: b.mode,
      mediaUrl,
    },
  };
}

async function ensureChannel(channelId: string, guildId: string): Promise<string | null> {
  const client = tryGetDashboardClient();
  if (!client) return null;
  const v = await validateBotChannelAccess(client, guildId, channelId, [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
  ]);
  return v.ok ? null : v.reason;
}

function serialize(cfg: WelcomeConfig | null) {
  if (!cfg) {
    return { configured: false, enabled: false, channelId: '', message: '', mode: 'text' as const, mediaUrl: null };
  }
  return {
    configured: true,
    enabled: cfg.enabled,
    channelId: cfg.channelId,
    message: cfg.message,
    mode: cfg.mode,
    mediaUrl: cfg.mediaUrl ?? null,
  };
}

welcomeRouter.get('/config', requireGuildPermission('welcome.view'), async (req, res) => {
  const scope = req.guildScope!;
  const cfg = await getWelcomeConfig(scope.guildId);
  res.json(serialize(cfg));
});

/**
 * Read-only Auto-Rollen-Liste (Onboarding-Kontext). Verwaltung bleibt im
 * Discord-Command `/autorole`. Strikte guildId-Scope-Pruefung.
 */
welcomeRouter.get('/autoroles', requireGuildPermission('welcome.view'), async (req, res) => {
  const scope = req.guildScope!;
  const rows = await prisma.autoRole.findMany({
    where: { guildId: scope.guildId },
    orderBy: { createdAt: 'desc' },
  });
  res.json({
    autoroles: rows.map(r => ({
      id: r.id,
      roleId: r.roleId,
      roleName: r.roleName,
      triggerType: r.triggerType,
      triggerValue: r.triggerValue,
      isActive: r.isActive,
      expiresAt: r.expiresAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
  });
});

welcomeRouter.post('/config', requireGuildPermission('welcome.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const v = validateBody(req.body as WelcomeBody);
  if (!v.ok) { res.status(400).json({ error: v.error }); return; }

  const channelErr = await ensureChannel(v.data.channelId, scope.guildId);
  if (channelErr) { res.status(400).json({ error: channelErr }); return; }

  await setWelcomeConfig(scope.guildId, v.data, scope.actorDiscordId);
  logAuditDb('WELCOME_CONFIG_SAVED', 'WELCOME', {
    actorUserId: scope.actorDiscordId, guildId: scope.guildId,
    details: { channelId: v.data.channelId, mode: v.data.mode, enabled: v.data.enabled },
  });
  emitGuildEvent(scope.guildId, { type: 'welcome.changed', payload: { guildId: scope.guildId } });
  res.json(serialize(v.data));
});

welcomeRouter.post('/disable', requireGuildPermission('welcome.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const existing = await getWelcomeConfig(scope.guildId);
  if (!existing) { res.status(404).json({ error: 'Keine Welcome-Konfiguration vorhanden.' }); return; }
  await disableWelcome(scope.guildId, scope.actorDiscordId);
  logAuditDb('WELCOME_DISABLED', 'WELCOME', {
    actorUserId: scope.actorDiscordId, guildId: scope.guildId,
  });
  emitGuildEvent(scope.guildId, { type: 'welcome.changed', payload: { guildId: scope.guildId } });
  res.json(serialize({ ...existing, enabled: false }));
});

welcomeRouter.post('/test', requireGuildPermission('welcome.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const client = tryGetDashboardClient();
  if (!client) { res.status(503).json({ error: 'Bot nicht bereit.' }); return; }

  const guild = client.guilds.cache.get(scope.guildId);
  if (!guild) { res.status(404).json({ error: 'Bot ist nicht in dieser Guild.' }); return; }

  // Body darf eine noch nicht gespeicherte Config zum Testen mitliefern.
  const body = req.body as WelcomeBody;
  let cfg: WelcomeConfig | null;
  if (body && typeof body.channelId === 'string' && body.message !== undefined) {
    const v = validateBody(body);
    if (!v.ok) { res.status(400).json({ error: v.error }); return; }
    cfg = v.data;
  } else {
    cfg = await getWelcomeConfig(scope.guildId);
  }
  if (!cfg) { res.status(400).json({ error: 'Keine Welcome-Konfiguration zum Testen.' }); return; }

  const channelErr = await ensureChannel(cfg.channelId, scope.guildId);
  if (channelErr) { res.status(400).json({ error: channelErr }); return; }

  const channel = await client.channels.fetch(cfg.channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || channel.isDMBased()) {
    res.status(400).json({ error: 'Channel ist kein sendbarer Text-Channel.' }); return; }

  const userMention = `<@${scope.actorDiscordId}>`;
  const memberCount = guild.memberCount;

  let messageText: string;
  if (cfg.mode === 'ai') {
    const safeUser = sanitizeForPrompt(`Tester ${scope.actorDiscordId}`, 100);
    const safeGuild = sanitizeForPrompt(guild.name, 100);
    const safeTemplate = sanitizeForPrompt(cfg.message, MAX_MESSAGE);
    const prompt = renderWelcomeMessage(safeTemplate, { user: safeUser, guild: safeGuild, memberCount });
    const r = await withTimeout(
      answerQuestion(
        `Erzeuge eine kurze, freundliche, einladende Begrüßung. Anweisung: ${prompt}\n\nNeuer Nutzer: ${safeUser}\nServer: ${safeGuild}\nMitgliederzahl: ${memberCount}\n\nGib NUR den Begrüßungstext zurück (max. 600 Zeichen).`,
        { mode: 'welcome' },
      ),
      8000,
      'welcome.test.ai',
    );
    messageText = r && r.success && r.result ? `${userMention} ${r.result.trim()}` : `${userMention} Willkommen auf ${guild.name}!`;
  } else {
    messageText = renderWelcomeMessage(cfg.message, { user: userMention, guild: guild.name, memberCount });
  }

  const files = cfg.mediaUrl ? [new AttachmentBuilder(cfg.mediaUrl)] : undefined;
  const finalText = resolveCustomEmotes(messageText, guild);
  const sent = await safeSend(channel, {
    content: `🧪 **Testnachricht** — ${finalText}`.slice(0, 2000),
    files,
    allowedMentions: { users: [scope.actorDiscordId], parse: [] },
  });

  if (!sent) { res.status(502).json({ error: 'Nachricht konnte nicht gesendet werden.' }); return; }
  logAuditDb('WELCOME_TEST_SENT', 'WELCOME', {
    actorUserId: scope.actorDiscordId, guildId: scope.guildId,
    details: { channelId: cfg.channelId, mode: cfg.mode },
  });
  res.json({ ok: true, channelId: cfg.channelId });
});
