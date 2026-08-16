import {
  MessageFlags,
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
import { Colors, vEmbed } from '../utils/embedDesign';
import prisma from '../database/prisma';
import { approveManufacturer, denyManufacturer } from '../modules/registration/register';
import { togglePollVote, getPollVotes, createPollEmbed, type PollOption } from '../modules/polls/pollSystem';
import { createGiveawayEmbed, enterGiveaway } from '../modules/giveaway/giveawayManager';
import { acceptTicket, denyTicket } from '../modules/ticket/ticketManager';
import { config } from '../config';
import { isGlobalDeveloperIdentity } from '../security/privilegedIdentity';
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

const pendingDevAuth = new Map<string, { commandName: string; userId: string; expires: number }>();
const DEV_SESSION_MS = 2 * 60 * 60 * 1000;
const DEV_AUTH_MAX_FAILS = 5;
const DEV_AUTH_LOCKOUT_MS = 15 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [key, value] of pendingDevAuth.entries()) {
    if (value.expires < now) pendingDevAuth.delete(key);
  }
  void cleanupDevAuth().catch(error => logger.warn(`Dev-Auth-Cleanup fehlgeschlagen: ${(error as Error).message}`));
}, 5 * 60 * 1000).unref?.();

type NoticeKind = 'success' | 'info' | 'warning' | 'error';

/** Einheitliche Status-Embeds fuer zentrale Dispatcher-/Security-Antworten. */
export function interactionNotice(kind: NoticeKind, title: string, description: string): EmbedBuilder {
  const color = kind === 'success'
    ? Colors.Success
    : kind === 'info'
      ? Colors.Info
      : kind === 'warning'
        ? Colors.Warning
        : Colors.Error;
  return vEmbed(color).setTitle(title).setDescription(description);
}

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
  return Boolean(interaction.guild && interaction.guild.ownerId === userId);
}

export function isBotOwner(userId: string): boolean {
  return userId === config.discord.ownerId;
}

async function hasGlobalDeveloperIdentity(discordId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { discordId },
    select: { role: true },
  });
  return isGlobalDeveloperIdentity(discordId, user?.role ?? 'USER', config.discord.ownerId);
}

export function ownerBypassApplies(
  command: { devOnly?: boolean; manufacturerOnly?: boolean },
  userId: string,
  guildOwnerId: string | null,
): boolean {
  if (command.devOnly || command.manufacturerOnly) return false;
  if (isBotOwner(userId)) return true;
  return Boolean(guildOwnerId && guildOwnerId === userId);
}

async function hasAdminRole(discordId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { discordId } });
  return Boolean(user && ['ADMIN', 'SUPER_ADMIN', 'DEVELOPER'].includes(user.role));
}

