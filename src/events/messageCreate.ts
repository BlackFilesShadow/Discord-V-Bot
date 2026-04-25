import { Events, Message, TextChannel, AttachmentBuilder } from 'discord.js';
import { BotEvent } from '../types';
import { logger, logAudit } from '../utils/logger';
import prisma from '../database/prisma';
import { checkRateLimit, detectSpam } from '../utils/rateLimiter';
import { processAutoResponse } from '../modules/ai/aiHandler';
import { answerQuestion } from '../modules/ai/aiHandler';
import { buildServerUserContext } from '../modules/ai/contextBuilder';
import { trackMemberActivity } from '../modules/ai/memberAwareness';
import { listTriggers, findMatchingTrigger, isOnCooldown, renderTemplate } from '../modules/ai/triggers';
import { resolveCustomEmotes } from '../modules/ai/emoteResolver';
import { getLevelUpMessage, getMaxLevelRewardMessage } from '../modules/xp/levelMessages.js';
import { handleTicketDm } from '../modules/ticket/ticketManager';

// Anti-Spam: Nachrichtenhistorie pro User
const messageHistory: Map<string, { content: string; timestamp: number }[]> = new Map();

/**
 * Markdown-bewusstes Splitting fuer Discord-Nachrichten (max ~2000 Zeichen).
 *
 * Ziele:
 * - bevorzugt an Zeilenumbruechen splitten, damit Saetze nicht zerschnitten werden
 * - niemals einen offenen ```code-fence``` ueber mehrere Nachrichten ziehen,
 *   sondern den Fence am Splitpunkt schliessen und im naechsten Chunk wieder
 *   oeffnen (mit derselben Sprache, falls erkennbar).
 */
