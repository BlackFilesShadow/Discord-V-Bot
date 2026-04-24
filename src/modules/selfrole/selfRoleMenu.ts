import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  EmbedBuilder,
  Guild,
  GuildMember,
  TextChannel,
} from 'discord.js';
import prisma from '../../database/prisma';
import { Colors, Brand, vEmbed } from '../../utils/embedDesign';
import { logger, logAudit } from '../../utils/logger';

/**
 * SelfRole-Modul: Admin baut Menus, User toggelt Rollen via Button.
 * customId-Schema: selfrole_<menuId>_<roleId>
 */

interface MenuOption {
  id: string;
  roleId: string;
  label: string;
  emoji: string | null;
  description: string | null;
  position: number;
}

interface MenuFull {
  id: string;
  guildId: string;
  channelId: string;
  messageId: string | null;
  title: string;
  description: string | null;
  mode: string;
  isActive: boolean;
  options: MenuOption[];
}

export function buildMenuEmbed(menu: MenuFull): EmbedBuilder {
  const lines = menu.options.map(o => {
    const e = o.emoji ? `${o.emoji} ` : '';
    return `${e}<@&${o.roleId}>${o.description ? ` — ${o.description}` : ''}`;
  });
  const desc = [
    Brand.divider,
    menu.description ?? '',
    menu.description ? '' : '',
    lines.join('\n') || '_Keine Optionen._',
    Brand.divider,
    `Modus: \`${menu.mode}\` ${menu.mode === 'SINGLE' ? '(nur eine Rolle gleichzeitig)' : '(mehrere Rollen erlaubt)'}`,
  ].filter(s => s !== '').join('\n');
  return vEmbed(Colors.Primary)
    .setTitle(`🎭 ${menu.title}`)
    .setDescription(desc)
    .setFooter({ text: `${Brand.footerText} • Self-Role-Menu` });
}

export function buildMenuRows(menu: MenuFull): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  let current = new ActionRowBuilder<ButtonBuilder>();
  let count = 0;
  for (const opt of menu.options) {
    if (count > 0 && count % 5 === 0) {
      rows.push(current);
      current = new ActionRowBuilder<ButtonBuilder>();
    }
    const btn = new ButtonBuilder()
      .setCustomId(`selfrole_${menu.id}_${opt.roleId}`)
      .setLabel(opt.label.slice(0, 80))
      .setStyle(ButtonStyle.Secondary);
    if (opt.emoji) {
      try { btn.setEmoji(opt.emoji); } catch { /* ungueltig, ignorieren */ }
    }
    current.addComponents(btn);
    count++;
    if (rows.length >= 4 && count % 5 === 0) break; // max 5 Rows = 25 Buttons
  }
  if (current.components.length > 0 && rows.length < 5) rows.push(current);
  return rows;
}

export async function getMenuFull(menuId: string): Promise<MenuFull | null> {
  const m = await prisma.selfRoleMenu.findUnique({
    where: { id: menuId },
    include: { options: { orderBy: { position: 'asc' } } },
  });
  if (!m) return null;
  return m as unknown as MenuFull;
}

/**
 * Wird aus events/interactionCreate.ts aufgerufen wenn customId mit "selfrole_" startet.
 */
export async function handleSelfRoleButton(btn: ButtonInteraction): Promise<void> {
  const parts = btn.customId.split('_');
  // selfrole_<menuId>_<roleId>
  if (parts.length < 3) return;
  const menuId = parts[1];
  const roleId = parts.slice(2).join('_'); // RoleIds enthalten keine _ aber sicher

  if (!btn.guild || !btn.member) {
    await btn.reply({ content: '❌ Nur in Servern verfügbar.', ephemeral: true });
    return;
  }

  let menu: MenuFull | null;
  try {
    menu = await getMenuFull(menuId);
  } catch (e) {
    logger.warn('SelfRole: Menu-Load fehlgeschlagen', e as Error);
    await btn.reply({ content: '❌ Menu konnte nicht geladen werden.', ephemeral: true });
    return;
  }
  if (!menu || !menu.isActive) {
    await btn.reply({ content: '❌ Menu ist inaktiv oder nicht gefunden.', ephemeral: true });
    return;
  }
  const opt = menu.options.find(o => o.roleId === roleId);
  if (!opt) {
    await btn.reply({ content: '❌ Diese Rollen-Option existiert nicht mehr.', ephemeral: true });
    return;
  }

  const guild = btn.guild as Guild;
  const role = await guild.roles.fetch(roleId).catch(() => null);
  if (!role) {
    await btn.reply({ content: '❌ Rolle existiert nicht mehr im Server.', ephemeral: true });
    return;
  }

  // Bot-Hierarchie pruefen
  const me = guild.members.me;
  if (!me || me.roles.highest.position <= role.position) {
    await btn.reply({
      content: '❌ Ich kann diese Rolle nicht vergeben (Bot-Rolle muss höher stehen).',
      ephemeral: true,
    });
    return;
  }

  const member = btn.member as GuildMember;
  const has = member.roles.cache.has(roleId);

  try {
    if (has) {
      await member.roles.remove(roleId, `SelfRole-Menu ${menu.id}: opt-out`);
      logAudit('SELFROLE_REMOVED', 'USER', { menuId, roleId, userId: member.id });
      await btn.reply({ content: `✅ Rolle <@&${roleId}> entfernt.`, ephemeral: true });
      return;
    }

    // SINGLE-Mode: andere Menu-Rollen vorher entfernen
    if (menu.mode === 'SINGLE') {
      const otherIds = menu.options.map(o => o.roleId).filter(id => id !== roleId);
      const toRemove = otherIds.filter(id => member.roles.cache.has(id));
      for (const id of toRemove) {
        try {
          const r = await guild.roles.fetch(id).catch(() => null);
          if (r && me.roles.highest.position > r.position) {
            await member.roles.remove(id, `SelfRole-Menu ${menu.id}: SINGLE-mode swap`);
          }
        } catch (e) {
          logger.warn(`SelfRole SINGLE swap remove ${id} fehlgeschlagen`, e as Error);
        }
      }
    }

    await member.roles.add(roleId, `SelfRole-Menu ${menu.id}: opt-in`);
    logAudit('SELFROLE_ADDED', 'USER', { menuId, roleId, userId: member.id });
    await btn.reply({ content: `✅ Rolle <@&${roleId}> hinzugefügt.`, ephemeral: true });
  } catch (e) {
    logger.error('SelfRole-Toggle fehlgeschlagen', e as Error);
    try {
      await btn.reply({
        content: `❌ Fehler beim Setzen der Rolle: ${String((e as Error)?.message ?? e).slice(0, 200)}`,
        ephemeral: true,
      });
    } catch { /* */ }
  }
}

/**
 * Postet (oder aktualisiert) das Menu im Channel und speichert messageId.
 */
export async function publishMenu(menu: MenuFull, channel: TextChannel): Promise<string> {
  const embed = buildMenuEmbed(menu);
  const rows = buildMenuRows(menu);

  if (menu.messageId) {
    try {
      const existing = await channel.messages.fetch(menu.messageId);
      await existing.edit({ embeds: [embed], components: rows });
      return existing.id;
    } catch {
      // Message wurde geloescht -> neu posten
    }
  }
  const sent = await channel.send({ embeds: [embed], components: rows, allowedMentions: { parse: [] } });
  await prisma.selfRoleMenu.update({ where: { id: menu.id }, data: { messageId: sent.id } });
  return sent.id;
}
