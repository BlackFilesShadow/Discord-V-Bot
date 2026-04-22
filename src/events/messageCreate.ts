import { Events, Message, TextChannel, AttachmentBuilder } from 'discord.js';
import { BotEvent } from '../types';
import { logger, logAudit } from '../utils/logger';
import prisma from '../database/prisma';
import { checkRateLimit, detectSpam } from '../utils/rateLimiter';
import { processAutoResponse } from '../modules/ai/aiHandler';
import { answerQuestion } from '../modules/ai/aiHandler';
import { listTriggers, findMatchingTrigger, isOnCooldown, renderTemplate } from '../modules/ai/triggers';
import { resolveCustomEmotes } from '../modules/ai/emoteResolver';
import { getLevelUpMessage, getMaxLevelRewardMessage } from '../modules/xp/levelMessages.js';

// Anti-Spam: Nachrichtenhistorie pro User
const messageHistory: Map<string, { content: string; timestamp: number }[]> = new Map();

// Dedup: verarbeitete Message-IDs (defensiv gegen Gateway-Replays bei Reconnect).
const processedMessages: Map<string, number> = new Map();
const PROCESSED_TTL_MS = 60 * 1000; // 60s reichen, Discord redeliver-Fenster ist kurz.
setInterval(() => {
  const cutoff = Date.now() - PROCESSED_TTL_MS;
  for (const [id, ts] of processedMessages) {
    if (ts < cutoff) processedMessages.delete(id);
  }
}, 60 * 1000).unref?.();

