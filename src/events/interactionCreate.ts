import {
  Events,
  Interaction,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ModalSubmitInteraction,
  ButtonInteraction,
  EmbedBuilder,
} from 'discord.js';
import { BotEvent, ExtendedClient } from '../types';
import { logger, logAudit } from '../utils/logger';
import { checkRateLimit } from '../utils/rateLimiter';
import { checkCooldown } from '../utils/cooldown';
import { commandCounter, commandDurationHistogram, rateLimitedCounter } from '../utils/metrics';
import { reportError } from '../utils/errorSink';
import prisma from '../database/prisma';
import { approveManufacturer, denyManufacturer } from '../modules/registration/register';
import { votePoll, getPollVotes, createPollEmbed } from '../modules/polls/pollSystem';
import { createGiveawayEmbed } from '../modules/giveaway/giveawayManager';
import { acceptTicket, denyTicket } from '../modules/ticket/ticketManager';
import { config } from '../config';
import { timingSafeEqual } from 'crypto';

// Pending Dev-Passwort-Verifizierungen
const pendingDevAuth = new Map<string, { commandName: string; userId: string; expires: number }>();

// Temporär authentifizierte Developer-Users (userId → expiresTimestamp)
// DEV-Session: 2 Stunden gültig
const devAuthenticatedUsers = new Map<string, number>();

const DEV_SESSION_MS = 2 * 60 * 60 * 1000; // 2 Stunden

// Brute-Force-Schutz: pro User max. 5 Fehlversuche, dann 15 Min Lockout
const devAuthFails = new Map<string, { count: number; lockedUntil: number }>();
const DEV_AUTH_MAX_FAILS = 5;
const DEV_AUTH_LOCKOUT_MS = 15 * 60 * 1000;

// Periodisches Cleanup für pendingDevAuth & devAuthFails (alle 5 Min)
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingDevAuth.entries()) {
    if (v.expires < now) pendingDevAuth.delete(k);
  }
  for (const [k, v] of devAuthFails.entries()) {
    if (v.lockedUntil < now && v.count < DEV_AUTH_MAX_FAILS) devAuthFails.delete(k);
    else if (v.lockedUntil > 0 && v.lockedUntil < now) devAuthFails.delete(k);
  }
  for (const [k, v] of devAuthenticatedUsers.entries()) {
    if (v < now) devAuthenticatedUsers.delete(k);
  }
}, 5 * 60 * 1000).unref?.();

/**
 * Timing-safe Passwort-Vergleich (verhindert Timing-Attack auf DEV_PASSWORD).
 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // Wenn Längen unterschiedlich → Vergleich auf gleichlange Puffer und false zurück
  if (bufA.length !== bufB.length) {
    // Trotzdem vergleichen, um konstante Laufzeit zu erzwingen
    const max = Math.max(bufA.length, bufB.length, 1);
    const padA = Buffer.alloc(max);
    const padB = Buffer.alloc(max);
    bufA.copy(padA);
    bufB.copy(padB);
    timingSafeEqual(padA, padB);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

// In-Memory Rate-Limit: 30 Commands / 60s pro User (synchron, 0ms)
const inMemRateLimit = new Map<string, { count: number; windowStart: number }>();
const RL_WINDOW = 60_000;
const RL_MAX = 30;

function checkInMemoryRateLimit(userId: string): boolean {
  const now = Date.now();
  const entry = inMemRateLimit.get(userId);
  if (!entry || now - entry.windowStart > RL_WINDOW) {
    inMemRateLimit.set(userId, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= RL_MAX) return false;
  entry.count++;
  return true;
}

/**
 * Prüft ob ein User Owner oder Guild-Owner ist.
 */
function isOwnerOrGuildOwner(userId: string, interaction: Interaction): boolean {
  if (userId === config.discord.ownerId) return true;
  if (interaction.guild && interaction.guild.ownerId === userId) return true;
  return false;
}

/**
 * Prüft ob ein User eine Admin-Rolle in der DB hat.
 */
async function hasAdminRole(discordId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { discordId } });
  if (!user) return false;
  return ['ADMIN', 'SUPER_ADMIN', 'DEVELOPER'].includes(user.role);
}

