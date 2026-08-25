/**
 * Goodbye-1 Dashboard-Routen — Abschiedssystem pro Guild.
 *
 * Nutzt dieselbe Welcome-Permission-Familie und dieselbe zentrale Channel-
 * Validierung wie das bestehende Begruessungssystem. Keine eigene Auth-
 * oder Permission-Parallelstruktur.
 */
import { Router } from 'express';
import { PermissionFlagsBits, type PermissionResolvable } from 'discord.js';
import { requireGuildPermission } from '../../middleware/auth';
import { tryGetDashboardClient } from '../../clientRegistry';
import { validateBotChannelAccess } from '../../../utils/discordChannel';
import { logAuditDb } from '../../../utils/logger';
import { emitGuildEvent } from '../../socket/emitter';
import { countWelcomeGraphemes, MAX_WELCOME_TEMPLATE_GRAPHEMES } from '../../../modules/welcome/welcomeManager';
import {
  disableGoodbye,
  getGoodbyeConfig,
  renderGoodbyeMessage,
  resolveGoodbyeIdentity,
  resolveLastKnownGoodbyeIdentity,
  setGoodbyeConfig,
  type GoodbyeConfig,
} from '../../../modules/welcome/goodbyeManager';
import { resolveCustomEmotes } from '../../../modules/ai/emoteResolver';
import { buildStructuredGoodbyeEmbed } from '../../../modules/welcome/goodbyeStatus';

export const goodbyeRouter = Router({ mergeParams: true });

const SNOWFLAKE_RE = /^\d{17,20}$/;

interface GoodbyeBody {
  enabled?: boolean;
  channelId?: string;
  message?: string;
}

export function validateGoodbyeBody(b: GoodbyeBody):
  | { ok: true; data: GoodbyeConfig }
  | { ok: false; error: string } {
  if (typeof b.channelId !== 'string' || !SNOWFLAKE_RE.test(b.channelId)) {
    return { ok: false, error: 'channelId muss eine Discord-Snowflake sein.' };
  }
  if (typeof b.message !== 'string' || b.message.trim().length === 0) {
    return { ok: false, error: 'message darf nicht leer sein.' };
  }
  if (countWelcomeGraphemes(b.message) > MAX_WELCOME_TEMPLATE_GRAPHEMES) {
    return {
      ok: false,
      error: `message darf maximal ${MAX_WELCOME_TEMPLATE_GRAPHEMES} sichtbare Zeichen lang sein.`,
    };
  }
  return {
    ok: true,
    data: {
      enabled: b.enabled !== false,
      channelId: b.channelId,
      message: b.message,
    },
  };
}

async function ensureGoodbyeChannel(channelId: string, guildId: string): Promise<string | null> {
  const requiredPerms: PermissionResolvable[] = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
  ];
  const result = await validateBotChannelAccess(tryGetDashboardClient(), guildId, channelId, requiredPerms);
  return result.ok ? null : result.reason;
}

function serialize(cfg: GoodbyeConfig | null) {
  if (!cfg) return { configured: false, enabled: false, channelId: '', message: '' };
  return {
    configured: true,
    enabled: cfg.enabled,
    channelId: cfg.channelId,
    message: cfg.message,
  };
}

goodbyeRouter.get('/config', requireGuildPermission('welcome.view'), async (req, res) => {
  const scope = req.guildScope!;
  res.json(serialize(await getGoodbyeConfig(scope.guildId)));
});

goodbyeRouter.post('/config', requireGuildPermission('welcome.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const checked = validateGoodbyeBody(req.body as GoodbyeBody);
  if (!checked.ok) { res.status(400).json({ error: checked.error }); return; }

  const channelError = await ensureGoodbyeChannel(checked.data.channelId, scope.guildId);
  if (channelError) { res.status(400).json({ error: channelError }); return; }

  await setGoodbyeConfig(scope.guildId, checked.data, scope.actorDiscordId);
  logAuditDb('GOODBYE_CONFIG_SAVED', 'WELCOME', {
    actorUserId: req.auth!.userId,
    guildId: scope.guildId,
    details: { channelId: checked.data.channelId, enabled: checked.data.enabled },
  });
  emitGuildEvent(scope.guildId, { type: 'goodbye.changed', payload: { guildId: scope.guildId } });
  res.json(serialize(checked.data));
});

goodbyeRouter.post('/disable', requireGuildPermission('welcome.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const existing = await getGoodbyeConfig(scope.guildId);
  if (!existing) { res.status(404).json({ error: 'Keine Goodbye-Konfiguration vorhanden.' }); return; }

  await disableGoodbye(scope.guildId, scope.actorDiscordId);
  logAuditDb('GOODBYE_DISABLED', 'WELCOME', {
    actorUserId: req.auth!.userId,
    guildId: scope.guildId,
  });
  emitGuildEvent(scope.guildId, { type: 'goodbye.changed', payload: { guildId: scope.guildId } });
  res.json(serialize({ ...existing, enabled: false }));
});

goodbyeRouter.post('/test', requireGuildPermission('welcome.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const client = tryGetDashboardClient();
  if (!client) { res.status(503).json({ error: 'Bot nicht bereit.' }); return; }

  const guild = client.guilds.cache.get(scope.guildId);
  if (!guild) { res.status(404).json({ error: 'Bot ist nicht in dieser Guild.' }); return; }

  const body = req.body as GoodbyeBody;
  let cfg: GoodbyeConfig | null;
  if (body && typeof body.channelId === 'string' && body.message !== undefined) {
    const checked = validateGoodbyeBody(body);
    if (!checked.ok) { res.status(400).json({ error: checked.error }); return; }
    cfg = checked.data;
  } else {
    cfg = await getGoodbyeConfig(scope.guildId);
  }
  if (!cfg) { res.status(400).json({ error: 'Keine Goodbye-Konfiguration zum Testen.' }); return; }

  const channelError = await ensureGoodbyeChannel(cfg.channelId, scope.guildId);
  if (channelError) { res.status(400).json({ error: channelError }); return; }

  const channel = await client.channels.fetch(cfg.channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || channel.isDMBased()) {
    res.status(400).json({ error: 'Channel ist kein sendbarer Text-Channel.' }); return;
  }

  const actorMember = guild.members.cache.get(scope.actorDiscordId)
    ?? await guild.members.fetch(scope.actorDiscordId).catch(() => null);
  const identity = actorMember
    ? await resolveLastKnownGoodbyeIdentity(actorMember)
    : resolveGoodbyeIdentity({
        discordId: scope.actorDiscordId,
        username: scope.actorDiscordId,
        nickname: null,
      }, null);

  const leaveOccurredAt = new Date();
  const rendered = renderGoodbyeMessage(cfg.message, {
    identity,
    guild: guild.name,
    memberCount: guild.memberCount,
    occurredAt: leaveOccurredAt,
  });
  const finalText = resolveCustomEmotes(rendered, guild);

  try {
    await channel.send({
      content: '🧪 Goodbye-Test',
      embeds: [buildStructuredGoodbyeEmbed({
        discordName: identity.displayName,
        discordMention: identity.mention,
        customMessage: finalText,
        leaveOccurredAt,
        cleanupEnabled: false,
        cleanupSnapshot: null,
      })],
      allowedMentions: { parse: [] },
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Testnachricht ist ungueltig.' });
    return;
  }

  logAuditDb('GOODBYE_TEST_SENT', 'WELCOME', {
    actorUserId: req.auth!.userId,
    guildId: scope.guildId,
    details: { channelId: cfg.channelId },
  });
  res.json({ ok: true, channelId: cfg.channelId });
});
