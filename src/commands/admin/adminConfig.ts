import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
  MessageFlags,
} from 'discord.js';
import { Prisma } from '@prisma/client';
import { Command } from '../../types';
import prisma from '../../database/prisma';
import { logAudit } from '../../utils/logger';

/**
 * Schluessel, die niemals ueber diesen Command geaendert/geloescht werden
 * duerfen (System-/Sicherheitskritisch). Schuetzt u.a. den Singleton-Lock.
 */
const PROTECTED_KEY_PREFIXES = ['bot:', 'system.', 'singleton'];
const PROTECTED_CATEGORIES = new Set(['system']);

function isProtectedKey(key: string): boolean {
  const lower = key.toLowerCase();
  return PROTECTED_KEY_PREFIXES.some(p => lower.startsWith(p));
}

/** Heuristik: enthaelt der Key ein Geheimnis? Dann Wert maskieren. */
function isSensitiveConfigKey(key: string): boolean {
  return /password|secret|token|api[_.-]?key|rcon|credential|private/i.test(key);
}

function maskValue(key: string, valueStr: string): string {
  return isSensitiveConfigKey(key) ? '«redigiert»' : valueStr;
}

/**
 * /admin-config — Einstellungen, Limits, Security-Policies live anpassen.
 * Developer-Bereich: Bot-Konfiguration.
 */
const adminConfigCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('admin-config')
    .setDescription('Bot-Konfiguration live anpassen')
    .addSubcommand(sub =>
      sub
        .setName('anzeigen')
        .setDescription('Aktuelle Konfiguration anzeigen')
        .addStringOption(opt =>
          opt.setName('kategorie').setDescription('Konfigurationskategorie').setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('setzen')
        .setDescription('Konfigurationswert setzen')
        .addStringOption(opt =>
          opt.setName('schluessel').setDescription('Konfigurationsschlüssel (z.B. "upload.maxSize")').setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('wert').setDescription('Neuer Wert (JSON-Format für komplexe Werte)').setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('beschreibung').setDescription('Beschreibung der Einstellung').setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('loeschen')
        .setDescription('Konfigurationswert löschen')
        .addStringOption(opt =>
          opt.setName('schluessel').setDescription('Zu löschender Schlüssel').setRequired(true)
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) as SlashCommandBuilder,
  devOnly: true,

  execute: async (interaction: ChatInputCommandInteraction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const sub = interaction.options.getSubcommand();

    switch (sub) {
      case 'anzeigen': {
        const category = interaction.options.getString('kategorie');
        const where: Prisma.BotConfigWhereInput = {};
        if (category) {
          where.category = category;
        }

        const configs = await prisma.botConfig.findMany({
          where,
          orderBy: [{ category: 'asc' }, { key: 'asc' }],
        });

        if (configs.length === 0) {
          await interaction.editReply({ content: '📋 Keine Konfigurationseinträge gefunden.' });
          return;
        }

        const grouped: Record<string, string[]> = {};
        for (const c of configs) {
          if (!grouped[c.category]) grouped[c.category] = [];
          const valueStr = maskValue(c.key, JSON.stringify(c.value));
          grouped[c.category].push(`\`${c.key}\`: ${valueStr}${c.description ? ` — *${c.description}*` : ''}`);
        }

        const lines = Object.entries(grouped)
          .map(([cat, entries]) => `**${cat}**\n${entries.join('\n')}`)
          .join('\n\n');

        const embed = new EmbedBuilder()
          .setTitle('⚙️ Bot-Konfiguration')
          .setDescription(lines)
          .setColor(0x2ecc71)
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
        break;
      }

      case 'setzen': {
        const key = interaction.options.getString('schluessel', true);
        const valueStr = interaction.options.getString('wert', true);
        const description = interaction.options.getString('beschreibung');

        if (isProtectedKey(key)) {
          await interaction.editReply({ content: '⛔ Dieser Schlüssel ist geschützt und kann nicht geändert werden.' });
          return;
        }

        let value: Prisma.InputJsonValue;
        try {
          value = JSON.parse(valueStr) as Prisma.InputJsonValue;
        } catch {
          value = valueStr;
        }

        const category = key.split('.')[0] || 'general';
        if (PROTECTED_CATEGORIES.has(category)) {
          await interaction.editReply({ content: '⛔ Die Kategorie `system` ist geschützt.' });
          return;
        }

        await prisma.botConfig.upsert({
          where: { key },
          create: { key, value, category, description: description || undefined, updatedBy: interaction.user.id },
          update: { value, description: description || undefined, updatedBy: interaction.user.id },
        });

        // P0: Wert niemals vollständig auditieren (Secrets). Nur maskiert.
        logAudit('CONFIG_UPDATED', 'CONFIG', {
          key, value: maskValue(key, valueStr), adminId: interaction.user.id,
        });

        await interaction.editReply({ content: `⚙️ Konfiguration aktualisiert:\n\`${key}\` = \`${maskValue(key, valueStr)}\`` });
        break;
      }

      case 'loeschen': {
        const key = interaction.options.getString('schluessel', true);
        if (isProtectedKey(key)) {
          await interaction.editReply({ content: '⛔ Dieser Schlüssel ist geschützt und kann nicht gelöscht werden.' });
          return;
        }
        const existing = await prisma.botConfig.findUnique({ where: { key } });
        if (!existing) {
          await interaction.editReply({ content: '❌ Konfigurationsschlüssel nicht gefunden.' });
          return;
        }
        if (PROTECTED_CATEGORIES.has(existing.category)) {
          await interaction.editReply({ content: '⛔ Einträge der Kategorie `system` können nicht gelöscht werden.' });
          return;
        }

        await prisma.botConfig.delete({ where: { key } });
        logAudit('CONFIG_DELETED', 'CONFIG', { key, adminId: interaction.user.id });
        await interaction.editReply({ content: `🗑️ Konfiguration \`${key}\` gelöscht.` });
        break;
      }
    }
  },
};

export default adminConfigCommand;
