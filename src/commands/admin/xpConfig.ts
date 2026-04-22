import { SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits } from 'discord.js';
import { Command } from '../../types';
import prisma from '../../database/prisma';

/**
 * /xp-config
 * Konfiguriere XP-Raten, Levelrollen, XP-Berechtigungs-Rollen und Max-Level-Belohnung.
 */
const xpConfigCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('xp-config')
    .setDescription('XP-System konfigurieren (Raten, Rollen, Max-Level)')
    .addSubcommand(sub =>
      sub
        .setName('rate')
        .setDescription('XP-Raten einstellen')
        .addIntegerOption(opt => opt.setName('min').setDescription('Min XP/Nachricht').setRequired(false))
        .addIntegerOption(opt => opt.setName('max').setDescription('Max XP/Nachricht').setRequired(false))
        .addIntegerOption(opt => opt.setName('voice').setDescription('XP/Voice-Minute').setRequired(false))
        .addNumberOption(opt => opt.setName('multiplier').setDescription('XP-Multiplikator').setRequired(false))
    )
    .addSubcommand(sub =>
      sub
        .setName('levelrole')
        .setDescription('Levelrolle für ein bestimmtes Level setzen')
        .addIntegerOption(opt => opt.setName('level').setDescription('Level').setRequired(true))
        .addRoleOption(opt => opt.setName('role').setDescription('Discord-Rolle').setRequired(true))
    )
    .addSubcommand(sub =>
      sub
        .setName('xp-rolle-add')
        .setDescription('Rolle hinzufügen, die XP sammeln darf (leer = alle)')
        .addRoleOption(opt => opt.setName('role').setDescription('Berechtigte Rolle').setRequired(true))
    )
    .addSubcommand(sub =>
      sub
        .setName('xp-rolle-remove')
        .setDescription('Rolle aus den XP-berechtigten Rollen entfernen')
        .addRoleOption(opt => opt.setName('role').setDescription('Rolle').setRequired(true))
    )
    .addSubcommand(sub =>
      sub
        .setName('xp-rolle-list')
        .setDescription('Alle XP-berechtigten Rollen anzeigen')
    )
    .addSubcommand(sub =>
      sub
        .setName('xp-channel-add')
        .setDescription('Kanal hinzufügen, in dem XP gesammelt werden darf (strikt)')
        .addChannelOption(opt => opt.setName('channel').setDescription('Berechtigter Kanal').setRequired(true))
    )
    .addSubcommand(sub =>
      sub
        .setName('xp-channel-remove')
        .setDescription('Kanal aus den XP-berechtigten Kanälen entfernen')
        .addChannelOption(opt => opt.setName('channel').setDescription('Kanal').setRequired(true))
    )
    .addSubcommand(sub =>
      sub
        .setName('xp-channel-list')
        .setDescription('Alle XP-berechtigten Kanäle anzeigen')
    )
    .addSubcommand(sub =>
      sub
        .setName('xp-channel-clear')
        .setDescription('Kanal-Beschränkung aufheben (XP wieder in allen Kanälen)')
    )
    .addSubcommand(sub =>
      sub
        .setName('max-level')
        .setDescription('Maximales Level festlegen (1–100)')
        .addIntegerOption(opt => opt.setName('level').setDescription('Max-Level').setRequired(true).setMinValue(1).setMaxValue(100))
    )
    .addSubcommand(sub =>
      sub
        .setName('max-rolle')
        .setDescription('Belohnungsrolle für das Erreichen des Max-Levels')
        .addRoleOption(opt => opt.setName('role').setDescription('Rolle (oder leer zum Entfernen)').setRequired(false))
    )
    .addSubcommand(sub =>
      sub
        .setName('show')
        .setDescription('Aktuelle XP-Konfiguration anzeigen')
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) as SlashCommandBuilder,
  adminOnly: true,

  execute: async (interaction: ChatInputCommandInteraction) => {
    await interaction.deferReply({ ephemeral: true });
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.editReply('❌ Nur auf Servern verfügbar.');
      return;
    }

    // Hilfsfunktion: Config sicherstellen
    const ensureConfig = async () =>
      prisma.xpConfig.upsert({
        where: { id: guildId },
        update: {},
        create: { id: guildId },
      });

    if (sub === 'rate') {
      const min = interaction.options.getInteger('min');
      const max = interaction.options.getInteger('max');
      const voice = interaction.options.getInteger('voice');
      const multiplier = interaction.options.getNumber('multiplier');
      const config = await prisma.xpConfig.upsert({
        where: { id: guildId },
        update: {
          ...(min !== null ? { messageXpMin: min } : {}),
          ...(max !== null ? { messageXpMax: max } : {}),
          ...(voice !== null ? { voiceXpPerMinute: voice } : {}),
          ...(multiplier !== null ? { levelMultiplier: multiplier } : {}),
        },
        create: {
          id: guildId,
          messageXpMin: min ?? 15,
          messageXpMax: max ?? 25,
          voiceXpPerMinute: voice ?? 5,
          levelMultiplier: multiplier ?? 1.0,
        },
      });
      await interaction.editReply(`✅ XP-Konfiguration aktualisiert:
Min: ${config.messageXpMin}, Max: ${config.messageXpMax}, Voice: ${config.voiceXpPerMinute}, Multiplikator: ${config.levelMultiplier}`);
      return;
    }

    if (sub === 'levelrole') {
      const level = interaction.options.getInteger('level', true);
      const role = interaction.options.getRole('role', true);
      await prisma.levelRole.upsert({
        where: { guildId_level: { guildId, level } },
        update: { roleId: role.id },
        create: { guildId, level, roleId: role.id },
      });
      await interaction.editReply(`✅ Rolle <@&${role.id}> wird ab Level ${level} automatisch vergeben.`);
      return;
    }

    if (sub === 'xp-rolle-add') {
      const role = interaction.options.getRole('role', true);
      const cfg = await ensureConfig();
      const list = Array.isArray(cfg.allowedRoleIds) ? (cfg.allowedRoleIds as string[]) : [];
      if (list.includes(role.id)) {
        await interaction.editReply(`ℹ️ <@&${role.id}> ist bereits in der XP-Berechtigungsliste.`);
        return;
      }
      list.push(role.id);
      await prisma.xpConfig.update({
        where: { id: guildId },
        data: { allowedRoleIds: list },
      });
      await interaction.editReply(`✅ <@&${role.id}> bekommt jetzt XP. (${list.length} Rollen aktiv)`);
      return;
    }

    if (sub === 'xp-rolle-remove') {
      const role = interaction.options.getRole('role', true);
      const cfg = await ensureConfig();
      const list = Array.isArray(cfg.allowedRoleIds) ? (cfg.allowedRoleIds as string[]) : [];
      const next = list.filter(r => r !== role.id);
      await prisma.xpConfig.update({
        where: { id: guildId },
        data: { allowedRoleIds: next.length > 0 ? next : [] },
      });
      await interaction.editReply(`✅ <@&${role.id}> aus XP-Berechtigung entfernt. (${next.length} Rollen aktiv)`);
      return;
    }

    if (sub === 'xp-rolle-list') {
      const cfg = await ensureConfig();
      const list = Array.isArray(cfg.allowedRoleIds) ? (cfg.allowedRoleIds as string[]) : [];
      if (list.length === 0) {
        await interaction.editReply('ℹ️ Keine Rollen-Beschränkung gesetzt — **alle User** bekommen XP.');
        return;
      }
      await interaction.editReply(`📋 XP-berechtigte Rollen (${list.length}):\n${list.map(r => `• <@&${r}>`).join('\n')}`);
      return;
    }

    if (sub === 'xp-channel-add') {
      const channel = interaction.options.getChannel('channel', true);
      const cfg = await ensureConfig();
      const list = Array.isArray(cfg.allowedChannelIds) ? (cfg.allowedChannelIds as string[]) : [];
      if (list.includes(channel.id)) {
        await interaction.editReply(`ℹ️ <#${channel.id}> ist bereits in der XP-Kanalliste.`);
        return;
      }
      list.push(channel.id);
      await prisma.xpConfig.update({
        where: { id: guildId },
        data: { allowedChannelIds: list },
      });
      await interaction.editReply(`✅ XP wird ab sofort **strikt nur** in folgenden Kanälen vergeben (${list.length}):\n${list.map(c => `• <#${c}>`).join('\n')}`);
      return;
    }

    if (sub === 'xp-channel-remove') {
      const channel = interaction.options.getChannel('channel', true);
      const cfg = await ensureConfig();
      const list = Array.isArray(cfg.allowedChannelIds) ? (cfg.allowedChannelIds as string[]) : [];
      const next = list.filter(c => c !== channel.id);
      await prisma.xpConfig.update({
        where: { id: guildId },
        data: { allowedChannelIds: next.length > 0 ? next : [] },
      });
      await interaction.editReply(`✅ <#${channel.id}> aus XP-Kanalliste entfernt. (${next.length} Kanäle aktiv)`);
      return;
    }

    if (sub === 'xp-channel-list') {
      const cfg = await ensureConfig();
      const list = Array.isArray(cfg.allowedChannelIds) ? (cfg.allowedChannelIds as string[]) : [];
      if (list.length === 0) {
        await interaction.editReply('ℹ️ Keine Kanal-Beschränkung — XP wird in **allen** Kanälen vergeben.');
        return;
      }
      await interaction.editReply(`📋 XP-berechtigte Kanäle (${list.length}, strikt):\n${list.map(c => `• <#${c}>`).join('\n')}`);
      return;
    }

    if (sub === 'xp-channel-clear') {
      await prisma.xpConfig.update({
        where: { id: guildId },
        data: { allowedChannelIds: [] },
      });
      await interaction.editReply('✅ Kanal-Beschränkung aufgehoben — XP wird wieder in **allen** Kanälen vergeben.');
      return;
    }

    if (sub === 'max-level') {
      const level = interaction.options.getInteger('level', true);
      await prisma.xpConfig.upsert({
        where: { id: guildId },
        update: { maxLevel: level },
        create: { id: guildId, maxLevel: level },
      });
      await interaction.editReply(`✅ Max-Level auf **${level}** gesetzt.`);
      return;
    }

    if (sub === 'max-rolle') {
      const role = interaction.options.getRole('role');
      await prisma.xpConfig.upsert({
        where: { id: guildId },
        update: { maxLevelRoleId: role?.id ?? null },
        create: { id: guildId, maxLevelRoleId: role?.id ?? null },
      });
      if (role) {
        await interaction.editReply(`✅ Bei Erreichen des Max-Levels wird automatisch <@&${role.id}> vergeben.`);
      } else {
        await interaction.editReply('✅ Max-Level-Belohnungsrolle entfernt.');
      }
      return;
    }

    if (sub === 'show') {
      const cfg = await ensureConfig();
      const list = Array.isArray(cfg.allowedRoleIds) ? (cfg.allowedRoleIds as string[]) : [];
      const channels = Array.isArray(cfg.allowedChannelIds) ? (cfg.allowedChannelIds as string[]) : [];
      const roles = list.length > 0 ? list.map(r => `<@&${r}>`).join(', ') : '*alle*';
      const chanStr = channels.length > 0 ? channels.map(c => `<#${c}>`).join(', ') : '*alle*';
      await interaction.editReply([
        '📊 **XP-Konfiguration**',
        `• Min/Max XP: ${cfg.messageXpMin}/${cfg.messageXpMax}`,
        `• Voice XP/Min: ${cfg.voiceXpPerMinute}`,
        `• Multiplikator: ${cfg.levelMultiplier}`,
        `• Cooldown: ${cfg.xpCooldownSeconds}s`,
        `• Max-Level: **${cfg.maxLevel}**`,
        `• Max-Level-Rolle: ${cfg.maxLevelRoleId ? `<@&${cfg.maxLevelRoleId}>` : '–'}`,
        `• XP-Berechtigte Rollen: ${roles}`,
        `• XP-Berechtigte Kanäle (strikt): ${chanStr}`,
      ].join('\n'));
      return;
    }
  },
};

export default xpConfigCommand;