const interactionCreateEvent: BotEvent = {
  name: Events.InteractionCreate,
  execute: async (interaction: unknown) => {
    const i = interaction as Interaction;

    if (i.isAutocomplete && i.isAutocomplete()) {
      const client = i.client as ExtendedClient;
      const command = client.commands.get(i.commandName);
      if (command?.autocomplete) {
        try {
          await command.autocomplete(i);
        } catch (error) {
          logger.error(`Autocomplete-Fehler /${i.commandName}:`, error as Error);
        }
      }
      return;
    }

    const isComponentInteraction =
      ('isButton' in i && (i as ButtonInteraction).isButton()) ||
      ('isModalSubmit' in i && (i as ModalSubmitInteraction).isModalSubmit()) ||
      ('isAnySelectMenu' in i && (i as { isAnySelectMenu: () => boolean }).isAnySelectMenu());

    if (isComponentInteraction) {
      const component = i as ButtonInteraction;
      if (!checkComponentRateLimit(component.user.id)) {
        rateLimitedCounter.inc({ kind: 'component' });
        try {
          await component.reply({
            embeds: [interactionNotice('warning', 'Zu viele Aktionen', 'Bitte einen Moment warten und versuche es dann erneut.')],
            flags: MessageFlags.Ephemeral,
          });
        } catch { /* Interaktion eventuell abgelaufen */ }
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
        } catch (error) {
          logger.error('Feedback-Modal-Handler-Fehler:', error as Error);
        }
        return;
      }
      if (modal.customId.startsWith('ttkt:adduser:')) {
        try {
          await modal.reply({
            embeds: [interactionNotice('info', 'Auswahl aktualisiert', 'Bitte den Button erneut klicken. Das alte Add-User-Modal wurde durch ein Auswahlmenue ersetzt.')],
            flags: MessageFlags.Ephemeral,
          });
        } catch { /* ignore */ }
        return;
      }
      if (modal.customId.startsWith('ttkt:reason:')) {
        try {
          const { handleCloseReasonModal } = await import('../modules/tickets/ticketSystem.js');
          await handleCloseReasonModal(modal);
        } catch (error) {
          logger.error('Ticket-Reason-Modal-Handler-Fehler:', error as Error);
        }
        return;
      }
    }

    if ('isUserSelectMenu' in i && (i as { isUserSelectMenu: () => boolean }).isUserSelectMenu()) {
      const select = i as import('discord.js').UserSelectMenuInteraction;
      if (select.customId.startsWith('ttkt:adduser:')) {
        try {
          const { handleAddUserSelect } = await import('../modules/tickets/ticketSystem.js');
          await handleAddUserSelect(select);
        } catch (error) {
          logger.error('Ticket-AddUser-Select-Handler-Fehler:', error as Error);
        }
        return;
      }
    }

    if ('isStringSelectMenu' in i && (i as { isStringSelectMenu: () => boolean }).isStringSelectMenu()) {
      const select = i as import('discord.js').StringSelectMenuInteraction;
      if (select.customId.startsWith('selfrole_sel_')) {
        try {
          const { handleSelfRoleSelect } = await import('../modules/selfrole/selfRoleMenu.js');
          await handleSelfRoleSelect(select);
        } catch (error) {
          logger.error('SelfRole-Select-Handler-Fehler:', error as Error);
        }
        return;
      }
    }

    if ('isButton' in i && (i as ButtonInteraction).isButton()) {
      const button = i as ButtonInteraction;
      if (button.customId.startsWith('approve_manufacturer_') || button.customId.startsWith('deny_manufacturer_')) {
        await handleManufacturerButton(button);
        return;
      }
      if (button.customId.startsWith('poll_vote_')) {
        await handlePollVoteButton(button);
        return;
      }
      if (button.customId.startsWith('giveaway_enter_')) {
        await handleGiveawayEnterButton(button);
        return;
      }
      if (button.customId.startsWith('lottery_buy_')) {
        try {
          const { handleLotteryBuyButton } = await import('../modules/economy/lottery.js');
          await handleLotteryBuyButton(button);
        } catch (error) {
          logger.error('Lottery-Button-Handler-Fehler:', error as Error);
        }
        return;
      }
      if (button.customId.startsWith('ticket_accept_') || button.customId.startsWith('ticket_deny_')) {
        await handleTicketButton(button);
        return;
      }
      if (button.customId.startsWith('ttkt:open:')) {
        try {
          const { handleOpenButton } = await import('../modules/tickets/ticketSystem.js');
          await handleOpenButton(button);
        } catch (error) {
          logger.error('Ticket-Open-Button-Handler-Fehler:', error as Error);
        }
        return;
      }
      if (button.customId.startsWith('ttkt:close:')) {
        try {
          const { handleCloseButton } = await import('../modules/tickets/ticketSystem.js');
          await handleCloseButton(button);
        } catch (error) {
          logger.error('Ticket-Close-Button-Handler-Fehler:', error as Error);
        }
        return;
      }
      if (button.customId.startsWith('ttkt:adduser:')) {
        try {
          const { handleAddUserButton } = await import('../modules/tickets/ticketSystem.js');
          await handleAddUserButton(button);
        } catch (error) {
          logger.error('Ticket-AddUser-Button-Handler-Fehler:', error as Error);
        }
        return;
      }
      if (button.customId.startsWith('ttkt:reason:')) {
        try {
          const { handleCloseReasonButton } = await import('../modules/tickets/ticketSystem.js');
          await handleCloseReasonButton(button);
        } catch (error) {
          logger.error('Ticket-Reason-Button-Handler-Fehler:', error as Error);
        }
        return;
      }
      if (button.customId.startsWith('selfrole_')) {
        try {
          const { handleSelfRoleButton } = await import('../modules/selfrole/selfRoleMenu.js');
          await handleSelfRoleButton(button);
        } catch (error) {
          logger.error('SelfRole-Button-Handler-Fehler:', error as Error);
        }
        return;
      }
      if (button.customId.startsWith('wlreq:a:') || button.customId.startsWith('wlreq:d:')) {
        try {
          const { handleWhitelistApprovalButton } = await import('../modules/whitelist/whitelistApprovalButton.js');
          await handleWhitelistApprovalButton(button);
        } catch (error) {
          logger.error('Whitelist-Approval-Button-Handler-Fehler:', error as Error);
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
          embeds: [interactionNotice('warning', 'Command-Limit erreicht', 'Du verwendest gerade sehr viele Commands. Bitte einen Moment warten.')],
          flags: MessageFlags.Ephemeral,
        });
      } catch { /* Interaktion eventuell abgelaufen */ }
      return;
    }

    if (!checkPerCommandRateLimit(i.user.id, i.commandName)) {
      rateLimitedCounter.inc({ kind: 'per_command' });
      commandCounter.inc({ command: i.commandName, status: 'ratelimit' });
      try {
        await i.reply({
          embeds: [interactionNotice('warning', 'Command-Limit erreicht', `\`/${i.commandName}\` wurde zu oft aufgerufen. Bitte einen Moment warten.`)],
          flags: MessageFlags.Ephemeral,
        });
      } catch { /* ignore */ }
      return;
    }

    if (command.cooldown && !isOwnerOrGuildOwner(i.user.id, i)) {
      const cooldown = checkCooldown(i.user.id, i.commandName, command.cooldown);
      if (!cooldown.ok) {
        rateLimitedCounter.inc({ kind: 'cooldown' });
        commandCounter.inc({ command: i.commandName, status: 'cooldown' });
        try {
          await i.reply({
            embeds: [interactionNotice('info', 'Command noch im Cooldown', `Bitte noch **${cooldown.remainingSec}s** warten, bevor du \`/${i.commandName}\` erneut nutzt.`)],
            flags: MessageFlags.Ephemeral,
          });
        } catch { /* ignore */ }
        return;
      }
    }

    if (command.adminOnly || command.devOnly || command.manufacturerOnly) {
      const userId = i.user.id;

      if (ownerBypassApplies(command, userId, i.guild?.ownerId ?? null)) {
        // adminOnly Owner-/Guild-Owner-Bypass bewusst erlaubt.
      } else if (command.devOnly) {
        if (!(await hasGlobalDeveloperIdentity(userId))) {
          await clearDevSession(userId).catch(() => undefined);
          logAudit('DEV_COMMAND_IDENTITY_DENIED', 'SECURITY', { userId, command: i.commandName });
          await i.reply({
            embeds: [interactionNotice('error', 'Developer-Zugriff verweigert', 'Keine globale Developer-Berechtigung.')],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (!config.developer.password) {
          await i.reply({
            embeds: [interactionNotice('error', 'Developer-Zugriff nicht verfuegbar', 'Das Developer-Passwort ist serverseitig nicht konfiguriert.')],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const fails = await getDevFails(userId);
        if (fails && fails.lockedUntil > Date.now()) {
          const remainMin = Math.ceil((fails.lockedUntil - Date.now()) / 60_000);
          await i.reply({
            embeds: [interactionNotice('warning', 'Developer-Login gesperrt', `Zu viele Fehlversuche. Noch etwa **${remainMin} Min.** gesperrt.`)],
            flags: MessageFlags.Ephemeral,
          });
          logAudit('DEV_AUTH_BLOCKED_LOCKED', 'SECURITY', { userId, command: i.commandName, remainMin });
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
            .setPlaceholder('Passwort fuer den Developer-Bereich')
            .setStyle(TextInputStyle.Short)
            .setRequired(true);
          modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(passwordInput));
          await i.showModal(modal);
          return;
        }
      } else if (command.adminOnly) {
        if (!(await hasAdminRole(userId))) {
          await i.reply({
            embeds: [interactionNotice('error', 'Keine Berechtigung', 'Du benoetigst eine Admin-Rolle fuer diesen Command.')],
            flags: MessageFlags.Ephemeral,
          });
          logAudit('ADMIN_COMMAND_DENIED', 'SECURITY', { userId, command: i.commandName, reason: 'Keine Admin-Rolle' });
          return;
        }
      } else if (command.manufacturerOnly) {
        const dbUser = await prisma.user.findUnique({ where: { discordId: userId } });
        if (!dbUser) {
          await i.reply({
            embeds: [interactionNotice('error', 'Hersteller-Zugriff verweigert', 'Du bist nicht registriert. Verwende `/register manufacturer`, um Hersteller zu werden.')],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        // Dieselbe harte Invariante wie Upload-/Download-Service:
        // ACTIVE + isManufacturer + role=MANUFACTURER. Admin-/Developer-Rollen
        // duerfen manufacturerOnly NICHT implizit umgehen.
        if (!dbUser.isManufacturer || dbUser.role !== 'MANUFACTURER') {
          await i.reply({
            embeds: [interactionNotice('error', 'Hersteller-Zugriff verweigert', 'Nur vollstaendig verifizierte Hersteller duerfen diesen Command nutzen.')],
            flags: MessageFlags.Ephemeral,
          });
          logAudit('MANUFACTURER_COMMAND_DENIED', 'SECURITY', {
            userId,
            command: i.commandName,
            reason: 'Herstellerflag oder MANUFACTURER-Rolle fehlt',
          });
          return;
        }
        if (dbUser.status !== 'ACTIVE') {
          await i.reply({
            embeds: [interactionNotice('warning', 'Hersteller noch nicht aktiv', `Dein Account hat aktuell den Status \`${dbUser.status}\`. Schließe zuerst die Verifizierung ab.`)],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
      }
    }

    if (command.permissions && command.permissions.length > 0) {
      if (!i.inGuild()) {
        await i.reply({
          embeds: [interactionNotice('error', 'Server-Kontext erforderlich', 'Dieser Command ist nur auf einem Discord-Server verfuegbar.')],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const missing = command.permissions.filter(permission => !i.memberPermissions?.has(permission));
      if (missing.length > 0) {
        await i.reply({
          embeds: [interactionNotice('error', 'Server-Berechtigung fehlt', 'Dir fehlen die benoetigten Server-Berechtigungen fuer diesen Command.')],
          flags: MessageFlags.Ephemeral,
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
        options: i.options.data.map(option => ({ name: option.name, value: option.value })),
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

      const embed = interactionNotice('error', 'Command fehlgeschlagen', 'Ein interner Fehler ist aufgetreten. Bitte versuche es erneut.');
      try {
        if (i.replied || i.deferred) await i.followUp({ embeds: [embed], flags: MessageFlags.Ephemeral });
        else await i.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      } catch (replyError: any) {
        logger.warn(`Konnte Fehler-Antwort nicht senden fuer ${i.commandName}: ${replyError?.message}`);
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
    await modal.reply({
      embeds: [interactionNotice('warning', 'Authentifizierung abgelaufen', 'Bitte starte den Developer-Command erneut.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (pendingData.userId !== modal.user.id) {
    await modal.reply({ embeds: [interactionNotice('error', 'Unbefugter Zugriff', 'Diese Authentifizierung gehoert zu einem anderen Benutzer.')], flags: MessageFlags.Ephemeral });
    return;
  }

  if (!(await hasGlobalDeveloperIdentity(modal.user.id))) {
    pendingDevAuth.delete(modal.customId);
    await clearDevSession(modal.user.id).catch(() => undefined);
    logAudit('DEV_AUTH_IDENTITY_DENIED', 'SECURITY', { userId: modal.user.id, command: pendingData.commandName });
    await modal.reply({ embeds: [interactionNotice('error', 'Developer-Zugriff verweigert', 'Keine globale Developer-Berechtigung.')], flags: MessageFlags.Ephemeral });
    return;
  }

  const fails = await getDevFails(modal.user.id);
  if (fails && fails.lockedUntil > Date.now()) {
    const remainMin = Math.ceil((fails.lockedUntil - Date.now()) / 60_000);
    await modal.reply({
      embeds: [interactionNotice('warning', 'Developer-Login gesperrt', `Zu viele Fehlversuche. Noch etwa **${remainMin} Min.** gesperrt.`)],
      flags: MessageFlags.Ephemeral,
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
      embeds: [interactionNotice('error', 'Developer-Login nicht verfuegbar', 'Der Developer-Login ist serverseitig nicht konfiguriert.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!safeEqual(enteredPassword, config.developer.password)) {
    pendingDevAuth.delete(modal.customId);
    const previous = await getDevFails(modal.user.id);
    const current = (previous && previous.lockedUntil <= Date.now() && previous.lockedUntil > 0)
      ? { count: 0, lockedUntil: 0 }
      : (previous ?? { count: 0, lockedUntil: 0 });
    current.count++;
    if (current.count >= DEV_AUTH_MAX_FAILS) {
      current.lockedUntil = Date.now() + DEV_AUTH_LOCKOUT_MS;
      logAudit('DEV_AUTH_LOCKOUT', 'SECURITY', {
        userId: modal.user.id,
        command: pendingData.commandName,
        fails: current.count,
        lockoutMin: DEV_AUTH_LOCKOUT_MS / 60_000,
      });
    }
    await setDevFails(modal.user.id, current);
    logAudit('DEV_AUTH_FAILED', 'SECURITY', { userId: modal.user.id, command: pendingData.commandName, fails: current.count });

    const remaining = DEV_AUTH_MAX_FAILS - current.count;
    const message = current.lockedUntil > Date.now()
      ? `Zu viele Fehlversuche. Der Developer-Login ist fuer **${DEV_AUTH_LOCKOUT_MS / 60_000} Min.** gesperrt.`
      : `Das Developer-Passwort ist falsch. Noch **${remaining}** Versuche bis zur Sperre.`;
    await modal.reply({ embeds: [interactionNotice('error', 'Authentifizierung fehlgeschlagen', message)], flags: MessageFlags.Ephemeral });
    return;
  }

  pendingDevAuth.delete(modal.customId);
  await clearDevFails(modal.user.id);
  logAudit('DEV_AUTH_SUCCESS', 'AUTH', { userId: modal.user.id, command: pendingData.commandName });
  await setDevSession(modal.user.id, Date.now() + DEV_SESSION_MS);
  await modal.reply({
    embeds: [interactionNotice('success', 'Developer-Zugang freigeschaltet', `Der Zugang ist fuer **2 Stunden** aktiv. Verwende \`/${pendingData.commandName}\` jetzt erneut.`)],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleManufacturerButton(btn: ButtonInteraction): Promise<void> {
  const userId = btn.user.id;
  const isOwner = userId === config.discord.ownerId;
  const isAdmin = isOwner || await hasAdminRole(userId);
  if (!isAdmin) {
    await btn.reply({ embeds: [interactionNotice('error', 'Keine Berechtigung', 'Nur Admins koennen Hersteller-Anfragen bearbeiten.')], flags: MessageFlags.Ephemeral });
    return;
  }

  const isApprove = btn.customId.startsWith('approve_manufacturer_');
  const targetUserId = btn.customId.replace(/^(approve|deny)_manufacturer_/, '');
  try { await btn.deferUpdate(); } catch { /* bereits acknowledged */ }

  try {
    if (isApprove) {
      const result = await approveManufacturer(targetUserId, btn.user.id);
      if (!result.success) {
        let edited = false;
        try {
          const staleEmbed = EmbedBuilder.from(btn.message.embeds[0])
            .setColor(Colors.Neutral)
            .setFooter({ text: `Bereits bearbeitet — ${result.message}` });
          await btn.editReply({ embeds: [staleEmbed], components: [] });
          edited = true;
        } catch { /* fallback unten */ }
        if (!edited) {
          try {
            await btn.followUp({ embeds: [interactionNotice('warning', 'Anfrage bereits bearbeitet', result.message)], flags: MessageFlags.Ephemeral });
          } catch { /* ignore */ }
        }
        return;
      }

      let dmSent = false;
      try {
        const targetUser = await btn.client.users.fetch(targetUserId);
        await targetUser.send({
          embeds: [
            vEmbed(Colors.Success)
              .setTitle('Hersteller-Anfrage angenommen')
              .setDescription(
                `Deine Anfrage wurde angenommen.\n\n` +
                `**Dein Einmal-Passwort:** \`${result.otp}\`\n\n` +
                `Dieses Passwort ist **30 Minuten gueltig** und kann nur **einmal** verwendet werden. ` +
                `Falls bereits ein aelteres Passwort offen war, ist es jetzt ungueltig. ` +
                `Verwende \`/register verify\`, um dich zu verifizieren.`,
              ),
          ],
        });
        dmSent = true;
      } catch {
        logger.warn(`Konnte DM an ${targetUserId} nicht senden.`);
      }

      if (!dmSent) {
        try {
          await btn.followUp({
            flags: MessageFlags.Ephemeral,
            embeds: [interactionNotice(
              'warning',
              'DM an Nutzer fehlgeschlagen',
              `Leite das Einmal-Passwort ueber einen sicheren Kanal weiter:\n\n\`\`\`${result.otp}\`\`\`\n` +
              `Gueltig bis: <t:${Math.floor((result.expiresAt as Date).getTime() / 1000)}:R>`,
            )],
          });
        } catch (followError) {
          logger.error('Auch Admin-Fallback-Anzeige fehlgeschlagen:', followError);
        }
      }

      const updatedEmbed = EmbedBuilder.from(btn.message.embeds[0])
        .setColor(Colors.Success)
        .setFooter({ text: `Angenommen von ${btn.user.username}` });
      await btn.editReply({ embeds: [updatedEmbed], components: [] });
      return;
    }

    const result = await denyManufacturer(targetUserId, btn.user.id);
    if (!result.success) {
      let edited = false;
      try {
        const staleEmbed = EmbedBuilder.from(btn.message.embeds[0])
          .setColor(Colors.Neutral)
          .setFooter({ text: `Bereits bearbeitet — ${result.message}` });
        await btn.editReply({ embeds: [staleEmbed], components: [] });
        edited = true;
      } catch { /* fallback unten */ }
      if (!edited) {
        try {
          await btn.followUp({ embeds: [interactionNotice('warning', 'Anfrage bereits bearbeitet', result.message)], flags: MessageFlags.Ephemeral });
        } catch { /* ignore */ }
      }
      return;
    }

    try {
      const targetUser = await btn.client.users.fetch(targetUserId);
      await targetUser.send({ embeds: [interactionNotice('error', 'Hersteller-Anfrage abgelehnt', 'Deine Hersteller-Anfrage wurde abgelehnt.')] });
    } catch {
      logger.warn(`Konnte DM an ${targetUserId} nicht senden.`);
    }

    const updatedEmbed = EmbedBuilder.from(btn.message.embeds[0])
      .setColor(Colors.Error)
      .setFooter({ text: `Abgelehnt von ${btn.user.username}` });
    await btn.editReply({ embeds: [updatedEmbed], components: [] });
  } catch (error) {
    logger.error('Fehler bei Hersteller-Button:', error);
    try { await btn.editReply({ components: [] }); } catch { /* ignore */ }
    try {
      const embed = interactionNotice('error', 'Hersteller-Aktion fehlgeschlagen', 'Die Aktion konnte nicht abgeschlossen werden.');
      if (btn.deferred || btn.replied) await btn.followUp({ embeds: [embed], flags: MessageFlags.Ephemeral });
      else await btn.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    } catch { /* interaction unbrauchbar */ }
  }
}

export default interactionCreateEvent;

/**
 * Poll-Button: der komplette Toggle laeuft kanonisch unter demselben DB-Lock
 * wie Slash-Votes und Poll-Finalisierung.
 */
export async function handlePollVoteButton(btn: ButtonInteraction): Promise<void> {
  try {
    await btn.deferReply({ flags: MessageFlags.Ephemeral });
    if (!btn.guildId) {
      await btn.editReply({ embeds: [interactionNotice('error', 'Server-Kontext erforderlich', 'Diese Aktion ist nur auf einem Server verfuegbar.')] });
      return;
    }

    const rest = btn.customId.substring('poll_vote_'.length);
    const lastUnderscore = rest.lastIndexOf('_opt_');
    if (lastUnderscore === -1) {
      await btn.editReply({ embeds: [interactionNotice('error', 'Ungueltiger Poll-Button', 'Die Abstimmungsoption konnte nicht erkannt werden.')] });
      return;
    }
    const pollId = rest.substring(0, lastUnderscore);
    const optionId = rest.substring(lastUnderscore + 1);

    const dbUser = await prisma.user.upsert({
      where: { discordId: btn.user.id },
      create: { discordId: btn.user.id, username: btn.user.username },
      update: {},
    });

    const result = await togglePollVote(pollId, dbUser.id, optionId, btn.guildId);
    if (!result.success) {
      await btn.editReply({ embeds: [interactionNotice('warning', 'Abstimmung nicht geaendert', result.message)] });
      return;
    }

    await btn.editReply({
      embeds: [interactionNotice(
        result.action === 'REMOVED' ? 'info' : 'success',
        result.action === 'REMOVED' ? 'Stimme zurueckgezogen' : 'Stimme gespeichert',
        result.message,
      )],
    });

    try {
      const poll = await prisma.poll.findFirst({ where: { id: pollId, guildId: btn.guildId } });
      if (!poll) return;
      const votes = await getPollVotes(pollId);
      const totalVotes = Object.values(votes).reduce<number>((sum, count) => sum + count, 0);
      const embed = createPollEmbed(
        poll.title,
        poll.description,
        poll.options as unknown as PollOption[],
        poll.pollType,
        poll.endsAt,
        votes,
        totalVotes,
      );
      embed.setFooter({ text: `Poll-ID: ${pollId} | Klicke einen Button um abzustimmen` });
      await btn.message.edit({ embeds: [embed], components: btn.message.components });
    } catch (error) {
      logger.error('Poll-Embed-Update nach Button fehlgeschlagen:', error);
    }
  } catch (error) {
    logger.error('Fehler bei Poll-Button:', error);
    try {
      const embed = interactionNotice('error', 'Abstimmung fehlgeschlagen', 'Die Aktion konnte nicht abgeschlossen werden.');
      if (btn.deferred) await btn.editReply({ embeds: [embed] });
      else await btn.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    } catch { /* ignore */ }
  }
}

/**
 * Giveaway-Button: Austritt bleibt immer moeglich; neue Teilnahme wird ueber
 * dieselbe kanonische enterGiveaway()-Eligibility wie der Slash-Pfad geprueft.
 */
export async function handleGiveawayEnterButton(btn: ButtonInteraction): Promise<void> {
  try {
    await btn.deferReply({ flags: MessageFlags.Ephemeral });
    if (!btn.guildId) {
      await btn.editReply({ embeds: [interactionNotice('error', 'Server-Kontext erforderlich', 'Diese Aktion ist nur auf einem Server verfuegbar.')] });
      return;
    }

    const giveawayId = btn.customId.substring('giveaway_enter_'.length);
    const giveaway = await prisma.giveaway.findFirst({ where: { id: giveawayId, guildId: btn.guildId } });
    if (!giveaway) {
      await btn.editReply({ embeds: [interactionNotice('error', 'Giveaway nicht gefunden', 'Dieses Giveaway existiert auf diesem Server nicht.')] });
      return;
    }
    if (giveaway.status !== 'ACTIVE' || giveaway.endsAt <= new Date()) {
      await btn.editReply({ embeds: [interactionNotice('warning', 'Giveaway beendet', 'Dieses Giveaway ist nicht mehr aktiv.')] });
      return;
    }

    const dbUser = await prisma.user.upsert({
      where: { discordId: btn.user.id },
      create: { discordId: btn.user.id, username: btn.user.username },
      update: {},
    });

    const existing = await prisma.giveawayEntry.findFirst({ where: { giveawayId, userId: dbUser.id } });
    let userMessage: string;
    let joined = false;

    if (existing) {
      await prisma.giveawayEntry.deleteMany({ where: { giveawayId, userId: dbUser.id } });
      userMessage = 'Deine Teilnahme wurde zurueckgezogen.';
      logAudit('GIVEAWAY_LEAVE', 'GIVEAWAY', { giveawayId, userId: dbUser.id, guildId: btn.guildId });
    } else {
      let memberRoleIds: Iterable<string> | null | undefined;
      const requiresRoleCheck = Boolean(giveaway.minRole) || (Array.isArray(giveaway.blacklistRoles) && giveaway.blacklistRoles.length > 0);
      if (requiresRoleCheck) {
        try {
          const member = await btn.guild?.members.fetch(btn.user.id);
          memberRoleIds = member ? member.roles.cache.keys() : null;
        } catch {
          memberRoleIds = null;
        }
      }

      const result = await enterGiveaway(giveawayId, btn.user.id, btn.guildId, memberRoleIds);
      if (!result.success) {
        await btn.editReply({ embeds: [interactionNotice('warning', 'Teilnahme nicht moeglich', result.message)] });
        return;
      }
      joined = true;
      userMessage = result.message;
    }

    await btn.editReply({
      embeds: [interactionNotice(joined ? 'success' : 'info', joined ? 'Teilnahme gespeichert' : 'Teilnahme beendet', userMessage)],
    });

    try {
      const participantCount = await prisma.giveawayEntry.count({ where: { giveawayId } });
      const creator = await prisma.user.findUnique({ where: { id: giveaway.creatorId }, select: { username: true } });
      const embed = createGiveawayEmbed(giveaway, participantCount, creator?.username);
      embed.addFields({ name: '🆔 ID', value: giveaway.id, inline: false });
      await btn.message.edit({ embeds: [embed], components: btn.message.components });
    } catch (error) {
      logger.error('Giveaway-Embed-Update nach Button fehlgeschlagen:', error);
    }
  } catch (error) {
    logger.error('Fehler bei Giveaway-Button:', error);
    try {
      const embed = interactionNotice('error', 'Giveaway-Aktion fehlgeschlagen', 'Die Aktion konnte nicht abgeschlossen werden.');
      if (btn.deferred) await btn.editReply({ embeds: [embed] });
      else await btn.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    } catch { /* ignore */ }
  }
}

export async function handleTicketButton(btn: ButtonInteraction): Promise<void> {
  try {
    const isAccept = btn.customId.startsWith('ticket_accept_');
    const ticketId = btn.customId.replace(/^ticket_(accept|deny)_/, '');
    await btn.deferReply({ ephemeral: false });

    const result = isAccept
      ? await acceptTicket(ticketId, btn.user.id, btn.client)
      : await denyTicket(ticketId, btn.user.id, btn.client);

    const kind: NoticeKind = result.success ? (isAccept ? 'success' : 'info') : 'warning';
    await btn.editReply({
      embeds: [interactionNotice(kind, result.success ? (isAccept ? 'Ticket angenommen' : 'Ticket abgelehnt') : 'Ticket nicht geaendert', result.message)],
    });

    try {
      if (btn.message.editable) await btn.message.edit({ components: [] });
    } catch { /* DM-Edit kann scheitern */ }
  } catch (error) {
    logger.error('Fehler bei Ticket-Button:', error);
    try {
      const embed = interactionNotice('error', 'Ticket-Aktion fehlgeschlagen', 'Die Ticket-Aktion konnte nicht abgeschlossen werden.');
      if (btn.deferred) await btn.editReply({ embeds: [embed] });
      else await btn.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    } catch { /* ignore */ }
  }
}
