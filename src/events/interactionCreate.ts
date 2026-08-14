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
import { checkCooldown } from '../utils/cooldown';
import { checkGlobalRateLimit, checkPerCommandRateLimit, checkComponentRateLimit } from '../utils/rateLimit';
import { commandCounter, commandDurationHistogram, rateLimitedCounter } from '../utils/metrics';
import { reportError } from '../utils/errorSink';
import prisma from '../database/prisma';
import { approveManufacturer, denyManufacturer } from '../modules/registration/register';
import { votePoll, getPollVotes, createPollEmbed } from '../modules/polls/pollSystem';
import { createGiveawayEmbed } from '../modules/giveaway/giveawayManager';
import { acceptTicket, denyTicket } from '../modules/ticket/ticketManager';
import { config } from '../config';
import { timingSafeEqual } from 'crypto';
import {
  getDevSessionExpires,
  setDevSession,
  clearDevSession,
  getDevFails,
  setDevFails,
  clearDevFails,
  cleanupDevAuth,
} from '../utils/devAuthStore';

// Pending Dev-Passwort-Verifizierungen.
// Bewusst In-Memory: kurzlebiger Modal-Handshake (120s), dessen Submit auf
// demselben Shard/Prozess zurueckkommt, der das Modal angezeigt hat.
const pendingDevAuth = new Map<string, { commandName: string; userId: string; expires: number }>();

// Dev-Session (2h) und Brute-Force-Lockout liegen in der DB (devAuthStore),
// damit sie ueber alle Shards hinweg gelten und Restarts ueberleben.
const DEV_SESSION_MS = 2 * 60 * 60 * 1000; // 2 Stunden
const DEV_AUTH_MAX_FAILS = 5;
const DEV_AUTH_LOCKOUT_MS = 15 * 60 * 1000;

// Periodisches Cleanup für pendingDevAuth (lokal) & Dev-Auth-DB-State (alle 5 Min)
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingDevAuth.entries()) {
    if (v.expires < now) pendingDevAuth.delete(k);
  }
  void cleanupDevAuth().catch((e) => logger.warn(`Dev-Auth-Cleanup fehlgeschlagen: ${(e as Error).message}`));
}, 5 * 60 * 1000).unref?.();

