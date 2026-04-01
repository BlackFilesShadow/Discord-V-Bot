import { VoiceState } from 'discord.js';
import prisma from '../database/prisma';
import { logger, logAudit } from '../utils/logger';
import { BotEvent } from '../types';

/**
 * Voice-XP-Tracking (Sektion 8):
 * User erhalten XP für Voice-Aktivität.
 * Trackt Beitritts- und Verlassenszeit.
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

      try {
        const dbUser = await prisma.user.findUnique({ where: { discordId: userId } });
        if (!dbUser) return;

        // XP: 2 XP pro Minute Voice (konfigurierbar über XpConfig)
        const xpConfig = await prisma.xpConfig.findFirst({
          where: { isActive: true },
        });

        const xpPerMinute = 2; // Standard
        const xpGained = Math.min(durationMinutes * xpPerMinute, 500); // Max 500 XP pro Session

        const levelData = await prisma.levelData.upsert({
          where: { userId: dbUser.id },
          create: {
            userId: dbUser.id,
            xp: xpGained,
            voiceMinutes: durationMinutes,
          },
          update: {
            xp: { increment: xpGained },
            voiceMinutes: { increment: durationMinutes },
          },
        });

        // XP-Record erstellen
        await prisma.xpRecord.create({
          data: {
            userId: dbUser.id,
            amount: xpGained,
            source: 'VOICE',
            channelId: oldState.channelId || undefined,
          },
        });

        // Level-Up prüfen
        const currentXp = Number(levelData.xp);
        const xpForNextLevel = (levelData.level + 1) * 100;
        if (currentXp >= xpForNextLevel) {
          const newLevel = levelData.level + 1;
          await prisma.levelData.update({
            where: { userId: dbUser.id },
            data: { level: newLevel },
          });

          // Level-Reward prüfen
          const reward = await prisma.levelReward.findFirst({
            where: { level: newLevel },
          });

          if (reward && reward.roleId && newState.member) {
            try {
              await newState.member.roles.add(reward.roleId);
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
