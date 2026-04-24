import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  ChannelType,
  TextChannel,
} from 'discord.js';
import { Command } from '../../types';
import prisma from '../../database/prisma';
import { Colors, Brand, vEmbed } from '../../utils/embedDesign';
import { logger, logAudit } from '../../utils/logger';
import { getMenuFull, publishMenu } from '../../modules/selfrole/selfRoleMenu';

/**
 * /selfrole — Admins bauen Self-Role-Menus mit Buttons.
 * Sub: erstellen, option-add, option-remove, post, liste, loeschen
 */

const MAX_OPTIONS = 25;

const selfRoleCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('selfrole')
    .setDescription('Self-Role-Menus mit Buttons verwalten')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addSubcommand(sc => sc
      .setName('erstellen')
      .setDescription('Neues Self-Role-Menu anlegen (noch nicht gepostet)')
      .addStringOption(o => o.setName('titel').setDescription('Titel des Menus (max 120)').setRequired(true).setMaxLength(120))
      .addChannelOption(o => o.setName('channel').setDescription('Ziel-Channel zum Posten').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
      .addStringOption(o => o.setName('beschreibung').setDescription('Beschreibung').setRequired(false).setMaxLength(1500))
      .addStringOption(o => o.setName('modus').setDescription('Mehrere Rollen oder nur eine?').setRequired(false)
        .addChoices(
          { name: 'MULTI (mehrere erlaubt)', value: 'MULTI' },
          { name: 'SINGLE (nur eine gleichzeitig)', value: 'SINGLE' },
        ))
    )
    .addSubcommand(sc => sc
      .setName('option-add')
      .setDescription('Rolle als Button-Option hinzufügen')
      .addStringOption(o => o.setName('menu-id').setDescription('Menu-ID').setRequired(true))
      .addRoleOption(o => o.setName('rolle').setDescription('Rolle').setRequired(true))
      .addStringOption(o => o.setName('label').setDescription('Button-Label (max 80)').setRequired(true).setMaxLength(80))
      .addStringOption(o => o.setName('emoji').setDescription('Emoji (Unicode oder <:name:id>)').setRequired(false))
      .addStringOption(o => o.setName('beschreibung').setDescription('Optional: Kurzbeschreibung').setRequired(false).setMaxLength(100))
    )
    .addSubcommand(sc => sc
      .setName('option-remove')
      .setDescription('Rolle aus Menu entfernen')
      .addStringOption(o => o.setName('menu-id').setDescription('Menu-ID').setRequired(true))
      .addRoleOption(o => o.setName('rolle').setDescription('Rolle').setRequired(true))
    )
    .addSubcommand(sc => sc
      .setName('post')
      .setDescription('Menu im Ziel-Channel posten oder aktualisieren')
      .addStringOption(o => o.setName('menu-id').setDescription('Menu-ID').setRequired(true))
    )
    .addSubcommand(sc => sc
      .setName('liste')
      .setDescription('Alle Menus dieses Servers anzeigen')
    )
    .addSubcommand(sc => sc
      .setName('loeschen')
      .setDescription('Menu komplett löschen (DB + Discord-Message)')
      .addStringOption(o => o.setName('menu-id').setDescription('Menu-ID').setRequired(true))
    ),
  adminOnly: true,
  execute: async (interaction: ChatInputCommandInteraction) => {
    const sub = interaction.options.getSubcommand();
    if (!interaction.guildId) {
      await interaction.reply({ content: '❌ Nur in Servern verfügbar.', ephemeral: true });
      return;
    }
    try {
      await runSub(sub, interaction);
    } catch (e) {
      logger.error(`/selfrole ${sub} fehlgeschlagen`, e as Error);
      const msg = `❌ Fehler: ${String((e as Error)?.message ?? e).slice(0, 400)}`;
      try {
        if (interaction.deferred || interaction.replied) await interaction.editReply({ content: msg });
        else await interaction.reply({ content: msg, ephemeral: true });
      } catch { /* */ }
    }
  },
};

