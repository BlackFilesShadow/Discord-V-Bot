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
import prisma from '../database/prisma';
import { approveManufacturer, denyManufacturer } from '../modules/registration/register';
import { config } from '../config';

// Pending Dev-Passwort-Verifizierungen
const pendingDevAuth = new Map<string, { commandName: string; userId: string; expires: number }>();

// Temporär authentifizierte Developer-Users (userId → expiresTimestamp)
// DEV-Session: 2 Stunden gültig
const devAuthenticatedUsers = new Map<string, number>();

const DEV_SESSION_MS = 2 * 60 * 60 * 1000; // 2 Stunden

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
      // Help-Pagination wird direkt vom Collector in help.ts verarbeitet — hier nichts tun
    }

    if (!i.isChatInputCommand()) return;

    const client = i.client as ExtendedClient;
    const command = client.commands.get(i.commandName);

    if (!command) {
      logger.warn(`Unbekannter Command: ${i.commandName}`);
      return;
    }

    // Rate-Limit prüfen
    const rateLimitResult = await checkRateLimit(i.user.id, 'command');
    if (!rateLimitResult.allowed) {
      await i.reply({
        content: `⚠️ Rate-Limit erreicht. Bitte warte bis ${rateLimitResult.resetAt.toLocaleTimeString('de-DE')}.`,
        ephemeral: true,
      });
      return;
    }

    // ──────────────────────────────────────────
    // PERMISSION-CHECK für Admin/Dev-Commands
    // ──────────────────────────────────────────
    if (command.adminOnly || command.devOnly) {
      const userId = i.user.id;

      // 1) Owner/Guild-Owner → IMMER durchlassen
      if (isOwnerOrGuildOwner(userId, i)) {
        // Keine Prüfung nötig — direkt ausführen
      }
      // 2) Dev-Commands → Passwort-Authentifizierung (2h Session)
      else if (command.devOnly) {
        if (!config.developer.password) {
          await i.reply({ content: '🔒 Developer-Passwort nicht konfiguriert.', ephemeral: true });
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
    }

    // Command ausführen
    try {
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

      await btn.update({ embeds: [updatedEmbed], components: [] });
    }
  } catch (error) {
    logger.error('Fehler bei Hersteller-Button:', error);
    if (!btn.replied) {
      await btn.reply({ content: '❌ Ein Fehler ist aufgetreten.', ephemeral: true });
    }
  }
}

export default interactionCreateEvent;