/**
 * Interaction-Create-Event
 *
 * Permission-Modell:
 * - Owner (BOT_OWNER_ID) + Guild-Owner → ALLES erlaubt, keine Einschränkungen
 * - Admin-Commands (adminOnly) → nur für User mit Admin-Rolle in DB (kein Passwort nötig)
 * - Dev-Commands (devOnly) → Passwort-Modal, 2-Stunden-Session
 */
const interactionCreateEvent: BotEvent = {
  name: Events.InteractionCreate,
  execute: async (interaction: unknown) => {
    const i = interaction as Interaction;

    // Modal-Submit verarbeiten (Dev-Passwort)
    if ('isModalSubmit' in i && (i as ModalSubmitInteraction).isModalSubmit()) {
      const modal = i as ModalSubmitInteraction;
      if (modal.customId.startsWith('dev_auth_')) {
        await handleDevPasswordModal(modal);
        return;
      }
    }

    // Button-Interaktionen verarbeiten (Approve/Deny Hersteller)
    if ('isButton' in i && (i as ButtonInteraction).isButton()) {
      const btn = i as ButtonInteraction;
      if (btn.customId.startsWith('approve_manufacturer_') || btn.customId.startsWith('deny_manufacturer_')) {
        await handleManufacturerButton(btn);
        return;
      }
      if (btn.customId.startsWith('poll_vote_')) {
        await handlePollVoteButton(btn);
        return;
      }
      if (btn.customId.startsWith('giveaway_enter_')) {
        await handleGiveawayEnterButton(btn);
        return;
      }
      if (btn.customId.startsWith('ticket_accept_') || btn.customId.startsWith('ticket_deny_')) {
        await handleTicketButton(btn);
        return;
      }
      // Help-Pagination wird direkt vom Collector in help.ts verarbeitet — hier nichts tun
    }

    if (!i.isChatInputCommand()) return;

    const client = i.client as ExtendedClient;
    const command = client.commands.get(i.commandName);

    if (!command) {
      logger.warn(`Unbekannter Command: ${i.commandName}`);
      return;
    }

    // In-memory Rate-Limit (synchron, 0 DB-Calls) um Discord's 3s-Timeout einzuhalten.
    // DB-basiertes Rate-Limit läuft zusätzlich in Hintergrund-Jobs.
    if (!checkInMemoryRateLimit(i.user.id)) {
      rateLimitedCounter.inc({ kind: 'in_memory' });
      commandCounter.inc({ command: i.commandName, status: 'ratelimit' });
      try {
        await i.reply({
          content: `⚠️ Zu viele Commands. Bitte einen Moment warten.`,
          ephemeral: true,
        });
      } catch { /* interaction evtl. abgelaufen */ }
      return;
    }

    // Per-Command-Cooldown (Owner umgeht Cooldown)
    if (command.cooldown && !isOwnerOrGuildOwner(i.user.id, i)) {
      const cd = checkCooldown(i.user.id, i.commandName, command.cooldown);
      if (!cd.ok) {
        rateLimitedCounter.inc({ kind: 'cooldown' });
        commandCounter.inc({ command: i.commandName, status: 'cooldown' });
        try {
          await i.reply({
            content: `⏳ Bitte noch **${cd.remainingSec}s** warten, bevor du \`/${i.commandName}\` erneut nutzt.`,
            ephemeral: true,
          });
        } catch { /* */ }
        return;
      }
    }

    // ──────────────────────────────────────────
    // PERMISSION-CHECK für Admin/Dev-Commands
    // ──────────────────────────────────────────
    if (command.adminOnly || command.devOnly || command.manufacturerOnly) {
      const userId = i.user.id;

      // 1) Owner/Guild-Owner → IMMER durchlassen (NUR für Admin/Dev,
      //    NICHT für Manufacturer-Commands! Uploads sind an einen GUID-Bereich
      //    gebunden, der nur durch echte /register manufacturer Verifizierung
      //    entsteht. Owner muss sich genauso registrieren.)
      if (isOwnerOrGuildOwner(userId, i) && !command.manufacturerOnly) {
        // Keine Prüfung nötig — direkt ausführen
      }
      // 2) Dev-Commands → Passwort-Authentifizierung (2h Session)
      else if (command.devOnly) {
        if (!config.developer.password) {
          await i.reply({ content: '🔒 Developer-Passwort nicht konfiguriert.', ephemeral: true });
          return;
        }

        // Lockout-Check vor Modal
        const fails = devAuthFails.get(userId);
        if (fails && fails.lockedUntil > Date.now()) {
          const remainMin = Math.ceil((fails.lockedUntil - Date.now()) / 60_000);
          await i.reply({
            content: `🔒 Zu viele Fehlversuche. Dev-Login gesperrt für **${remainMin} Min.**`,
            ephemeral: true,
          });
          logAudit('DEV_AUTH_BLOCKED_LOCKED', 'SECURITY', {
            userId,
            command: i.commandName,
            remainMin,
          });
          return;
        }

        const devExpires = devAuthenticatedUsers.get(userId);
        if (!devExpires || devExpires <= Date.now()) {
          devAuthenticatedUsers.delete(userId);

          const modalId = `dev_auth_${userId}_${Date.now()}`;
          pendingDevAuth.set(modalId, {
            commandName: i.commandName,
            userId,
            expires: Date.now() + 120_000,
          });

          const modal = new ModalBuilder()
            .setCustomId(modalId)
            .setTitle('🔐 Developer-Authentifizierung');

          const passwordInput = new TextInputBuilder()
            .setCustomId('dev_password')
            .setLabel('Developer-Passwort eingeben')
            .setPlaceholder('Passwort für den Developer-Bereich')
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

          const row = new ActionRowBuilder<TextInputBuilder>().addComponents(passwordInput);
          modal.addComponents(row);

          await i.showModal(modal);
          return;
        }
        // Sonst: Dev bereits authentifiziert → durchlassen
      }
      // 3) Admin-Commands → DB-Rolle prüfen (kein Passwort nötig)
      else if (command.adminOnly) {
        const isAdmin = await hasAdminRole(userId);
        if (!isAdmin) {
          await i.reply({
            content: '🔒 Keine Berechtigung. Du benötigst eine Admin-Rolle für diesen Command.',
            ephemeral: true,
          });
          logAudit('ADMIN_COMMAND_DENIED', 'SECURITY', {
            userId,
            command: i.commandName,
            reason: 'Keine Admin-Rolle',
          });
          return;
        }
        // Admin-Rolle vorhanden → durchlassen
      }
      // 4) Manufacturer-Commands → AUSSCHLIESSLICH isManufacturer=true UND status=ACTIVE
      //    Admins/Developer haben hier KEINEN Bypass — Upload ist ausnahmslos
      //    der Hersteller-Rolle vorbehalten.
      else if (command.manufacturerOnly) {
        const dbUser = await prisma.user.findUnique({ where: { discordId: userId } });
        if (!dbUser) {
          await i.reply({
            content: '🔒 Du bist nicht registriert. Verwende `/register manufacturer` um Hersteller zu werden.',
            ephemeral: true,
          });
          return;
        }
        if (!dbUser.isManufacturer) {
          await i.reply({
            content: '🔒 Nur registrierte **Hersteller** dürfen diesen Command nutzen. Beantrage Hersteller-Status mit `/register manufacturer`.',
            ephemeral: true,
          });
          logAudit('MANUFACTURER_COMMAND_DENIED', 'SECURITY', {
            userId,
            command: i.commandName,
            reason: 'Kein Hersteller',
          });
          return;
        }
        if (dbUser.status !== 'ACTIVE') {
          await i.reply({
            content: `🔒 Dein Account ist noch nicht aktiviert (Status: \`${dbUser.status}\`). Verwende \`/register verify password:DEIN_OTP\` mit dem Einmal-Passwort aus der DM.`,
            ephemeral: true,
          });
          return;
        }
        // Hersteller aktiv → durchlassen
      }
    }

    // Command ausführen
    const stopTimer = commandDurationHistogram.startTimer({ command: i.commandName });
    try {
      logAudit('COMMAND_EXECUTE', 'SYSTEM', {
        userId: i.user.id,
        command: i.commandName,
        channelId: i.channelId,
        guildId: i.guildId,
        options: i.options.data.map(o => ({ name: o.name, value: o.value })),
      });

      await command.execute(i);
      commandCounter.inc({ command: i.commandName, status: 'success' });
    } catch (error: any) {
      // 10062 (Unknown interaction) und 40060 (Already acknowledged) silently behandeln —
      // diese sind nicht durch Code-Bugs, sondern durch Discord-Latenz/Cold-Start verursacht.
      const code = error?.code ?? error?.rawError?.code;
      if (code === 10062 || code === 40060) {
        logger.warn(`Command ${i.commandName}: Interaction abgelaufen (${code}) — ignoriert.`);
        commandCounter.inc({ command: i.commandName, status: 'expired' });
        return;
      }

      logger.error(`Fehler bei Command ${i.commandName}:`, error);
      commandCounter.inc({ command: i.commandName, status: 'error' });
      reportError(error, {
        source: 'command',
        command: i.commandName,
        userId: i.user.id,
        guildId: i.guildId ?? undefined,
      });

      const errorMessage = '❌ Ein Fehler ist aufgetreten. Bitte versuche es erneut.';
      try {
        if (i.replied || i.deferred) {
          await i.followUp({ content: errorMessage, ephemeral: true });
        } else {
          await i.reply({ content: errorMessage, ephemeral: true });
        }
      } catch (replyError: any) {
        // Ignorieren wenn Antwort nicht mehr möglich
        logger.warn(`Konnte Fehler-Antwort nicht senden für ${i.commandName}: ${replyError?.message}`);
      }
    } finally {
      stopTimer();
    }
  },
};

