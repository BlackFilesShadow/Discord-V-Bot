import { VoiceState, TextChannel } from 'discord.js';
import prisma from '../database/prisma';
import { logger, logAudit } from '../utils/logger';
import { BotEvent } from '../types';
import { calculateLevel } from '../modules/xp/xpManager';
import { getLevelUpMessage } from '../modules/xp/levelMessages';

/**
 * Voice-XP-Tracking (Sektion 8):
 * User erhalten XP für Voice-Aktivität.
 * Trackt Beitritts- und Verlassenszeit.
 *
 * Verhalten ist konsistent zu Message-XP (messageCreate.ts):
 *  - Channel-Whitelist (allowedChannelIds) wird respektiert
 *  - Rollen-Whitelist (allowedRoleIds) wird respektiert
 *  - XP-Cooldown (xpCooldownSeconds) wird respektiert
 *  - Level-Formel via shared calculateLevel() aus xpManager
 *  - MaxLevel-Cap aus XpConfig
 *  - LevelUp-Glueckwunsch wird in einen geeigneten Text-Channel gesendet
 *    (System-Channel der Guild, sonst stiller Skip)
 */

// In-Memory-Tracking: userId -> Beitrittszeit
const voiceJoinTimes = new Map<string, number>();

const voiceStateUpdateEvent: BotEvent = {
  name: 'voiceStateUpdate',
  once: false,

  execute: async (...args: unknown[]) => {
    const oldState = args[0] as VoiceState;
    const newState = args[1] as VoiceState;
    const userId = newState.member?.id || oldState.member?.id;
    if (!userId) return;

    // Bot ignorieren
    if (newState.member?.user?.bot || oldState.member?.user?.bot) return;

    const wasInVoice = !!oldState.channelId;
    const isInVoice = !!newState.channelId;

    // Beitritt: Startzeit merken
    if (!wasInVoice && isInVoice) {
      voiceJoinTimes.set(userId, Date.now());
      return;
    }

    // Verlassen: XP basierend auf Dauer vergeben
    if (wasInVoice && !isInVoice) {
      const joinTime = voiceJoinTimes.get(userId);
      if (!joinTime) return;

      voiceJoinTimes.delete(userId);
      const durationMs = Date.now() - joinTime;
      const durationMinutes = Math.floor(durationMs / 60000);

      // Mindestens 1 Minute in Voice
      if (durationMinutes < 1) return;

      const guild = oldState.guild ?? newState.guild;
      const guildId = guild?.id;
      const voiceChannelId = oldState.channelId || undefined;

      try {
        const dbUser = await prisma.user.findUnique({ where: { discordId: userId } });
        if (!dbUser) return;

        // Guild-spezifische XP-Konfiguration (id == guildId), analog Message-XP
        const xpConfig = guildId
          ? await prisma.xpConfig.findUnique({ where: { id: guildId } })
          : null;

        // XP-System global deaktiviert?
        if (xpConfig && xpConfig.isActive === false) return;

        // Channel-Whitelist (STRIKT)
        const allowedChannels = Array.isArray(xpConfig?.allowedChannelIds)
          ? (xpConfig!.allowedChannelIds as string[])
          : [];
        if (allowedChannels.length > 0 && voiceChannelId && !allowedChannels.includes(voiceChannelId)) {
          return;
        }

        // Rollen-Whitelist
        const allowedRoles = Array.isArray(xpConfig?.allowedRoleIds)
          ? (xpConfig!.allowedRoleIds as string[])
          : [];
        if (allowedRoles.length > 0) {
          const member = newState.member ?? oldState.member;
          if (!member) return;
          const hasAllowed = allowedRoles.some(rid => member.roles.cache.has(rid));
          if (!hasAllowed) return;
        }

        // XP-Cooldown (Anti-Spam, identisch zu Message-XP)
        const cooldownSeconds = xpConfig?.xpCooldownSeconds ?? 60;
        const existingLD = await prisma.levelData.findUnique({ where: { userId: dbUser.id } });
        if (existingLD?.lastXpGain) {
          const since = Date.now() - existingLD.lastXpGain.getTime();
          if (since < cooldownSeconds * 1000) return;
        }

        // XP-Berechnung (konfigurierbar via xpConfig.voiceXpPerMinute)
        const xpPerMinute = xpConfig?.voiceXpPerMinute ?? 2;
        const multiplier = xpConfig?.levelMultiplier ?? 1.0;
        const xpGained = Math.min(Math.floor(durationMinutes * xpPerMinute * multiplier), 500);

        const levelData = await prisma.levelData.upsert({
          where: { userId: dbUser.id },
          create: {
            userId: dbUser.id,
            xp: BigInt(xpGained),
            voiceMinutes: durationMinutes,
            lastXpGain: new Date(),
          },
          update: {
            xp: { increment: BigInt(xpGained) },
            voiceMinutes: { increment: durationMinutes },
            lastXpGain: new Date(),
          },
        });

        // XP-Record erstellen
        await prisma.xpRecord.create({
          data: {
            userId: dbUser.id,
            amount: xpGained,
            source: 'VOICE',
            channelId: voiceChannelId,
          },
        });

        // Level-Up via shared calculateLevel + MaxLevel-Cap (analog Message-XP)
        const currentXp = Number(levelData.xp);
        const maxLevel = xpConfig?.maxLevel ?? 20;
        let newLevel = calculateLevel(currentXp);
        if (newLevel > maxLevel) newLevel = maxLevel;

        if (newLevel > levelData.level) {
          await prisma.levelData.update({
            where: { userId: dbUser.id },
            data: { level: newLevel },
          });

          logAudit('LEVEL_UP', 'LEVEL', {
            userId: dbUser.id,
            newLevel,
            totalXp: currentXp,
            source: 'VOICE',
          });

          // Glueckwunsch-Nachricht in den System-Channel der Guild posten
          // (kein Voice-Channel-Spam). Wenn kein System-Channel vorhanden:
          // stiller Skip.
          const member = newState.member ?? oldState.member;
          try {
            const sysChannel = guild?.systemChannel as TextChannel | null | undefined;
            if (sysChannel?.isTextBased() && member) {
              await sysChannel.send({
                content: getLevelUpMessage({
                  user: member.toString(),
                  level: newLevel,
                  username: member.user.username,
                }),
                allowedMentions: { users: [member.id] },
              }).catch(() => { /* Permissions koennen fehlen */ });
            }
          } catch (sendErr) {
            logger.warn('Voice-LevelUp Nachricht konnte nicht gesendet werden', sendErr as Error);
          }

          // Level-Reward-Rolle (Fallback ohne Guild-Scope wie zuvor)
          const reward = await prisma.levelReward.findFirst({ where: { level: newLevel } });
          if (reward?.roleId && member) {
            try {
              await member.roles.add(reward.roleId);
              logger.info(`Voice Level-Up: ${userId} → Level ${newLevel}, Rolle ${reward.roleId}`);
            } catch (err) {
              logger.error(`Fehler beim Vergeben der Level-Reward-Rolle:`, err);
            }
          }
        }

        logger.debug(`Voice-XP: ${userId} +${xpGained} XP (${durationMinutes} Min.)`);
      } catch (error) {
        logger.error('Fehler beim Voice-XP-Tracking:', error);
      }
    }

    // Channel-Wechsel: Session fortsetzen (nicht neu starten)
    if (wasInVoice && isInVoice && oldState.channelId !== newState.channelId) {
      // Beitrittszeit bleibt bestehen
    }
  },
};

export default voiceStateUpdateEvent;