/**
 * Timing-safe Passwort-Vergleich (verhindert Timing-Attack auf DEV_PASSWORD).
 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
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

function isOwnerOrGuildOwner(userId: string, interaction: Interaction): boolean {
  if (userId === config.discord.ownerId) return true;
  if (interaction.guild && interaction.guild.ownerId === userId) return true;
  return false;
}

export function isBotOwner(userId: string): boolean {
  return userId === config.discord.ownerId;
}

export function ownerBypassApplies(
  command: { devOnly?: boolean; manufacturerOnly?: boolean },
  userId: string,
  guildOwnerId: string | null,
): boolean {
  if (command.devOnly || command.manufacturerOnly) return false;
  if (isBotOwner(userId)) return true;
  if (guildOwnerId && guildOwnerId === userId) return true;
  return false;
}

async function hasAdminRole(discordId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { discordId } });
  if (!user) return false;
  return ['ADMIN', 'SUPER_ADMIN', 'DEVELOPER'].includes(user.role);
}

const interactionCreateEvent: BotEvent = {
  name: Events.InteractionCreate,
  execute: async (interaction: unknown) => {
    const i = interaction as Interaction;

    if (i.isAutocomplete && i.isAutocomplete()) {
      const client = i.client as ExtendedClient;
      const cmd = client.commands.get(i.commandName);
      if (cmd?.autocomplete) {
        try { await cmd.autocomplete(i); } catch (e) {
          logger.error(`Autocomplete-Fehler /${i.commandName}:`, e as Error);
        }
      }
      return;
    }

    const isComponentInteraction =
      ('isButton' in i && (i as ButtonInteraction).isButton()) ||
      ('isModalSubmit' in i && (i as ModalSubmitInteraction).isModalSubmit()) ||
      ('isAnySelectMenu' in i && (i as { isAnySelectMenu: () => boolean }).isAnySelectMenu());
    if (isComponentInteraction) {
      const c = i as ButtonInteraction;
      if (!checkComponentRateLimit(c.user.id)) {
        rateLimitedCounter.inc({ kind: 'component' });
        try {
          await c.reply({ content: '⚠️ Zu viele Aktionen. Bitte einen Moment warten.', ephemeral: true });
        } catch { /* Interaktion evtl. abgelaufen */ }
        return;
      }
    }

    if ('isModalSubmit' in i && (i as ModalSubmitInteraction).isModalSubmit()) {
      const modal = i as ModalSubmitInteraction;
      if (modal.customId.startsWith('dev_auth_')) {
        await handleDevPasswordModal(modal);
        return;
      }
      if (modal.customId.startsWith('feedback_modal_')) {
        try {
          const { handleFeedbackModal } = await import('../commands/user/feedback.js');
          await handleFeedbackModal(modal);
        } catch (e) {
          logger.error('Feedback-Modal-Handler-Fehler:', e as Error);
        }
        return;
      }
      if (modal.customId.startsWith('ttkt:adduser:')) {
        try {
          await modal.reply({ content: 'Bitte den Button erneut klicken — das Add-User-Modal wurde durch ein Auswahlmenu ersetzt.', ephemeral: true });
        } catch { /* ignore */ }
        return;
      }
      if (modal.customId.startsWith('ttkt:reason:')) {
        try {
          const { handleCloseReasonModal } = await import('../modules/tickets/ticketSystem.js');
          await handleCloseReasonModal(modal);
        } catch (e) {
          logger.error('Ticket-Reason-Modal-Handler-Fehler:', e as Error);
        }
        return;
      }
    }

    if ('isUserSelectMenu' in i && (i as { isUserSelectMenu: () => boolean }).isUserSelectMenu()) {
      const sel = i as import('discord.js').UserSelectMenuInteraction;
      if (sel.customId.startsWith('ttkt:adduser:')) {
        try {
          const { handleAddUserSelect } = await import('../modules/tickets/ticketSystem.js');
          await handleAddUserSelect(sel);
        } catch (e) {
          logger.error('Ticket-AddUser-Select-Handler-Fehler:', e as Error);
        }
        return;
      }
    }

    if ('isStringSelectMenu' in i && (i as { isStringSelectMenu: () => boolean }).isStringSelectMenu()) {
      const sel = i as import('discord.js').StringSelectMenuInteraction;
      if (sel.customId.startsWith('selfrole_sel_')) {
        try {
          const { handleSelfRoleSelect } = await import('../modules/selfrole/selfRoleMenu.js');
          await handleSelfRoleSelect(sel);
        } catch (e) {
          logger.error('SelfRole-Select-Handler-Fehler:', e as Error);
        }
        return;
      }
    }

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
      if (btn.customId.startsWith('ttkt:open:')) {
        try {
          const { handleOpenButton } = await import('../modules/tickets/ticketSystem.js');
          await handleOpenButton(btn);
        } catch (e) {
          logger.error('Ticket-Open-Button-Handler-Fehler:', e as Error);
        }
        return;
      }
      if (btn.customId.startsWith('ttkt:close:')) {
        try {
          const { handleCloseButton } = await import('../modules/tickets/ticketSystem.js');
          await handleCloseButton(btn);
        } catch (e) {
          logger.error('Ticket-Close-Button-Handler-Fehler:', e as Error);
        }
        return;
      }
      if (btn.customId.startsWith('ttkt:adduser:')) {
        try {
          const { handleAddUserButton } = await import('../modules/tickets/ticketSystem.js');
          await handleAddUserButton(btn);
        } catch (e) {
          logger.error('Ticket-AddUser-Button-Handler-Fehler:', e as Error);
        }
        return;
      }
      if (btn.customId.startsWith('ttkt:reason:')) {
        try {
          const { handleCloseReasonButton } = await import('../modules/tickets/ticketSystem.js');
          await handleCloseReasonButton(btn);
        } catch (e) {
          logger.error('Ticket-Reason-Button-Handler-Fehler:', e as Error);
        }
        return;
      }
      if (btn.customId.startsWith('selfrole_')) {
        try {
          const { handleSelfRoleButton } = await import('../modules/selfrole/selfRoleMenu.js');
          await handleSelfRoleButton(btn);
        } catch (e) {
          logger.error('SelfRole-Button-Handler-Fehler:', e as Error);
        }
        return;
      }
      if (btn.customId.startsWith('wlreq:a:') || btn.customId.startsWith('wlreq:d:')) {
        try {
          const { handleWhitelistApprovalButton } = await import('../modules/whitelist/whitelistApprovalButton.js');
          await handleWhitelistApprovalButton(btn);
        } catch (e) {
          logger.error('Whitelist-Approval-Button-Handler-Fehler:', e as Error);
        }
        return;
      }
    }

    if (!i.isChatInputCommand()) return;

    const client = i.client as ExtendedClient;
    const command = client.commands.get(i.commandName);

    if (!command) {
      logger.warn(`Unbekannter Command: ${i.commandName}`);
      return;
    }

    if (!checkGlobalRateLimit(i.user.id)) {
      rateLimitedCounter.inc({ kind: 'in_memory' });
      commandCounter.inc({ command: i.commandName, status: 'ratelimit' });
      try {
        await i.reply({
          content: '⚠️ Zu viele Commands. Bitte einen Moment warten.',
          ephemeral: true,
        });
      } catch { /* interaction evtl. abgelaufen */ }
      return;
    }
    if (!checkPerCommandRateLimit(i.user.id, i.commandName)) {
      rateLimitedCounter.inc({ kind: 'per_command' });
      commandCounter.inc({ command: i.commandName, status: 'ratelimit' });
      try {
        await i.reply({
          content: `⚠️ \`/${i.commandName}\` zu oft aufgerufen. Bitte einen Moment warten.`,
          ephemeral: true,
        });
      } catch { /* */ }
      return;
    }

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

    if (command.adminOnly || command.devOnly || command.manufacturerOnly) {
      const userId = i.user.id;

      if (ownerBypassApplies(command, userId, i.guild?.ownerId ?? null)) {
        // keine weitere Prüfung
      } else if (command.devOnly) {
        if (!isBotOwner(userId)) {
          if (!config.developer.password) {
            await i.reply({ content: '🔒 Developer-Passwort nicht konfiguriert.', ephemeral: true });
            return;
          }

          const fails = await getDevFails(userId);
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

          const devExpires = await getDevSessionExpires(userId);
          if (!devExpires || devExpires <= Date.now()) {
            await clearDevSession(userId);

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
        }
      } else if (command.adminOnly) {
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
      } else if (command.manufacturerOnly) {
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
      }
    }

    if (command.permissions && command.permissions.length > 0) {
      if (!i.inGuild()) {
        await i.reply({ content: '🔒 Dieser Command ist nur in Servern verfügbar.', ephemeral: true });
        return;
      }
      const missing = command.permissions.filter(p => !i.memberPermissions?.has(p));
      if (missing.length > 0) {
        await i.reply({
          content: '🔒 Dir fehlen die nötigen Server-Berechtigungen für diesen Command.',
          ephemeral: true,
        });
        logAudit('COMMAND_PERMISSION_DENIED', 'SECURITY', {
          userId: i.user.id,
          command: i.commandName,
          missing: missing.map(String),
        });
        return;
      }
    }

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
        logger.warn(`Konnte Fehler-Antwort nicht senden für ${i.commandName}: ${replyError?.message}`);
      }
    } finally {
      stopTimer();
    }
  },
};

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

  const fails = await getDevFails(modal.user.id);
  if (fails && fails.lockedUntil > Date.now()) {
    const remainMin = Math.ceil((fails.lockedUntil - Date.now()) / 60_000);
    await modal.reply({
      content: `🔒 Zu viele Fehlversuche. Gesperrt für **${remainMin} Min.**`,
      ephemeral: true,
    });
    return;
  }

  const enteredPassword = modal.fields.getTextInputValue('dev_password');

  if (!config.developer.password) {
    pendingDevAuth.delete(modal.customId);
    logAudit('DEV_AUTH_FAILED', 'SECURITY', {
      userId: modal.user.id,
      command: pendingData.commandName,
      reason: 'DEV_PASSWORD nicht konfiguriert',
    });
    await modal.reply({
      content: '🔒 Developer-Login serverseitig nicht konfiguriert.',
      ephemeral: true,
    });
    return;
  }

  if (!safeEqual(enteredPassword, config.developer.password)) {
    pendingDevAuth.delete(modal.customId);

    const prev = await getDevFails(modal.user.id);
    const cur = (prev && prev.lockedUntil <= Date.now() && prev.lockedUntil > 0)
      ? { count: 0, lockedUntil: 0 }
      : (prev ?? { count: 0, lockedUntil: 0 });
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
    await setDevFails(modal.user.id, cur);

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
  await clearDevFails(modal.user.id);

  logAudit('DEV_AUTH_SUCCESS', 'AUTH', {
    userId: modal.user.id,
    command: pendingData.commandName,
  });

  await setDevSession(modal.user.id, Date.now() + DEV_SESSION_MS);

  await modal.reply({
    content: `✅ Developer-Zugang für **2 Stunden** freigeschaltet. Verwende \`/${pendingData.commandName}\` erneut.`,
    ephemeral: true,
  });
}