// Periodisch abgelaufene Einträge bereinigen
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of pendingDevAuth) {
    if (value.expires < now) pendingDevAuth.delete(key);
  }
  for (const [key, value] of devAuthenticatedUsers) {
    if (value < now) devAuthenticatedUsers.delete(key);
  }
}, 60_000);

/**
 * Verarbeitet Developer-Passwort-Modal.
 * Bei Erfolg: 2-Stunden-Session freischalten.
 */
async function handleDevPasswordModal(modal: ModalSubmitInteraction): Promise<void> {
  const pendingData = pendingDevAuth.get(modal.customId);

  if (!pendingData || pendingData.expires < Date.now()) {
    pendingDevAuth.delete(modal.customId);
    await modal.reply({ content: '⏰ Authentifizierung abgelaufen. Bitte erneut versuchen.', ephemeral: true });
    return;
  }

  if (pendingData.userId !== modal.user.id) {
    await modal.reply({ content: '🔒 Unbefugter Zugriff.', ephemeral: true });
    return;
  }

  // Lockout-Check vor dem Vergleich
  const fails = devAuthFails.get(modal.user.id);
  if (fails && fails.lockedUntil > Date.now()) {
    const remainMin = Math.ceil((fails.lockedUntil - Date.now()) / 60_000);
    await modal.reply({
      content: `🔒 Zu viele Fehlversuche. Gesperrt für **${remainMin} Min.**`,
      ephemeral: true,
    });
    return;
  }

  const enteredPassword = modal.fields.getTextInputValue('dev_password');

  if (!safeEqual(enteredPassword, config.developer.password)) {
    pendingDevAuth.delete(modal.customId);

    // Fehlversuch zählen
    const cur = devAuthFails.get(modal.user.id) ?? { count: 0, lockedUntil: 0 };
    cur.count++;
    if (cur.count >= DEV_AUTH_MAX_FAILS) {
      cur.lockedUntil = Date.now() + DEV_AUTH_LOCKOUT_MS;
      logAudit('DEV_AUTH_LOCKOUT', 'SECURITY', {
        userId: modal.user.id,
        command: pendingData.commandName,
        fails: cur.count,
        lockoutMin: DEV_AUTH_LOCKOUT_MS / 60_000,
      });
    }
    devAuthFails.set(modal.user.id, cur);

    logAudit('DEV_AUTH_FAILED', 'SECURITY', {
      userId: modal.user.id,
      command: pendingData.commandName,
      fails: cur.count,
    });

    const remaining = DEV_AUTH_MAX_FAILS - cur.count;
    const msg = cur.lockedUntil > Date.now()
      ? `🔒 Zu viele Fehlversuche. Gesperrt für **${DEV_AUTH_LOCKOUT_MS / 60_000} Min.**`
      : `❌ Falsches Developer-Passwort. Noch **${remaining}** Versuche bis Sperre.`;
    await modal.reply({ content: msg, ephemeral: true });
    return;
  }

  pendingDevAuth.delete(modal.customId);
  devAuthFails.delete(modal.user.id); // Reset bei Erfolg

  logAudit('DEV_AUTH_SUCCESS', 'AUTH', {
    userId: modal.user.id,
    command: pendingData.commandName,
  });

  // 2-Stunden-Session freischalten
  devAuthenticatedUsers.set(modal.user.id, Date.now() + DEV_SESSION_MS);

  await modal.reply({
    content: `✅ Developer-Zugang für **2 Stunden** freigeschaltet. Verwende \`/${pendingData.commandName}\` erneut.`,
    ephemeral: true,
  });
}