async function runSub(sub: string, interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;

  if (sub === 'erstellen') {
    const titel = interaction.options.getString('titel', true);
    const channel = interaction.options.getChannel('channel', true);
    const beschreibung = interaction.options.getString('beschreibung');
    const modus = interaction.options.getString('modus') ?? 'MULTI';

    await interaction.deferReply({ ephemeral: true });
    const menu = await prisma.selfRoleMenu.create({
      data: {
        guildId,
        channelId: channel.id,
        title: titel,
        description: beschreibung,
        mode: modus,
        createdBy: interaction.user.id,
      },
    });
    logAudit('SELFROLE_MENU_CREATED', 'ADMIN', { menuId: menu.id, guildId, adminId: interaction.user.id });
    await interaction.editReply({
      embeds: [
        vEmbed(Colors.Success).setTitle('✅ Menu angelegt').setDescription(
          [
            Brand.divider,
            `**ID:** \`${menu.id}\``,
            `**Titel:** ${titel}`,
            `**Channel:** <#${channel.id}>`,
            `**Modus:** ${modus}`,
            '',
            'Nächste Schritte:',
            '`/selfrole option-add menu-id:' + menu.id + ' rolle:@xyz label:Name`',
            '`/selfrole post menu-id:' + menu.id + '`',
            Brand.divider,
          ].join('\n')
        ),
      ],
    });
    return;
  }

  if (sub === 'option-add') {
    const menuId = interaction.options.getString('menu-id', true);
    const rolle = interaction.options.getRole('rolle', true);
    const label = interaction.options.getString('label', true);
    const emoji = interaction.options.getString('emoji');
    const desc = interaction.options.getString('beschreibung');

    await interaction.deferReply({ ephemeral: true });
    const menu = await prisma.selfRoleMenu.findUnique({
      where: { id: menuId },
      include: { options: true },
    });
    if (!menu || menu.guildId !== guildId) {
      await interaction.editReply({ content: '❌ Menu nicht gefunden.' });
      return;
    }
    if (menu.options.length >= MAX_OPTIONS) {
      await interaction.editReply({ content: `❌ Max. ${MAX_OPTIONS} Optionen pro Menu.` });
      return;
    }
    if (menu.options.some(o => o.roleId === rolle.id)) {
      await interaction.editReply({ content: '❌ Diese Rolle ist bereits im Menu.' });
      return;
    }

    // Bot-Hierarchie pruefen
    const me = interaction.guild!.members.me;
    if (me && rolle.id !== guildId && me.roles.highest.position <= (await interaction.guild!.roles.fetch(rolle.id))!.position) {
      await interaction.editReply({
        content: '⚠️ Achtung: Bot-Rolle steht NICHT über dieser Rolle. Vergabe wird zur Laufzeit fehlschlagen.',
      });
      // trotzdem speichern, aber als Warnung
    }

    await prisma.selfRoleOption.create({
      data: {
        menuId,
        roleId: rolle.id,
        label,
        emoji: emoji ?? null,
        description: desc ?? null,
        position: menu.options.length,
      },
    });
    logAudit('SELFROLE_OPTION_ADDED', 'ADMIN', { menuId, roleId: rolle.id, adminId: interaction.user.id });
    await interaction.editReply({
      embeds: [vEmbed(Colors.Success).setDescription(`✅ Option hinzugefügt: <@&${rolle.id}> als "${label}"`)],
    });
    return;
  }

  if (sub === 'option-remove') {
    const menuId = interaction.options.getString('menu-id', true);
    const rolle = interaction.options.getRole('rolle', true);
    await interaction.deferReply({ ephemeral: true });
    const menu = await prisma.selfRoleMenu.findUnique({ where: { id: menuId } });
    if (!menu || menu.guildId !== guildId) {
      await interaction.editReply({ content: '❌ Menu nicht gefunden.' });
      return;
    }
    const removed = await prisma.selfRoleOption.deleteMany({ where: { menuId, roleId: rolle.id } });
    if (removed.count === 0) {
      await interaction.editReply({ content: '❌ Diese Rolle war nicht im Menu.' });
      return;
    }
    logAudit('SELFROLE_OPTION_REMOVED', 'ADMIN', { menuId, roleId: rolle.id, adminId: interaction.user.id });
    await interaction.editReply({
      embeds: [vEmbed(Colors.Success).setDescription(`✅ Option entfernt: <@&${rolle.id}>`)],
    });
    return;
  }

  if (sub === 'post') {
    const menuId = interaction.options.getString('menu-id', true);
    await interaction.deferReply({ ephemeral: true });
    const menu = await getMenuFull(menuId);
    if (!menu || menu.guildId !== guildId) {
      await interaction.editReply({ content: '❌ Menu nicht gefunden.' });
      return;
    }
    if (menu.options.length === 0) {
      await interaction.editReply({ content: '❌ Menu hat keine Optionen.' });
      return;
    }
    const ch = await interaction.guild!.channels.fetch(menu.channelId).catch(() => null);
    if (!ch || !ch.isTextBased()) {
      await interaction.editReply({ content: '❌ Ziel-Channel nicht gefunden oder kein Text-Channel.' });
      return;
    }
    const msgId = await publishMenu(menu, ch as TextChannel);
    logAudit('SELFROLE_MENU_PUBLISHED', 'ADMIN', { menuId, messageId: msgId, adminId: interaction.user.id });
    await interaction.editReply({
      embeds: [vEmbed(Colors.Success).setDescription(`✅ Menu gepostet/aktualisiert in <#${menu.channelId}>.`)],
    });
    return;
  }

  if (sub === 'liste') {
    await interaction.deferReply({ ephemeral: true });
    const menus = await prisma.selfRoleMenu.findMany({
      where: { guildId },
      include: { options: true },
      orderBy: { createdAt: 'desc' },
      take: 25,
    });
    const embed = vEmbed(Colors.Info).setTitle(`🎭 Self-Role-Menus (${menus.length})`);
    if (!menus.length) {
      embed.setDescription('_Keine Menus. Erstelle eines mit `/selfrole erstellen`._');
    } else {
      for (const m of menus.slice(0, 15)) {
        embed.addFields({
          name: `\`${m.id}\` ${m.isActive ? '🟢' : '🔴'} • ${m.title}`,
          value: `Channel: <#${m.channelId}> • Modus: \`${m.mode}\` • Optionen: ${m.options.length}`,
          inline: false,
        });
      }
    }
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  if (sub === 'loeschen') {
    const menuId = interaction.options.getString('menu-id', true);
    await interaction.deferReply({ ephemeral: true });
    const menu = await prisma.selfRoleMenu.findUnique({ where: { id: menuId } });
    if (!menu || menu.guildId !== guildId) {
      await interaction.editReply({ content: '❌ Menu nicht gefunden.' });
      return;
    }
    if (menu.messageId) {
      try {
        const ch = await interaction.guild!.channels.fetch(menu.channelId).catch(() => null);
        if (ch && ch.isTextBased()) {
          const msg = await (ch as TextChannel).messages.fetch(menu.messageId).catch(() => null);
          if (msg) await msg.delete().catch(() => null);
        }
      } catch (e) {
        logger.warn('SelfRole-Loeschen: Discord-Message konnte nicht entfernt werden', e as Error);
      }
    }
    await prisma.selfRoleMenu.delete({ where: { id: menuId } });
    logAudit('SELFROLE_MENU_DELETED', 'ADMIN', { menuId, adminId: interaction.user.id });
    await interaction.editReply({
      embeds: [vEmbed(Colors.Success).setDescription(`✅ Menu \`${menuId}\` gelöscht.`)],
    });
    return;
  }
}

export default selfRoleCommand;
