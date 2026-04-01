import { Events, Message, TextChannel } from 'discord.js';
import { BotEvent } from '../types';
import { logger, logAudit } from '../utils/logger';
import prisma from '../database/prisma';
import { checkRateLimit, detectSpam } from '../utils/rateLimiter';
import { processAutoResponse } from '../modules/ai/aiHandler';

// Anti-Spam: Nachrichtenhistorie pro User
const messageHistory: Map<string, { content: string; timestamp: number }[]> = new Map();

/**
 * MessageCreate-Event: Nachrichtenverarbeitung.
 * Sektion 4: Auto-Mod, Anti-Spam, Filter.
 * Sektion 8: XP-Vergabe.
 * Sektion 11: Nachrichtenlogging.
 */
const messageCreateEvent: BotEvent = {
  name: Events.MessageCreate,
  execute: async (message: unknown) => {
    const msg = message as Message;

    // Bots ignorieren
    if (msg.author.bot) return;
    if (!msg.guild) return;

    // Channel mit send()-Methode casten
    const channel = msg.channel as TextChannel;

    // ===== SEKTION 4: AUTO-MOD & ANTI-SPAM =====
    try {
      // Anti-Spam Detection
      const userId = msg.author.id;
      const history = messageHistory.get(userId) || [];
      history.push({ content: msg.content, timestamp: Date.now() });

      // Nur letzte 20 Nachrichten behalten
      if (history.length > 20) history.splice(0, history.length - 20);
      messageHistory.set(userId, history);

      if (detectSpam(history)) {
        logAudit('SPAM_DETECTED', 'MODERATION', {
          userId,
          channelId: msg.channelId,
          messageCount: history.length,
        });

        // Auto-Mod: Warnung senden
        try {
          await msg.delete();
          await channel.send({
            content: `⚠️ ${msg.author}, Spam erkannt! Bitte halte dich an die Serverregeln.`,
          });
        } catch (e) {
          // Möglicherweise fehlende Berechtigungen
        }
        return;
      }

      // Auto-Mod Filter prüfen
      const filters = await prisma.autoModFilter.findMany({
        where: { isActive: true },
      });

      for (const filter of filters) {
        let matches = false;

        switch (filter.filterType) {
          case 'KEYWORD':
            matches = msg.content.toLowerCase().includes(filter.pattern.toLowerCase());
            break;
          case 'REGEX':
            try {
              matches = new RegExp(filter.pattern, 'i').test(msg.content);
            } catch {
              // Ungültiger Regex
            }
            break;
          case 'LINK':
            matches = /https?:\/\/\S+/i.test(msg.content);
            break;
          case 'INVITE':
            matches = /discord\.(gg|io|me|li)|discordapp\.com\/invite/i.test(msg.content);
            break;
          case 'CAPS':
            const capsRatio = (msg.content.match(/[A-Z]/g) || []).length / Math.max(msg.content.length, 1);
            matches = capsRatio > 0.7 && msg.content.length > 10;
            break;
          case 'EMOJI_SPAM':
            const emojiCount = (msg.content.match(/<a?:\w+:\d+>|[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}]/gu) || []).length;
            matches = emojiCount > 10;
            break;
          case 'MENTION_SPAM':
            matches = (msg.mentions.users.size + msg.mentions.roles.size) > 5;
            break;
        }

        if (matches) {
          // Channel-Beschränkung prüfen
          if (filter.channelIds) {
            const channelList = filter.channelIds as string[];
            if (!channelList.includes(msg.channelId)) continue;
          }

          logAudit('AUTOMOD_TRIGGERED', 'MODERATION', {
            userId,
            channelId: msg.channelId,
            filterType: filter.filterType,
            pattern: filter.pattern,
            severity: filter.severity,
          });

          try {
            await msg.delete();
            await channel.send({
              content: `⚠️ ${msg.author}, deine Nachricht wurde durch den Auto-Mod entfernt.`,
            });
          } catch (e) {
            // Möglicherweise fehlende Berechtigungen
          }
          return;
        }
      }
    } catch (error) {
      logger.error('Auto-Mod Fehler:', error);
    }

    // ===== SEKTION 4: AI AUTO-RESPONDER =====
    try {
      const autoResp = await processAutoResponse(msg.content, msg.author.id, msg.channelId);
      if (autoResp.shouldRespond && autoResp.response) {
        await msg.reply({ content: autoResp.response });
      }
    } catch (error) {
      logger.error('Auto-Responder Fehler:', error);
    }

    // ===== SEKTION 8: XP-VERGABE =====
    try {
      const user = await prisma.user.findUnique({
        where: { discordId: msg.author.id },
      });

      if (user) {
        // XP-Cooldown prüfen (Anti-Spam für XP)
        const xpConfig = await prisma.xpConfig.findFirst({ where: { isActive: true } });
        const cooldownSeconds = xpConfig?.xpCooldownSeconds || 60;

        const levelData = await prisma.levelData.findUnique({
          where: { userId: user.id },
        });

        const now = new Date();
        if (levelData?.lastXpGain) {
          const timeSinceLastXp = now.getTime() - levelData.lastXpGain.getTime();
          if (timeSinceLastXp < cooldownSeconds * 1000) {
            return; // XP-Cooldown aktiv
          }
        }

        // XP berechnen
        const xpMin = xpConfig?.messageXpMin || 15;
        const xpMax = xpConfig?.messageXpMax || 25;
        const xpAmount = Math.floor(Math.random() * (xpMax - xpMin + 1)) + xpMin;
        const multiplier = xpConfig?.levelMultiplier || 1.0;
        const totalXp = Math.floor(xpAmount * multiplier);

        // XP vergeben
        const updated = await prisma.levelData.upsert({
          where: { userId: user.id },
          create: {
            userId: user.id,
            xp: BigInt(totalXp),
            totalMessages: 1,
            lastXpGain: now,
          },
          update: {
            xp: { increment: BigInt(totalXp) },
            totalMessages: { increment: 1 },
            lastXpGain: now,
          },
        });

        // XP-Record speichern
        await prisma.xpRecord.create({
          data: {
            userId: user.id,
            amount: totalXp,
            source: 'MESSAGE',
            channelId: msg.channelId,
          },
        });

        // Level-Up prüfen
        const currentXp = Number(updated.xp);
        const newLevel = calculateLevel(currentXp);

        if (newLevel > updated.level) {
          await prisma.levelData.update({
            where: { userId: user.id },
            data: { level: newLevel },
          });

          // Level-Up Nachricht
          await channel.send({
            content: `🎉 ${msg.author} hat **Level ${newLevel}** erreicht! Glückwunsch!`,
          });

          // Level-Belohnung prüfen (Sektion 8: Levelaufstieg mit Rollen und Belohnungen)
          const reward = await prisma.levelReward.findUnique({
            where: { level: newLevel },
          });

          if (reward?.roleId && msg.member) {
            try {
              await msg.member.roles.add(reward.roleId, `Level ${newLevel} erreicht`);

              await prisma.userRoleAssignment.create({
                data: {
                  userId: user.id,
                  roleId: reward.roleId,
                  assignedBy: 'auto',
                  reason: `Level ${newLevel} Belohnung`,
                },
              });

              if (reward.reward) {
                await channel.send({
                  content: `🏆 ${msg.author} erhält Belohnung: **${reward.reward}**`,
                });
              }
            } catch (e) {
              logger.error(`Level-Belohnung konnte nicht vergeben werden:`, e);
            }
          }

          logAudit('LEVEL_UP', 'LEVEL', {
            userId: user.id,
            newLevel,
            totalXp: currentXp,
          });
        }
      }
    } catch (error) {
      logger.error('XP-System Fehler:', error);
    }
  },
};

/**
 * Berechnet das Level basierend auf XP.
 * Formel: XP = 100 * (level^2) + 50 * level
 */
function calculateLevel(xp: number): number {
  let level = 0;
  while (xpForLevel(level + 1) <= xp) {
    level++;
  }
  return level;
}

function xpForLevel(level: number): number {
  return 100 * (level * level) + 50 * level;
}

export default messageCreateEvent;