/**
 * Verarbeitet Approve/Deny-Buttons für Hersteller-Anfragen per DM.
 */
async function handleManufacturerButton(btn: ButtonInteraction): Promise<void> {
  // Nur Owner oder Admins dürfen Hersteller-Anfragen bearbeiten
  const userId = btn.user.id;
  const isOwner = userId === config.discord.ownerId;
  const isAdmin = isOwner || await hasAdminRole(userId);

  if (!isAdmin) {
    await btn.reply({ content: '🔒 Nur Admins können Hersteller-Anfragen bearbeiten.', ephemeral: true });
    return;
  }

  const isApprove = btn.customId.startsWith('approve_manufacturer_');
  const targetUserId = btn.customId.replace(/^(approve|deny)_manufacturer_/, '');

  // SOFORT acknowledgen – DM-Versand kann >3s dauern (Discord Token läuft sonst ab)
  try {
    await btn.deferUpdate();
  } catch {
    // bereits acknowledged – dann verwenden wir editReply
  }

  try {
    if (isApprove) {
      const result = await approveManufacturer(targetUserId, btn.user.id);
      if (!result.success) {
        // Buttons sicher entfernen, damit nicht erneut geklickt werden kann.
        // Wenn das gelingt, brauchen wir KEIN zus\u00e4tzliches followUp mit derselben
        // Nachricht (verhindert das doppelte Anzeigen der Meldung).
        let edited = false;
        try {
          const staleEmbed = EmbedBuilder.from(btn.message.embeds[0])
            .setColor(0x808080)
            .setFooter({ text: `\u26a0\ufe0f Bereits bearbeitet \u2014 ${result.message}` });
          await btn.editReply({ embeds: [staleEmbed], components: [] });
          edited = true;
        } catch { /* Edit kann scheitern, dann unten followUp als Fallback */ }
        if (!edited) {
          try { await btn.followUp({ content: `\u26a0\ufe0f ${result.message}`, ephemeral: true }); } catch { /* ignore */ }
        }
        return;
      }

      // OTP dem User per DM senden
      let dmSent = false;
      try {
        const targetUser = await btn.client.users.fetch(targetUserId);
        await targetUser.send({
          embeds: [
            new EmbedBuilder()
              .setTitle('✅ Hersteller-Anfrage angenommen!')
              .setDescription(
                `Deine Anfrage wurde angenommen.\n\n` +
                `**Dein Einmal-Passwort:** \`${result.otp}\`\n\n` +
                `⚠️ Dieses Passwort ist **30 Minuten gültig** und kann nur **einmal** verwendet werden.\n` +
                `⚠️ Falls bereits ein älteres Passwort offen war, ist es jetzt **ungültig** — nutze nur das hier!\n` +
                `Verwende \`/register verify\` um dich zu verifizieren.`
              )
              .setColor(0x00ff00)
              .setTimestamp(),
          ],
        });
        dmSent = true;
      } catch {
        logger.warn(`Konnte DM an ${targetUserId} nicht senden.`);
      }

      // Fallback: wenn DM fehlschl\u00e4gt, Admin per ephemeral followUp das OTP zeigen,
      // damit es manuell weitergegeben werden kann.
      if (!dmSent) {
        try {
          await btn.followUp({
            ephemeral: true,
            embeds: [
              new EmbedBuilder()
                .setTitle('\u26a0\ufe0f DM an Nutzer fehlgeschlagen')
                .setDescription(
                  `Der Nutzer hat DMs von Server-Mitgliedern deaktiviert.\n\n` +
                  `**Einmal-Passwort (manuell weiterleiten):**\n\`\`\`${result.otp}\`\`\`\n` +
                  `**G\u00fcltig bis:** <t:${Math.floor((result.expiresAt as Date).getTime() / 1000)}:R>\n\n` +
                  `Bitte sende das Passwort dem Nutzer \u00fcber einen sicheren Kanal (z.B. tempor\u00e4rer privater Kanal). ` +
                  `Das Passwort ist nur einmal verwendbar und l\u00e4uft in 30 Minuten ab.`
                )
                .setColor(0xff8800),
            ],
          });
        } catch (followErr) {
          logger.error('Auch Admin-Fallback-Anzeige fehlgeschlagen:', followErr);
        }
      }

      const updatedEmbed = EmbedBuilder.from(btn.message.embeds[0])
        .setColor(0x00ff00)
        .setFooter({ text: `✅ Angenommen von ${btn.user.username}` });

      await btn.editReply({ embeds: [updatedEmbed], components: [] });
    } else {
      const result = await denyManufacturer(targetUserId, btn.user.id);
      if (!result.success) {
        let edited = false;
        try {
          const staleEmbed = EmbedBuilder.from(btn.message.embeds[0])
            .setColor(0x808080)
            .setFooter({ text: `\u26a0\ufe0f Bereits bearbeitet \u2014 ${result.message}` });
          await btn.editReply({ embeds: [staleEmbed], components: [] });
          edited = true;
        } catch { /* */ }
        if (!edited) {
          try { await btn.followUp({ content: `\u26a0\ufe0f ${result.message}`, ephemeral: true }); } catch { /* ignore */ }
        }
        return;
      }

      try {
        const targetUser = await btn.client.users.fetch(targetUserId);
        await targetUser.send({
          embeds: [
            new EmbedBuilder()
              .setTitle('❌ Hersteller-Anfrage abgelehnt')
              .setDescription('Deine Hersteller-Anfrage wurde leider abgelehnt.')
              .setColor(0xff0000)
              .setTimestamp(),
          ],
        });
      } catch {
        logger.warn(`Konnte DM an ${targetUserId} nicht senden.`);
      }

      const updatedEmbed = EmbedBuilder.from(btn.message.embeds[0])
        .setColor(0xff0000)
        .setFooter({ text: `❌ Abgelehnt von ${btn.user.username}` });

      await btn.editReply({ embeds: [updatedEmbed], components: [] });
    }
  } catch (error) {
    logger.error('Fehler bei Hersteller-Button:', error);
    // Buttons trotzdem entfernen, um Endlos-Klicken zu vermeiden
    try {
      await btn.editReply({ components: [] });
    } catch { /* */ }
    try {
      if (btn.deferred || btn.replied) {
        await btn.followUp({ content: '❌ Ein Fehler ist aufgetreten.', ephemeral: true });
      } else {
        await btn.reply({ content: '❌ Ein Fehler ist aufgetreten.', ephemeral: true });
      }
    } catch { /* Interaction unbrauchbar */ }
  }
}

