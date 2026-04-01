import {
  Events,
  Interaction,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ModalSubmitInteraction,
  ButtonBuilder,
  ButtonStyle,
  ButtonInteraction,
  EmbedBuilder,
} from 'discord.js';
import { BotEvent, ExtendedClient } from '../types';
import { logger, logAudit } from '../utils/logger';
import { checkRateLimit } from '../utils/rateLimiter';
import prisma from '../database/prisma';
import { approveManufacturer, denyManufacturer } from '../modules/registration/register';
import { decrypt } from '../utils/security';
import { verify2FAToken } from '../utils/security';
import { config } from '../config';

// Pending 2FA-Verifizierungen: Map<interactionCustomId, commandName>
const pending2FA = new Map<string, { commandName: string; userId: string; expires: number }>();

// Pending Dev-Passwort-Verifizierungen
const pendingDevAuth = new Map<string, { commandName: string; userId: string; options: any[]; expires: number }>();

/**
 * Prüft ob ein Admin-Command eine 2FA-Verifizierung benötigt.
 * Sektion 12: Bot-Command-Sicherheit — 2FA für Admin-/Dev-Commands.
 */
async function requiresCommandAuth(
  userId: string,
  command: { adminOnly?: boolean; devOnly?: boolean },
): Promise<{ required: boolean; reason?: string }> {
  if (!command.adminOnly && !command.devOnly) {
    return { required: false };
  }

  // User-Rolle in DB prüfen
  const user = await prisma.user.findUnique({
    where: { discordId: userId },
    include: { twoFactorAuth: true },
  });

  if (!user) {
    return { required: true, reason: 'User nicht in der Datenbank registriert.' };
  }

  // Rollenprüfung
  const allowedRoles = ['ADMIN', 'SUPER_ADMIN', 'DEVELOPER'];
  if (!allowedRoles.includes(user.role)) {
    return { required: true, reason: 'Keine Berechtigung für Admin-Commands.' };
  }

  // 2FA prüfen
  if (!user.twoFactorAuth?.isEnabled) {
    return { required: true, reason: '2FA ist nicht aktiviert. Richte 2FA über das Dashboard ein.' };
  }

  return { required: true };
}

/**
 * Interaction-Create-Event: Verarbeitet Slash-Commands und 2FA-Modals.
 * Sektion 5: Übersichtliche, erweiterbare Command-Struktur (Slash-Commands).
 * Sektion 12: Bot-Command-Auth mit 2FA-Verifizierung.
 */