function splitForDiscord(text: string, maxLen = 1900): string[] {
  if (text.length <= maxLen) return [text];

  const out: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf('\n', maxLen);
    if (cut < Math.floor(maxLen * 0.5)) {
      // Keine sinnvolle Zeilen-Grenze gefunden - hart schneiden
      cut = maxLen;
    }
    let chunk = remaining.slice(0, cut);
    remaining = remaining.slice(cut).replace(/^\n/, '');

    // Code-Fence-Bilanz pruefen: ungerade Anzahl ``` => offener Block
    const fenceMatches = chunk.match(/```/g);
    const fenceCount = fenceMatches ? fenceMatches.length : 0;
    if (fenceCount % 2 === 1) {
      // Sprache des letzten Fence ermitteln (falls vorhanden), um sie im
      // naechsten Chunk wieder zu eroeffnen.
      const lastFence = chunk.lastIndexOf('```');
      const afterFence = chunk.slice(lastFence + 3);
      const langMatch = afterFence.match(/^([a-zA-Z0-9_+-]{0,20})\b/);
      const lang = langMatch ? langMatch[1] : '';
      chunk = chunk + '\n```';
      remaining = '```' + lang + '\n' + remaining;
    }
    out.push(chunk);
  }
  if (remaining.length > 0) out.push(remaining);
  return out;
}

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
    if (!msg.guild) {
      // DM: pruefe Ticket-Bridge
      try {
        await handleTicketDm(msg);
      } catch (e) {
        logger.error('Ticket-DM Bridge Fehler:', e);
      }
      return;
    }

    // STALE-MESSAGE-FILTER: Nachrichten älter als 30s ignorieren.
    // Schutz gegen Gateway-Replays nach Container-Restart, die zu Doppelantworten
    // führen würden (alter Container hat schon geantwortet, neuer bekommt Replay).
    const ageMs = Date.now() - msg.createdTimestamp;
    if (ageMs > 30_000) {
      logger.warn(`messageCreate ignoriert: ${ageMs}ms alt (Gateway-Replay nach Restart vermutet) msgId=${msg.id}`);
      return;
    }

    // Dedup: dieselbe Nachricht nie zweimal verarbeiten (Gateway kann nach Reconnect replayen).
    if (processedMessages.has(msg.id)) {
      logger.warn(`Doppelte messageCreate fuer ${msg.id} ignoriert (Gateway-Replay).`);
      return;
    }
    processedMessages.set(msg.id, Date.now());

    // Phase 18: Per-Guild Member-Profil-Tracking (throttled, best-effort).
    if (msg.member) {
      void trackMemberActivity(msg.member);
    }

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

    // ===== "STELL DICH VOR" / "WAS KANNST DU" – Priorität vor allen AI/Trigger/Auto-Respondern =====
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
      if ((isMentioned || isReplyToBot) && !msg.mentions.everyone) {
        const cleaned = msg.content
          .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
          .trim()
          .toLowerCase();

        const ABOUT_TEXT =
          '🤖 **Discord-V-Bot – Dein smarter Community-Manager**\n\n' +
          'Hallo! Ich bin **Discord-V-Bot** – dein vielseitiger, sicherer und datenschutzkonformer ' +
          'All-in-One-Bot für Discord-Server mit Anspruch.\n' +
          'Ob Community, Entwicklerteam oder Organisation: Ich unterstütze dich bei allem, was moderne Server brauchen.\n\n' +
          '🔒 **Datenschutz made in EU** – DSGVO-Ready, Consent-Management, Audit-Logs.\n' +
          '🛡️ **Sicherheit first** – Virenscan, Rechteverwaltung, 2FA, OTP-Login.\n' +
          '📦 **Datei- & Paketverwaltung** – bis 2 GB pro Datei, Validierung, Soft-Delete.\n' +
          '🏭 **Hersteller- & User-Management** – Bewerbungen, Rollen, Statistiken.\n' +
          '📝 **Feedback-, Support- & Appeal-System** für faire Community-Entscheidungen.\n' +
          '⚙️ **Automatisierung** – Reminder, Scheduler, XP/Level, Self-Roles, Polls, Giveaways.\n' +
          '🌐 **Dashboard & API** für externe Tools.\n\n' +
          'Frag mich `was kannst du?` für eine detaillierte Funktions-Übersicht.\n' +
          'Oder nutze `/help` für alle Befehle.';

        const FEATURES_TEXT =
          '🛠️ **Meine Funktionen im Detail**\n\n' +
          '**🔒 Datenschutz & Compliance**\n' +
          '• DSGVO-Einwilligungs-Management & Audit-Logs\n' +
          '• Compliance-Check (`/admin-audit compliance`) inkl. Übersicht & Export\n' +
          '• Datenexport (Audit, User, Pakete) als JSON/CSV\n\n' +
          '**📦 Datei- & Paketverwaltung**\n' +
          '• Upload bis zu 10 Dateien gleichzeitig (XML/JSON, bis 2 GB)\n' +
          '• Virenscan, Hash-Integritätsprüfung, Validierung\n' +
          '• Pakete pro Hersteller einzigartig (case-insensitive), Soft-Delete\n' +
          '• Download-Übersicht mit Statistiken\n\n' +
          '**🏭 Hersteller- & User-Management**\n' +
          '• Hersteller-Bewerbung, Admin-Review, Status-Reset\n' +
          '• Rollen- und Rechteverwaltung, Self-Role-Menüs\n' +
          '• OTP-Login & Zwei-Faktor-Authentifizierung\n\n' +
          '**🛡️ Moderation & Sicherheit**\n' +
          '• Auto-Mod (Spam, Caps, Links, Invites, Mention-Spam, Regex)\n' +
          '• Bann/Kick/Mute mit Case-Management & Appeal-System\n' +
          '• Rate-Limiting, Security-Events-Logging, API-Key-Verwaltung\n\n' +
          '**📝 Feedback & Support**\n' +
          '• Feedback-System pro Guild + globalem Fallback-Channel\n' +
          '• Ticket-System per DM-Bridge\n' +
          '• Appeal-Modul für Bann-Einsprüche\n\n' +
          '**🤖 KI-Features**\n' +
          '• ChatGPT-Style Antworten bei Erwähnung (mit Verlaufs-Kontext)\n' +
          '• Auto-Responder & Owner-definierte Trigger pro Guild\n' +
          '• Member-Awareness, RAG mit pgvector\n' +
          '• Auto-Übersetzung (`/translate-post`) in 10 Sprachen, mit Rollen-Ping & Scheduler\n\n' +
          '**📊 Audit & Transparenz**\n' +
          '• Lückenlose Aktions-Protokollierung (Volltext-Suche)\n' +
          '• Audit-Export für jeden Zeitraum\n\n' +
          '**⚙️ Community & Automatisierung**\n' +
          '• Level- & XP-System mit Levelrollen + Level-Up-Nachrichten\n' +
          '• Reminder-Scheduler (täglich/wöchentlich/monatlich/stündlich)\n' +
          '• Giveaways, Polls, Self-Role-Menüs\n' +
          '• Automatische Rollenvergabe & Eventrollen\n\n' +
          '**🌐 Dashboard & API**\n' +
          '• Web-Dashboard zur Verwaltung\n' +
          '• REST-API & Webhooks für externe Integrationen\n\n' +
          'Tipp: `/help` zeigt dir alle verfügbaren Slash-Commands.';

        // Normalisiere fuer striktes Matching: nur Buchstaben/Ziffern/Spaces, kollabierte Spaces
        const normalized = cleaned
          .replace(/[^\p{L}\p{N}\s]/gu, ' ')
          .replace(/\s+/g, ' ')
          .trim();

        // Whitelist exakter Trigger-Phrasen (case-insensitive). Nur wenn die
        // bereinigte Nachricht GENAU einer dieser Phrasen entspricht, antworten
        // wir mit dem Vorstellungs-/Funktions-Text. Sonst geht alles an die KI.
        const ABOUT_TRIGGERS = new Set([
          'stell dich vor',
          'stelle dich vor',
          'stell dich bitte vor',
          'stelle dich bitte vor',
          'wer bist du',
          'wer bist du eigentlich',
          'vorstellen',
        ]);

        const FEATURES_TRIGGERS = new Set([
          'was kannst du',
          'was kannst du alles',
          'was kannst du eigentlich',
          'was kannst du so',
          'deine funktionen',
          'zeig deine funktionen',
          'zeige deine funktionen',
          'was sind deine funktionen',
          'welche funktionen hast du',
        ]);

        // 1) "Stell dich vor" / "Wer bist du" -> ABOUT
        if (ABOUT_TRIGGERS.has(normalized)) {
          logger.info(`STELL-DICH-VOR feuert msgId=${msg.id} userId=${msg.author.id}`);
          await msg.reply({ content: ABOUT_TEXT, allowedMentions: { repliedUser: true, parse: [] } });
          return;
        }

        // 2) "Was kannst du" -> FEATURES (in Chunks, da > 2000 Zeichen)
        if (FEATURES_TRIGGERS.has(normalized)) {
          logger.info(`WAS-KANNST-DU feuert msgId=${msg.id} userId=${msg.author.id}`);
          const chunks = FEATURES_TEXT.match(/[\s\S]{1,1900}/g) || [FEATURES_TEXT];
          await msg.reply({ content: chunks[0], allowedMentions: { repliedUser: true, parse: [] } });
          for (const c of chunks.slice(1)) {
            await channel.send({ content: c, allowedMentions: { parse: [] } });
          }
          return;
        }
      }
    } catch (e) {
      logger.error('Stell-dich-vor / Was-kannst-du Fehler:', e);
    }

    // ===== SEKTION 4: AI AUTO-RESPONDER =====
    let autoResponded = false;
    try {
      const autoResp = await processAutoResponse(msg.content, msg.author.id, msg.channelId);
      if (autoResp.shouldRespond && autoResp.response) {
        logger.info(`AUTO-RESPONDER feuert msgId=${msg.id} userId=${msg.author.id}`);
        await msg.reply({ content: autoResp.response });
        autoResponded = true;
      }
    } catch (error) {
      logger.error('Auto-Responder Fehler:', error);
    }

    // ===== SEKTION 4: AI MENTION-RESPONDER (ChatGPT-Style) =====
    // Bot antwortet wenn er direkt erwähnt wird oder die Nachricht eine Reply auf den Bot ist
    try {
      // Wenn bereits eine Auto-Response gefeuert hat, KEINE zweite Antwort schicken.
      if (autoResponded) throw new Error('__skip_mention__');

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
                const triggerCtx = await buildServerUserContext({
                  guild: msg.guild,
                  channel: msg.channel as any,
                  member: msg.member ?? undefined,
                  user: msg.author,
                  question: msg.content,
                });
                const r = await answerQuestion(
                  matched.aiPrompt
                    ? `${matched.aiPrompt}\n\nNachricht des Nutzers: ${msg.content}`
                    : msg.content,
                  { mode: 'trigger', context: triggerCtx ?? undefined },
                );
                if (r.success && r.result) {
                  responseText = r.result;
                } else if (r.error === 'RATE_LIMIT') {
                  responseText = '⏳ Mein KI-Kontingent ist gerade ausgeschöpft. Bitte versuch es in ein paar Minuten nochmal.';
                } else {
                  // Fallback: stiller Skip statt hässlicher Fehlermeldung
                  return;
                }
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
                logger.info(`TRIGGER feuert msgId=${msg.id} triggerId=${matched.id} guildId=${msg.guildId}`);
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
        logger.info(
          `AI Mention empfangen msgId=${msg.id} userId=${msg.author.id} channelId=${msg.channelId} reply=${isReplyToBot} mention=${isMentioned}`,
        );
        // Mention aus dem Text entfernen, damit die Frage sauber ist
        const question = msg.content
          .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
          .trim();

        // ...sonst wie gehabt:
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
                const txt = m.content?.trim() || '';
                return txt.length > 0;
              })
              .slice(-12)
              .map(m => {
                const isBot = m.author.id === me;
                const speaker = isBot ? 'V-Bot (du selbst)' : m.author.username;
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

          const serverUserCtx = await buildServerUserContext({
            guild: msg.guild,
            channel: msg.channel as any,
            member: msg.member ?? undefined,
            user: msg.author,
            question,
          });
          const mergedContext = [serverUserCtx, context].filter(Boolean).join('\n\n') || undefined;

          const r = await answerQuestion(question, {
            mode: 'chat',
            context: mergedContext,
            userId: msg.author.id,
            channelId: msg.channel.id,
            guildId: msg.guildId,
          });
          if (r.success && r.result) {
            let cleaned = r.result
              .replace(/<@!?\d+>/g, '')
              .replace(/^\s*@[\w.]+[,:\s]*/i, '')
              .replace(/[ \t]{2,}/g, ' ')
              .trim();
            if (cleaned.length === 0) cleaned = '...';
            // Markdown-bewusstes Chunking: Wir versuchen an Zeilenumbruechen
            // zu splitten und niemals einen offenen Code-Fence (```) ueber
            // mehrere Nachrichten ziehen zu lassen. Discord rendert sonst
            // den Codeblock kaputt.
            const chunks = splitForDiscord(cleaned, 1900);
            await msg.reply({
              content: chunks[0],
              allowedMentions: { repliedUser: true, parse: [] },
            });
            for (const c of chunks.slice(1)) {
              await channel.send({ content: c, allowedMentions: { parse: [] } });
            }
          } else {
            const userMsg =
              r.error === 'RATE_LIMIT'
                ? '⏳ Mein KI-Kontingent ist gerade ausgeschöpft (Rate-Limit). Bitte versuch es in ein paar Minuten nochmal.'
                : "🤔 Hmm, da hat gerade etwas nicht geklappt. Versuch's bitte gleich nochmal.";
            await msg.reply({
              content: userMsg,
              allowedMentions: { repliedUser: true, parse: [] },
            });
          }

          logAudit('AI_MENTION_RESPONSE', 'AI', {
            userId: msg.author.id,
            channelId: msg.channelId,
            questionLength: question.length,
          });
          return;
        }
      }
    } catch (error) {
      if ((error as Error).message !== '__skip_mention__') {
        logger.error('AI Mention-Responder Fehler:', error);
      }
    }

    // ===== SEKTION 8: XP-VERGABE (guild-getrennt) =====
    try {
      // Kein XP in DMs / ohne Guild-Kontext.
      if (!msg.guildId) return;

      const user = await prisma.user.findUnique({
        where: { discordId: msg.author.id },
      });

      if (user) {
        // Guild-spezifische XP-Konfiguration (id == guildId)
        const xpConfig = await prisma.xpConfig.findUnique({ where: { id: msg.guildId } });

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
          where: { userId_guildId: { userId: user.id, guildId: msg.guildId! } },
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
          where: { userId_guildId: { userId: user.id, guildId: msg.guildId! } },
          create: {
            userId: user.id,
            guildId: msg.guildId!,
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
            guildId: msg.guildId!,
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
            where: { userId_guildId: { userId: user.id, guildId: msg.guildId! } },
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
          if (newLevel >= maxLevel && xpConfig?.maxLevelRoleId && msg.member && msg.guild) {
            try {
              if (!msg.member.roles.cache.has(xpConfig.maxLevelRoleId)) {
                const me = msg.guild.members.me;
                const targetRole = msg.guild.roles.cache.get(xpConfig.maxLevelRoleId);
                if (!targetRole) {
                  logger.warn(`Max-Level-Rolle ${xpConfig.maxLevelRoleId} existiert nicht in Guild ${msg.guildId}`);
                } else if (!me?.permissions.has('ManageRoles')) {
                  logger.warn(`Bot hat keine ManageRoles-Permission in Guild ${msg.guildId}`);
                } else if (me.roles.highest.comparePositionTo(targetRole) <= 0) {
                  logger.warn(`Bot-Rolle (${me.roles.highest.name}) steht NICHT über Max-Level-Rolle (${targetRole.name}) in Guild ${msg.guildId}`);
                } else {
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
              }
            } catch (e) {
              logger.error('Max-Level-Rolle konnte nicht vergeben werden:', e);
            }
          }

          // Level-Belohnung prüfen — Rolle aus LevelRole (per Guild konfigurierbar via /xp-config levelrole)
          // sowie Fallback aus globaler LevelReward-Tabelle.
          let rewardRoleId: string | null = null;
          let rewardText: string | null = null;

          if (msg.guildId) {
            const guildLevelRole = await prisma.levelRole.findUnique({
              where: { guildId_level: { guildId: msg.guildId, level: newLevel } },
            });
            if (guildLevelRole?.roleId) {
              rewardRoleId = guildLevelRole.roleId;
            }
          }

          // Fallback: globale Level-Belohnung
          if (!rewardRoleId) {
            const globalReward = await prisma.levelReward.findUnique({
              where: { level: newLevel },
            });
            if (globalReward?.roleId) rewardRoleId = globalReward.roleId;
            if (globalReward?.reward) rewardText = globalReward.reward;
          }

          if (rewardRoleId && msg.member && msg.guild) {
            try {
              if (!msg.member.roles.cache.has(rewardRoleId)) {
                const me = msg.guild.members.me;
                const targetRole = msg.guild.roles.cache.get(rewardRoleId);
                if (!targetRole) {
                  logger.warn(`Level-Belohnungsrolle ${rewardRoleId} (Level ${newLevel}) existiert nicht in Guild ${msg.guildId}`);
                } else if (!me?.permissions.has('ManageRoles')) {
                  logger.warn(`Bot hat keine ManageRoles-Permission in Guild ${msg.guildId} — Level ${newLevel} Rolle nicht vergeben`);
                } else if (me.roles.highest.comparePositionTo(targetRole) <= 0) {
                  logger.warn(`Bot-Rolle (${me.roles.highest.name}) steht NICHT über Level-Rolle (${targetRole.name}) in Guild ${msg.guildId} — Level ${newLevel} Rolle nicht vergeben`);
                } else {
                  await msg.member.roles.add(rewardRoleId, `Level ${newLevel} erreicht`);

                  await prisma.userRoleAssignment.create({
                    data: {
                      userId: user.id,
                      roleId: rewardRoleId,
                      assignedBy: 'auto',
                      reason: `Level ${newLevel} Belohnung`,
                    },
                  });

                  logAudit('LEVEL_ROLE_GRANTED', 'LEVEL', {
                    userId: user.id,
                    roleId: rewardRoleId,
                    level: newLevel,
                    guildId: msg.guildId,
                  });

                  if (rewardText) {
                    await channel.send({
                      content: `🏆 ${msg.author} erhält Belohnung: **${rewardText}**`,
                    });
                  }
                }
              }
            } catch (e) {
              logger.error(`Level-Belohnung konnte nicht vergeben werden (Rolle ${rewardRoleId}, Level ${newLevel}):`, e);
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
