import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
} from 'discord.js';
import { Command } from '../../types';
import prisma from '../../database/prisma';
import { logAudit } from '../../utils/logger';

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
  adminOnly: true,

  execute: async (interaction: ChatInputCommandInteraction) => {
    await interaction.deferReply({ ephemeral: true });

    const sub = interaction.options.getSubcommand();

    switch (sub) {
      case 'anzeigen': {
        const category = interaction.options.getString('kategorie');
        const where: Record<string, unknown> = {};
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
          const valueStr = JSON.stringify(c.value);
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

        let value: unknown;
        try {
          value = JSON.parse(valueStr);
        } catch {
          value = valueStr;
        }

        const category = key.split('.')[0] || 'general';

        await prisma.botConfig.upsert({
          where: { key },
          create: { key, value: value as any, category, description: description || undefined, updatedBy: interaction.user.id },
          update: { value: value as any, description: description || undefined, updatedBy: interaction.user.id },
        });

        logAudit('CONFIG_UPDATED', 'CONFIG', {
          key, value: valueStr, adminId: interaction.user.id,
        });

        await interaction.editReply({ content: `⚙️ Konfiguration aktualisiert:\n\`${key}\` = \`${valueStr}\`` });
        break;
      }

      case 'loeschen': {
        const key = interaction.options.getString('schluessel', true);
        const existing = await prisma.botConfig.findUnique({ where: { key } });
        if (!existing) {
          await interaction.editReply({ content: '❌ Konfigurationsschlüssel nicht gefunden.' });
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