async function handleManufacturerButton(btn: ButtonInteraction): Promise<void> {
  const userId = btn.user.id;
  const isOwner = userId === config.discord.ownerId;
  const isAdmin = isOwner || await hasAdminRole(userId);

  if (!isAdmin) {
    await btn.reply({ content: '🔒 Nur Admins können Hersteller-Anfragen bearbeiten.', ephemeral: true });
    return;
  }

  const isApprove = btn.customId.startsWith('approve_manufacturer_');
  const targetUserId = btn.customId.replace(/^(approve|deny)_manufacturer_/, '');

  try {
    await btn.deferUpdate();
  } catch { /* already acknowledged */ }

  try {
    if (isApprove) {
      const result = await approveManufacturer(targetUserId, btn.user.id);
      if (!result.success) {
        let edited = false;
        try {
          const staleEmbed = EmbedBuilder.from(btn.message.embeds[0])
            .setColor(0x808080)
            .setFooter({ text: `⚠️ Bereits bearbeitet — ${result.message}` });
          await btn.editReply({ embeds: [staleEmbed], components: [] });
          edited = true;
        } catch { /* fallback below */ }
        if (!edited) {
          try { await btn.followUp({ content: `⚠️ ${result.message}`, ephemeral: true }); } catch { /* ignore */ }
        }
        return;
      }

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

      if (!dmSent) {
        try {
          await btn.followUp({
            ephemeral: true,
            embeds: [
              new EmbedBuilder()
                .setTitle('⚠️ DM an Nutzer fehlgeschlagen')
                .setDescription(
                  `Der Nutzer hat DMs von Server-Mitgliedern deaktiviert.\n\n` +
                  `**Einmal-Passwort (manuell weiterleiten):**\n\`\`\`${result.otp}\`\`\`\n` +
                  `**Gültig bis:** <t:${Math.floor((result.expiresAt as Date).getTime() / 1000)}:R>\n\n` +
                  `Bitte sende das Passwort dem Nutzer über einen sicheren Kanal. Das Passwort ist nur einmal verwendbar.`
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
            .setFooter({ text: `⚠️ Bereits bearbeitet — ${result.message}` });
          await btn.editReply({ embeds: [staleEmbed], components: [] });
          edited = true;
        } catch { /* */ }
        if (!edited) {
          try { await btn.followUp({ content: `⚠️ ${result.message}`, ephemeral: true }); } catch { /* ignore */ }
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
    try { await btn.editReply({ components: [] }); } catch { /* */ }
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

async function handlePollVoteButton(btn: ButtonInteraction): Promise<void> {
  try {
    await btn.deferReply({ ephemeral: true });

    if (!btn.guildId) {
      await btn.editReply({ content: '❌ Diese Aktion ist nur auf einem Server verfügbar.' });
      return;
    }

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

    const poll = await prisma.poll.findFirst({ where: { id: pollId, guildId: btn.guildId } });
    if (!poll) {
      await btn.editReply({ content: '❌ Umfrage nicht gefunden.' });
      return;
    }
    if (poll.status !== 'ACTIVE' || (poll.endsAt && poll.endsAt <= new Date())) {
      await btn.editReply({ content: '❌ Umfrage ist nicht mehr aktiv.' });
      return;
    }

    const existing = await prisma.pollVote.findFirst({
      where: { pollId, userId: dbUser.id, optionId },
    });

    let userMessage: string;
    if (existing) {
      await prisma.$transaction([
        prisma.pollVote.delete({ where: { id: existing.id } }),
        prisma.poll.update({
          where: { id: pollId },
          data: { totalVotes: { decrement: 1 } },
        }),
      ]);
      userMessage = '↩️ Deine Stimme wurde zurückgezogen.';
      logAudit('POLL_VOTE_REMOVED', 'POLL', { pollId, userId: dbUser.id, optionId });
    } else {
      if (!poll.allowMultiple) {
        const prev = await prisma.pollVote.findMany({
          where: { pollId, userId: dbUser.id },
        });
        if (prev.length > 0) {
          await prisma.$transaction([
            prisma.pollVote.deleteMany({ where: { pollId, userId: dbUser.id } }),
            prisma.poll.update({ where: { id: pollId }, data: { totalVotes: { decrement: prev.length } } }),
          ]);
        }
      }

      const result = await votePoll(pollId, dbUser.id, optionId, btn.guildId);
      if (!result.success) {
        await btn.editReply({ content: `❌ ${result.message}` });
        return;
      }
      userMessage = '✅ Stimme abgegeben!';
    }

    await btn.editReply({ content: userMessage });

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

async function handleGiveawayEnterButton(btn: ButtonInteraction): Promise<void> {
  try {
    await btn.deferReply({ ephemeral: true });

    if (!btn.guildId) {
      await btn.editReply({ content: '❌ Diese Aktion ist nur auf einem Server verfügbar.' });
      return;
    }

    const giveawayId = btn.customId.substring('giveaway_enter_'.length);

    const giveaway = await prisma.giveaway.findFirst({ where: { id: giveawayId, guildId: btn.guildId } });
    if (!giveaway) {
      await btn.editReply({ content: '❌ Giveaway nicht gefunden.' });
      return;
    }
    if (giveaway.status !== 'ACTIVE' || giveaway.endsAt <= new Date()) {
      await btn.editReply({ content: '❌ Giveaway ist nicht mehr aktiv.' });
      return;
    }

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

    const existing = await prisma.giveawayEntry.findFirst({
      where: { giveawayId, userId: dbUser.id },
    });

    let userMessage: string;
    if (existing) {
      await prisma.giveawayEntry.delete({ where: { id: existing.id } });
      userMessage = '↩️ Teilnahme zurückgezogen.';
      logAudit('GIVEAWAY_LEAVE', 'GIVEAWAY', { giveawayId, userId: dbUser.id });
    } else {
      try {
        await prisma.giveawayEntry.create({ data: { giveawayId, userId: dbUser.id } });
      } catch (e) {
        if ((e as { code?: string })?.code !== 'P2002') throw e;
      }
      userMessage = '🎉 Du nimmst jetzt teil!';
      logAudit('GIVEAWAY_ENTER', 'GIVEAWAY', { giveawayId, userId: dbUser.id });
    }

    await btn.editReply({ content: userMessage });

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

async function handleTicketButton(btn: ButtonInteraction): Promise<void> {
  try {
    const isAccept = btn.customId.startsWith('ticket_accept_');
    const ticketId = btn.customId.replace(/^ticket_(accept|deny)_/, '');
    await btn.deferReply({ ephemeral: false });

    const result = isAccept
      ? await acceptTicket(ticketId, btn.user.id, btn.client)
      : await denyTicket(ticketId, btn.user.id, btn.client);

    await btn.editReply({ content: (result.success ? (isAccept ? '✅ ' : '❌ ') : '⚠️ ') + result.message });

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