export default interactionCreateEvent;

/**
 * Poll-Button: Stimme abgeben / zurückziehen per Button-Klick.
 * CustomId-Format: `poll_vote_{pollId}_{optionId}`
 */
async function handlePollVoteButton(btn: ButtonInteraction): Promise<void> {
  try {
    await btn.deferReply({ ephemeral: true });

    // customId parsen: poll_vote_<pollId>_<opt_N>
    const rest = btn.customId.substring('poll_vote_'.length);
    const lastUnderscore = rest.lastIndexOf('_opt_');
    if (lastUnderscore === -1) {
      await btn.editReply({ content: '❌ Ungültiger Button.' });
      return;
    }
    const pollId = rest.substring(0, lastUnderscore);
    const optionId = rest.substring(lastUnderscore + 1);

    const dbUser = await prisma.user.upsert({
      where: { discordId: btn.user.id },
      create: { discordId: btn.user.id, username: btn.user.username },
      update: {},
    });

    const poll = await prisma.poll.findUnique({ where: { id: pollId } });
    if (!poll) {
      await btn.editReply({ content: '❌ Umfrage nicht gefunden.' });
      return;
    }
    if (poll.status !== 'ACTIVE' || (poll.endsAt && poll.endsAt <= new Date())) {
      await btn.editReply({ content: '❌ Umfrage ist nicht mehr aktiv.' });
      return;
    }

    // Toggle-Logik: bestehende Stimme? → zurückziehen. Sonst → abgeben.
    const existing = await prisma.pollVote.findFirst({
      where: { pollId, userId: dbUser.id, optionId },
    });

    let userMessage: string;
    if (existing) {
      await prisma.pollVote.delete({ where: { id: existing.id } });
      await prisma.poll.update({
        where: { id: pollId },
        data: { totalVotes: { decrement: 1 } },
      });
      userMessage = '↩️ Deine Stimme wurde zurückgezogen.';
      logAudit('POLL_VOTE_REMOVED', 'POLL', { pollId, userId: dbUser.id, optionId });
    } else {
      // Bei Einzelwahl: vorherige Stimmen des Users löschen
      if (!poll.allowMultiple) {
        const prev = await prisma.pollVote.findMany({
          where: { pollId, userId: dbUser.id },
        });
        if (prev.length > 0) {
          await prisma.pollVote.deleteMany({
            where: { pollId, userId: dbUser.id },
          });
          await prisma.poll.update({
            where: { id: pollId },
            data: { totalVotes: { decrement: prev.length } },
          });
        }
      }

      const result = await votePoll(pollId, dbUser.id, optionId);
      if (!result.success) {
        await btn.editReply({ content: `❌ ${result.message}` });
        return;
      }
      userMessage = '✅ Stimme abgegeben!';
    }

    await btn.editReply({ content: userMessage });

    // Original-Nachricht aktualisieren
    try {
      const votes = await getPollVotes(pollId);
      const totalVotes = Object.values(votes).reduce<number>((a, b) => a + (b as number), 0);
      const options = poll.options as any;
      const embed = createPollEmbed(
        poll.title, poll.description, options, poll.pollType,
        poll.endsAt, votes, totalVotes,
      );
      embed.setFooter({ text: `Poll-ID: ${pollId} | Klicke einen Button um abzustimmen` });
      await btn.message.edit({ embeds: [embed], components: btn.message.components });
    } catch (e) {
      logger.error('Poll-Embed-Update nach Button fehlgeschlagen:', e);
    }
  } catch (error) {
    logger.error('Fehler bei Poll-Button:', error);
    try {
      if (btn.deferred) await btn.editReply({ content: '❌ Ein Fehler ist aufgetreten.' });
      else await btn.reply({ content: '❌ Ein Fehler ist aufgetreten.', ephemeral: true });
    } catch { /* ignore */ }
  }
}