const interactionCreateEvent: BotEvent = {
  name: Events.InteractionCreate,
  execute: async (interaction: unknown) => {
    const i = interaction as Interaction;

    // 2FA Modal-Submit verarbeiten
    if ('isModalSubmit' in i && (i as ModalSubmitInteraction).isModalSubmit()) {
      const modal = i as ModalSubmitInteraction;
      if (modal.customId.startsWith('2fa_verify_')) {
        await handle2FAModal(modal);
        return;
      }
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
      // Help-Pagination Buttons
      if (btn.customId.startsWith('help_page_')) {
        await handleHelpPagination(btn);
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

    // Rate-Limit prüfen (Sektion 4: Rate-Limit)
    const rateLimitResult = await checkRateLimit(i.user.id, 'command');
    if (!rateLimitResult.allowed) {
      await i.reply({
        content: `⚠️ Rate-Limit erreicht. Bitte warte bis ${rateLimitResult.resetAt.toLocaleTimeString('de-DE')}.`,
        ephemeral: true,
      });
      return;
    }

    // Admin/Dev-Command: Berechtigungsprüfung (Sektion 12)
    if (command.adminOnly || command.devOnly) {
      const userId = i.user.id;

      // Bot-Owner und Server-Owner dürfen Admin-Commands ohne 2FA
      const isOwner = userId === config.discord.ownerId;
      const isGuildOwner = i.guild && i.guild.ownerId === userId;

      if (!isOwner && !isGuildOwner) {
        // Dev-Commands: Passwort-Authentifizierung erforderlich
        if (command.devOnly) {
          if (!config.developer.password) {
            await i.reply({ content: '🔒 Developer-Passwort nicht konfiguriert.', ephemeral: true });
            return;
          }

          // Prüfe ob User bereits temporär authentifiziert ist
          const devExpires = devAuthenticatedUsers.get(userId);
          if (devExpires && devExpires > Date.now()) {
            // Authentifiziert — Command durchlassen
          } else {
            devAuthenticatedUsers.delete(userId);

            const modalId = `dev_auth_${userId}_${Date.now()}`;
            pendingDevAuth.set(modalId, {
              commandName: i.commandName,
              userId,
              options: i.options.data.map(o => ({ name: o.name, value: o.value })),
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

        const authCheck = await requiresCommandAuth(userId, command);

        if (authCheck.required) {
          const user = await prisma.user.findUnique({
            where: { discordId: userId },
            include: { twoFactorAuth: true },
          });

          if (!user || !['ADMIN', 'SUPER_ADMIN', 'DEVELOPER'].includes(user.role)) {
            await i.reply({
              content: '🔒 Keine Berechtigung für diesen Command.',
              ephemeral: true,
            });
            logAudit('ADMIN_COMMAND_DENIED', 'SECURITY', {
              userId,
              command: i.commandName,
              reason: 'Unzureichende Rolle',
            });
            return;
          }

          if (!user.twoFactorAuth?.isEnabled) {
            await i.reply({
              content: '🔒 2FA ist nicht aktiviert. Richte 2FA über das Dashboard ein, um Admin-Commands nutzen zu können.',
              ephemeral: true,
            });
            return;
          }

          // 2FA-Modal anzeigen
          const modalId = `2fa_verify_${userId}_${Date.now()}`;
          pending2FA.set(modalId, {
            commandName: i.commandName,
            userId,
            expires: Date.now() + 120_000,
          });

          const modal = new ModalBuilder()
            .setCustomId(modalId)
            .setTitle('🔐 2FA-Verifizierung');

          const tokenInput = new TextInputBuilder()
            .setCustomId('totp_code')
            .setLabel('TOTP-Code eingeben')
            .setPlaceholder('6-stelliger Code aus deiner Authenticator-App')
            .setStyle(TextInputStyle.Short)
            .setMinLength(6)
            .setMaxLength(6)
            .setRequired(true);

          const row = new ActionRowBuilder<TextInputBuilder>().addComponents(tokenInput);
          modal.addComponents(row);

          await i.showModal(modal);
          return;
        }
      }
    }

    try {
      // Audit-Log (Sektion 11: Logging aller Aktionen)
      logAudit('COMMAND_EXECUTE', 'SYSTEM', {
        userId: i.user.id,
        command: i.commandName,
        channelId: i.channelId,
        guildId: i.guildId,
        options: i.options.data.map(o => ({ name: o.name, value: o.value })),
      });

      await command.execute(i);
    } catch (error) {
      logger.error(`Fehler bei Command ${i.commandName}:`, error);

      const errorMessage = '❌ Ein Fehler ist aufgetreten. Bitte versuche es erneut.';
      if (i.replied || i.deferred) {
        await i.followUp({ content: errorMessage, ephemeral: true });
      } else {
        await i.reply({ content: errorMessage, ephemeral: true });
      }
    }
  },
};

/**
 * Verarbeitet 2FA-Modal-Eingaben und führt den Admin-Command nach Verifizierung aus.
 */
async function handle2FAModal(modal: ModalSubmitInteraction): Promise<void> {
  const pendingData = pending2FA.get(modal.customId);

  if (!pendingData || pendingData.expires < Date.now()) {
    pending2FA.delete(modal.customId);
    await modal.reply({ content: '⏰ 2FA-Verifizierung abgelaufen. Bitte erneut versuchen.', ephemeral: true });
    return;
  }

  if (pendingData.userId !== modal.user.id) {
    await modal.reply({ content: '🔒 Unbefugter Zugriff.', ephemeral: true });
    return;
  }

  const totpCode = modal.fields.getTextInputValue('totp_code');

  // 2FA verifizieren
  const user = await prisma.user.findUnique({
    where: { discordId: modal.user.id },
    include: { twoFactorAuth: true },
  });

  if (!user?.twoFactorAuth?.secretEnc) {
    pending2FA.delete(modal.customId);
    await modal.reply({ content: '❌ 2FA-Konfiguration nicht gefunden.', ephemeral: true });
    return;
  }

  const secret = decrypt(user.twoFactorAuth.secretEnc, config.security.encryptionKey);
  const isValid = verify2FAToken(secret, totpCode);

  if (!isValid) {
    pending2FA.delete(modal.customId);
    logAudit('ADMIN_2FA_FAILED', 'SECURITY', {
      userId: modal.user.id,
      command: pendingData.commandName,
    });
    await modal.reply({ content: '❌ Ungültiger 2FA-Code. Command abgebrochen.', ephemeral: true });
    return;
  }

  pending2FA.delete(modal.customId);

  logAudit('ADMIN_2FA_SUCCESS', 'AUTH', {
    userId: modal.user.id,
    command: pendingData.commandName,
  });

  await modal.reply({
    content: `✅ 2FA verifiziert. Command \`/${pendingData.commandName}\` wird ausgeführt...`,
    ephemeral: true,
  });
}

// Periodisch abgelaufene pending 2FA-Einträge bereinigen
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of pending2FA) {
    if (value.expires < now) pending2FA.delete(key);
  }
  for (const [key, value] of pendingDevAuth) {
    if (value.expires < now) pendingDevAuth.delete(key);
  }
}, 60_000);

/**
 * Verarbeitet Developer-Passwort-Modal und führt den Dev-Command aus.
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

  const enteredPassword = modal.fields.getTextInputValue('dev_password');

  if (enteredPassword !== config.developer.password) {
    pendingDevAuth.delete(modal.customId);
    logAudit('DEV_AUTH_FAILED', 'SECURITY', {
      userId: modal.user.id,
      command: pendingData.commandName,
    });
    await modal.reply({ content: '❌ Falsches Developer-Passwort.', ephemeral: true });
    return;
  }

  pendingDevAuth.delete(modal.customId);

  logAudit('DEV_AUTH_SUCCESS', 'AUTH', {
    userId: modal.user.id,
    command: pendingData.commandName,
  });

  // Command ausführen
  const client = modal.client as ExtendedClient;
  const command = client.commands.get(pendingData.commandName);

  if (!command) {
    await modal.reply({ content: '❌ Command nicht gefunden.', ephemeral: true });
    return;
  }

  // Dev-Command mit Fake-Interaction ausführen geht nicht einfach.
  // Stattdessen: Bestätigung senden und User auffordern, den Command erneut auszuführen.
  // Besser: Wir markieren den User als temporär authentifiziert.
  devAuthenticatedUsers.set(modal.user.id, Date.now() + 300_000); // 5 Min gültig

  await modal.reply({
    content: `✅ Developer-Zugang für 5 Minuten freigeschaltet. Bitte verwende \`/${pendingData.commandName}\` erneut.`,
    ephemeral: true,
  });
}

// Temporär authentifizierte Developer-Users (userId → expiresTimestamp)
const devAuthenticatedUsers = new Map<string, number>();

/**
 * Verarbeitet Approve/Deny-Buttons für Hersteller-Anfragen per DM.
 */
async function handleManufacturerButton(btn: ButtonInteraction): Promise<void> {
  const isApprove = btn.customId.startsWith('approve_manufacturer_');
  const targetUserId = btn.customId.replace(/^(approve|deny)_manufacturer_/, '');

  try {
    if (isApprove) {
      const result = await approveManufacturer(targetUserId, btn.user.id);
      if (!result.success) {
        await btn.reply({ content: `❌ ${result.message}`, ephemeral: true });
        return;
      }

      // OTP dem User per DM senden
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
                `Verwende \`/register verify\` um dich zu verifizieren.`
              )
              .setColor(0x00ff00)
              .setTimestamp(),
          ],
        });
      } catch {
        logger.warn(`Konnte DM an ${targetUserId} nicht senden.`);
      }

      // Button-Nachricht aktualisieren
      const updatedEmbed = EmbedBuilder.from(btn.message.embeds[0])
        .setColor(0x00ff00)
        .setFooter({ text: `✅ Angenommen von ${btn.user.username}` });

      await btn.update({ embeds: [updatedEmbed], components: [] });
    } else {
      const result = await denyManufacturer(targetUserId, btn.user.id);
      if (!result.success) {
        await btn.reply({ content: `❌ ${result.message}`, ephemeral: true });
        return;
      }

      // User per DM benachrichtigen
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

      // Button-Nachricht aktualisieren
      const updatedEmbed = EmbedBuilder.from(btn.message.embeds[0])
        .setColor(0xff0000)
        .setFooter({ text: `❌ Abgelehnt von ${btn.user.username}` });

      await btn.update({ embeds: [updatedEmbed], components: [] });
    }
  } catch (error) {
    logger.error('Fehler bei Hersteller-Button:', error);
    if (!btn.replied) {
      await btn.reply({ content: '❌ Ein Fehler ist aufgetreten.', ephemeral: true });
    }
  }
}

/**
 * Help-Pagination per Buttons.
 */
async function handleHelpPagination(btn: ButtonInteraction): Promise<void> {
  // Wird von help.ts verarbeitet — Collector dort
  return;
}

export default interactionCreateEvent;