// Periodischer Cleanup: Eintr\u00e4ge \u00e4lter als 5 Min entfernen, leere User droppen
setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [userId, history] of messageHistory) {
    const filtered = history.filter(h => h.timestamp > cutoff);
    if (filtered.length === 0) messageHistory.delete(userId);
    else messageHistory.set(userId, filtered);
  }
}, 5 * 60 * 1000).unref?.();

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

    // Dedup: dieselbe Nachricht nie zweimal verarbeiten (Gateway kann nach Reconnect replayen).
    if (processedMessages.has(msg.id)) {
      logger.warn(`Doppelte messageCreate fuer ${msg.id} ignoriert (Gateway-Replay).`);
      return;
    }
    processedMessages.set(msg.id, Date.now());

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

      // Channel-Filter: leeres Array gilt als "alle Channels"
      const channelMatches = (raw: unknown): boolean => {
        if (!raw) return true;
        if (!Array.isArray(raw) || raw.length === 0) return true;
        return (raw as string[]).includes(msg.channelId);
      };

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
          // Channel-Beschränkung prüfen (leer = alle)
          if (!channelMatches(filter.channelIds)) continue;

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

    // ===== SEKTION 4: AI MENTION-RESPONDER (ChatGPT-Style) =====
    // Bot antwortet wenn er direkt erwähnt wird oder die Nachricht eine Reply auf den Bot ist
    try {
      const botId = msg.client.user?.id;
      const isMentioned = botId ? msg.mentions.users.has(botId) : false;
      const isReplyToBot =
        msg.reference?.messageId
          ? await msg.channel.messages
              .fetch(msg.reference.messageId)
              .then(m => m.author.id === botId)
              .catch(() => false)
          : false;

      // ===== OWNER-DEFINIERTE TRIGGER (max 10/Guild) =====
      if (msg.guildId) {
        try {
          const triggers = await listTriggers(msg.guildId);
          // Channel-Filter: nur Trigger, die im aktuellen Channel aktiv sind (oder \u00fcberall)
          const channelTriggers = triggers.filter(t => !t.channelId || t.channelId === msg.channelId);
          if (channelTriggers.length > 0) {
            const matched = findMatchingTrigger(channelTriggers, msg.content, isMentioned || isReplyToBot);
            if (matched && !isOnCooldown(msg.guildId, matched.id, matched.cooldownSeconds)) {
              await channel.sendTyping().catch(() => {});

              let responseText: string;
              if (matched.responseMode === 'ai') {
                const r = await answerQuestion(
                  matched.aiPrompt
                    ? `${matched.aiPrompt}\n\nNachricht des Nutzers: ${msg.content}`
                    : msg.content,
                );
                responseText = r.success && r.result ? r.result : '_(AI nicht verf\u00fcgbar)_';
              } else {
                // Mehrere Varianten getrennt durch ||| -> zuf\u00e4llig eine ausw\u00e4hlen
                const raw = matched.responseText || '';
                const variants = raw.split('|||').map(s => s.trim()).filter(s => s.length > 0);
                const pick = variants.length > 1
                  ? variants[Math.floor(Math.random() * variants.length)]
                  : raw;
                responseText = renderTemplate(pick, {
                  user: `<@${msg.author.id}>`,
                  channel: `<#${msg.channelId}>`,
                });
              }

              const files = matched.mediaUrl ? [new AttachmentBuilder(matched.mediaUrl)] : undefined;
              try {
                // Custom-Emojis :name: zur Sendezeit aufl\u00f6sen (Cache aktuell, alte Trigger profitieren auch)
                const finalText = resolveCustomEmotes(responseText, msg.guild);
                await msg.reply({
                  content: finalText.slice(0, 2000),
                  files,
                  allowedMentions: { repliedUser: true, parse: ['users'] },
                });
                logAudit('AI_TRIGGER_FIRED', 'AI', {
                  guildId: msg.guildId,
                  triggerId: matched.id,
                  userId: msg.author.id,
                });
              } catch (sendErr) {
                logger.warn('Trigger-Antwort konnte nicht gesendet werden:', sendErr as Error);
              }
              return; // Trigger hat gefeuert, kein weiterer Mention-Responder
            }
          }
        } catch (triggerErr) {
          logger.error('Trigger-Pr\u00fcfung Fehler:', triggerErr);
        }
      }

      // @everyone/@here ignorieren – muss explizite User-Mention sein
      if ((isMentioned || isReplyToBot) && !msg.mentions.everyone) {
        // Mention aus dem Text entfernen, damit die Frage sauber ist
        const question = msg.content
          .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
          .trim();

        if (question.length === 0) {
          await channel.send({
            content: `<@${msg.author.id}> Hi! Stell mir eine Frage – ich antworte gerne. 🤖`,
            allowedMentions: { users: [msg.author.id] },
          });
        } else if (question.length > 2000) {
          await channel.send({
            content: `<@${msg.author.id}> ⚠️ Deine Nachricht ist zu lang (max. 2000 Zeichen).`,
            allowedMentions: { users: [msg.author.id] },
          });
        } else {
          // "Tippt..."-Indikator
          await channel.sendTyping().catch(() => {});

          // Letzte ~15 Nachrichten als Konversations-Kontext (inkl. Bot-Antworten,
          // damit der Bot weiss, was er selbst eben gesagt hat und Pronomen wie
          // "er", "sie", "das" auf vorherige Nachrichten beziehen kann).
          let context: string | undefined;
          try {
            const recent = await msg.channel.messages.fetch({ limit: 15, before: msg.id });
            const me = msg.client.user?.id;
            const ctxLines = Array.from(recent.values())
              .reverse()
              .filter(m => {
                // Embeds ohne Text (z.B. System-Messages) ueberspringen
                const txt = m.content?.trim() || '';
                return txt.length > 0;
              })
              .slice(-12)
              .map(m => {
                const isBot = m.author.id === me;
                const speaker = isBot ? 'V-Bot (du selbst)' : m.author.username;
                // Discord-User-Mentions <@123> in Klartext-Namen umwandeln, damit der Bot Bezuege versteht
                let txt = m.content;
                for (const [, user] of m.mentions.users) {
                  txt = txt.replace(new RegExp(`<@!?${user.id}>`, 'g'), `@${user.username}`);
                }
                return `${speaker}: ${txt.slice(0, 400)}`;
              });
            if (ctxLines.length > 0) {
              context = [
                'Hier ist der bisherige Verlauf des Gespraechs in diesem Channel (chronologisch, aelteste zuerst).',
                'Nutze ihn, um Pronomen (er, sie, es, das, ihn, ihm) und Bezuege ("der oben genannte", "wie eben gesagt") aufzuloesen.',
                'Achte besonders auf deine eigenen vorherigen Antworten ("V-Bot (du selbst)") - du musst konsistent bleiben.',
                '',
                ctxLines.join('\n'),
                '',
                `Aktueller Sprecher der naechsten Frage: ${msg.author.username}`,
              ].join('\n');
            }
          } catch { /* Kontext ist optional */ }

          const r = await answerQuestion(question, context);
          if (r.success && r.result) {
            // Discord-Limit: 2000 Zeichen pro Nachricht – ggf. splitten
            // Wir senden bewusst KEIN reply(), damit Discord die Frage nicht nochmal als Quote anzeigt.
            const mention = `<@${msg.author.id}> `;
            const firstChunkBudget = 1900 - mention.length;
            const first = r.result.slice(0, firstChunkBudget);
            const rest = r.result.slice(firstChunkBudget);
            await channel.send({
              content: mention + first,
              allowedMentions: { users: [msg.author.id] },
            });
            if (rest.length > 0) {
              const more = rest.match(/[\s\S]{1,1900}/g) || [];
              for (const c of more) {
                await channel.send({ content: c, allowedMentions: { parse: [] } });
              }
            }
          } else {
            await channel.send({
              content: `<@${msg.author.id}> 🤔 Hmm, da hat gerade etwas nicht geklappt. Versuch's bitte gleich nochmal.`,
              allowedMentions: { users: [msg.author.id] },
            });
          }

          logAudit('AI_MENTION_RESPONSE', 'AI', {
            userId: msg.author.id,
            channelId: msg.channelId,
            questionLength: question.length,
          });
          return; // Keine weiteren Auto-Responder oder XP-Aktionen für reine AI-Anfragen
        }
      }
    } catch (error) {
      logger.error('AI Mention-Responder Fehler:', error);
    }

    // ===== SEKTION 8: XP-VERGABE =====
    try {
      const user = await prisma.user.findUnique({
        where: { discordId: msg.author.id },
      });

      if (user) {
        // Guild-spezifische XP-Konfiguration (id == guildId)
        const xpConfig = msg.guildId
          ? await prisma.xpConfig.findUnique({ where: { id: msg.guildId } })
          : null;

        // XP-System global deaktiviert?
        if (xpConfig && xpConfig.isActive === false) return;

        // Kanal-Filter (STRIKT): Wenn allowedChannelIds gesetzt, nur dort XP
        const allowedChannels = Array.isArray(xpConfig?.allowedChannelIds)
          ? (xpConfig!.allowedChannelIds as string[])
          : [];
        if (allowedChannels.length > 0 && !allowedChannels.includes(msg.channelId)) {
          return; // Nachricht nicht in einem berechtigten Kanal → kein XP
        }

        // Rollen-Filter: Wenn allowedRoleIds gesetzt, muss Member mind. eine davon haben
        const allowedRoles = Array.isArray(xpConfig?.allowedRoleIds)
          ? (xpConfig!.allowedRoleIds as string[])
          : [];
        if (allowedRoles.length > 0) {
          const member = msg.member;
          if (!member) return;
          const hasAllowed = allowedRoles.some(rid => member.roles.cache.has(rid));
          if (!hasAllowed) return; // User hat keine berechtigte Rolle → kein XP
        }

        // XP-Cooldown prüfen (Anti-Spam für XP)
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
        const maxLevel = xpConfig?.maxLevel ?? 20;
        let newLevel = calculateLevel(currentXp);
        if (newLevel > maxLevel) newLevel = maxLevel;

        if (newLevel > updated.level) {
          await prisma.levelData.update({
            where: { userId: user.id },
            data: { level: newLevel },
          });

          // Frecher DayZ-Glückwunsch
          try {
            await channel.send({
              content: getLevelUpMessage({
                user: msg.author.toString(),
                level: newLevel,
                username: msg.author.username,
              }),
              allowedMentions: { users: [msg.author.id] },
            });
          } catch (e) {
            logger.warn('Level-Up Nachricht konnte nicht gesendet werden', e);
          }

          // Max-Level erreicht? → Belohnungsrolle vergeben
          if (newLevel >= maxLevel && xpConfig?.maxLevelRoleId && msg.member) {
            try {
              if (!msg.member.roles.cache.has(xpConfig.maxLevelRoleId)) {
                await msg.member.roles.add(xpConfig.maxLevelRoleId, `Max-Level (${maxLevel}) erreicht`);
                await prisma.userRoleAssignment.create({
                  data: {
                    userId: user.id,
                    roleId: xpConfig.maxLevelRoleId,
                    assignedBy: 'auto',
                    reason: `Max-Level (${maxLevel}) Belohnung`,
                  },
                });
                await channel.send({
                  content: getMaxLevelRewardMessage(msg.author.toString(), xpConfig.maxLevelRoleId),
                  allowedMentions: { users: [msg.author.id] },
                });
                logAudit('MAX_LEVEL_ROLE_GRANTED', 'LEVEL', {
                  userId: user.id,
                  roleId: xpConfig.maxLevelRoleId,
                  level: maxLevel,
                });
              }
            } catch (e) {
              logger.error('Max-Level-Rolle konnte nicht vergeben werden:', e);
            }
          }

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