/**
 * Giveaway-Button: Toggle Teilnahme.
 * CustomId-Format: `giveaway_enter_{giveawayId}`
 */
async function handleGiveawayEnterButton(btn: ButtonInteraction): Promise<void> {
  try {
    await btn.deferReply({ ephemeral: true });

    const giveawayId = btn.customId.substring('giveaway_enter_'.length);

    const giveaway = await prisma.giveaway.findUnique({ where: { id: giveawayId } });
    if (!giveaway) {
      await btn.editReply({ content: '❌ Giveaway nicht gefunden.' });
      return;
    }
    if (giveaway.status !== 'ACTIVE' || giveaway.endsAt <= new Date()) {
      await btn.editReply({ content: '❌ Giveaway ist nicht mehr aktiv.' });
      return;
    }

    // Rollen-Checks
    if (giveaway.minRole && btn.guild) {
      const member = await btn.guild.members.fetch(btn.user.id);
      if (!member.roles.cache.has(giveaway.minRole)) {
        await btn.editReply({ content: '❌ Du benötigst eine bestimmte Rolle, um an diesem Giveaway teilzunehmen.' });
        return;
      }
    }
    if (giveaway.blacklistRoles && btn.guild) {
      const member = await btn.guild.members.fetch(btn.user.id);
      const blacklisted = giveaway.blacklistRoles as string[];
      if (blacklisted.some(roleId => member.roles.cache.has(roleId))) {
        await btn.editReply({ content: '❌ Du bist von diesem Giveaway ausgeschlossen.' });
        return;
      }
    }

    const dbUser = await prisma.user.upsert({
      where: { discordId: btn.user.id },
      create: { discordId: btn.user.id, username: btn.user.username },
      update: {},
    });

    // Toggle: bereits Teilnehmer? → austragen. Sonst → eintragen.
    const existing = await prisma.giveawayEntry.findFirst({
      where: { giveawayId, userId: dbUser.id },
    });

    let userMessage: string;
    if (existing) {
      await prisma.giveawayEntry.delete({ where: { id: existing.id } });
      userMessage = '↩️ Teilnahme zurückgezogen.';
      logAudit('GIVEAWAY_LEAVE', 'GIVEAWAY', { giveawayId, userId: dbUser.id });
    } else {
      await prisma.giveawayEntry.create({
        data: { giveawayId, userId: dbUser.id },
      });
      userMessage = '🎉 Du nimmst jetzt teil!';
      logAudit('GIVEAWAY_ENTER', 'GIVEAWAY', { giveawayId, userId: dbUser.id });
    }

    await btn.editReply({ content: userMessage });

    // Original-Embed aktualisieren
    try {
      const participantCount = await prisma.giveawayEntry.count({ where: { giveawayId } });
      const creator = await prisma.user.findUnique({
        where: { id: giveaway.creatorId },
        select: { username: true },
      });
      const embed = createGiveawayEmbed(giveaway, participantCount, creator?.username);
      embed.addFields({ name: '🆔 ID', value: giveaway.id, inline: false });
      await btn.message.edit({ embeds: [embed], components: btn.message.components });
    } catch (e) {
      logger.error('Giveaway-Embed-Update nach Button fehlgeschlagen:', e);
    }
  } catch (error) {
    logger.error('Fehler bei Giveaway-Button:', error);
    try {
      if (btn.deferred) await btn.editReply({ content: '❌ Ein Fehler ist aufgetreten.' });
      else await btn.reply({ content: '❌ Ein Fehler ist aufgetreten.', ephemeral: true });
    } catch { /* ignore */ }
  }
}

