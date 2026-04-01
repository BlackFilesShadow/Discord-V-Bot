import {
  Events,
  Interaction,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ModalSubmitInteraction,
} from 'discord.js';
import { BotEvent, ExtendedClient } from '../types';
import { logger, logAudit } from '../utils/logger';
import { checkRateLimit } from '../utils/rateLimiter';
import prisma from '../database/prisma';
import { decrypt } from '../utils/security';
import { verify2FAToken } from '../utils/security';
import { config } from '../config';

// Pending 2FA-Verifizierungen: Map<interactionCustomId, commandName>
const pending2FA = new Map<string, { commandName: string; userId: string; expires: number }>();

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

    // Admin/Dev-Command: 2FA-Verifizierung (Sektion 12)
    if (command.adminOnly || command.devOnly) {
      const authCheck = await requiresCommandAuth(i.user.id, command);

      if (authCheck.required) {
        // User-Rolle und 2FA prüfen
        const user = await prisma.user.findUnique({
          where: { discordId: i.user.id },
          include: { twoFactorAuth: true },
        });

        if (!user || !['ADMIN', 'SUPER_ADMIN', 'DEVELOPER'].includes(user.role)) {
          await i.reply({
            content: '🔒 Keine Berechtigung für diesen Command.',
            ephemeral: true,
          });
          logAudit('ADMIN_COMMAND_DENIED', 'SECURITY', {
            userId: i.user.id,
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
        const modalId = `2fa_verify_${i.user.id}_${Date.now()}`;
        pending2FA.set(modalId, {
          commandName: i.commandName,
          userId: i.user.id,
          expires: Date.now() + 120_000, // 2 Minuten
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
}, 60_000);

export default interactionCreateEvent;