/**
 * Ticket-Buttons (Akzeptieren / Ablehnen) aus der Owner-DM.
 * CustomId: ticket_accept_<ticketId> | ticket_deny_<ticketId>
 */
async function handleTicketButton(btn: ButtonInteraction): Promise<void> {
  try {
    const isAccept = btn.customId.startsWith('ticket_accept_');
    const ticketId = btn.customId.replace(/^ticket_(accept|deny)_/, '');
    await btn.deferReply({ ephemeral: false });

    const result = isAccept
      ? await acceptTicket(ticketId, btn.user.id, btn.client)
      : await denyTicket(ticketId, btn.user.id, btn.client);

    await btn.editReply({ content: (result.success ? (isAccept ? '✅ ' : '❌ ') : '⚠️ ') + result.message });

    // Buttons aus der urspruenglichen DM entfernen, damit nichts doppelt gedrueckt wird
    try {
      if (btn.message.editable) {
        await btn.message.edit({ components: [] });
      }
    } catch { /* DM-Edit kann scheitern */ }
  } catch (e) {
    logger.error('Fehler bei Ticket-Button:', e);
    try {
      if (btn.deferred) await btn.editReply({ content: '❌ Fehler bei Ticket-Aktion.' });
      else await btn.reply({ content: '❌ Fehler bei Ticket-Aktion.', ephemeral: true });
    } catch { /* ignore */ }
  }
}
