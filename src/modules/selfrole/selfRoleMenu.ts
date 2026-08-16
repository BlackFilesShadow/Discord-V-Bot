import {
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  EmbedBuilder,
  Guild,
  GuildMember,
  Message,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  StringSelectMenuOptionBuilder,
  TextChannel,
  type MessageActionRowComponentBuilder,
} from 'discord.js';
import type { AttachmentBuilder, Client } from 'discord.js';
import prisma from '../../database/prisma';
import { Colors, Brand, vEmbed } from '../../utils/embedDesign';
import { logger, logAudit } from '../../utils/logger';
import { buildDiscordEmbed, buildEmbedMedia, type EmbedData } from '../embeds/embedBuilder';
import { getOptionAssignModeMap, type OptionAssignMode } from './optionAssignModeStore';

interface MenuOption {
  id: string;
  roleId: string;
  roleIds: string[];
  label: string;
  emoji: string | null;
  description: string | null;
  confirmMessage: string | null;
  position: number;
  buttonStyle: string;
  isActive: boolean;
  assignMode: OptionAssignMode | null;
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
  componentType: string;
  assignMode: string;
  maxRolesPerUser: number | null;
  archived: boolean;
  embedId: string | null;
  embed: EmbedData | null;
  options: MenuOption[];
}

type ComponentType = 'BUTTON' | 'SELECT' | 'REACTION';
type AssignMode = 'GIVE' | 'REMOVE' | 'TOGGLE';

interface RoleOutcome {
  added: string[];
  removed: string[];
  alreadyHad: string[];
  notHad: string[];
  warnings: string[];
  errors: string[];
}

function componentType(menu: MenuFull): ComponentType {
  return menu.componentType === 'SELECT' || menu.componentType === 'REACTION'
    ? menu.componentType
    : 'BUTTON';
}

function menuAssignMode(menu: MenuFull): AssignMode {
  return menu.assignMode === 'GIVE' || menu.assignMode === 'REMOVE' ? menu.assignMode : 'TOGGLE';
}

function optionAssignMode(menu: MenuFull, opt: MenuOption): AssignMode {
  return opt.assignMode ?? menuAssignMode(menu);
}

function activeOptions(menu: MenuFull): MenuOption[] {
  return menu.options.filter(o => o.isActive);
}

function optionRoleIds(opt: MenuOption): string[] {
  const ids = Array.isArray(opt.roleIds) && opt.roleIds.length > 0 ? opt.roleIds : (opt.roleId ? [opt.roleId] : []);
  return [...new Set(ids)];
}

function allMenuRoleIds(menu: MenuFull): string[] {
  return [...new Set(menu.options.flatMap(o => optionRoleIds(o)))];
}

function buttonStyleOf(style: string): ButtonStyle {
  switch (style) {
    case 'PRIMARY': return ButtonStyle.Primary;
    case 'SUCCESS': return ButtonStyle.Success;
    case 'DANGER': return ButtonStyle.Danger;
    default: return ButtonStyle.Secondary;
  }
}

export function buildMenuEmbed(menu: MenuFull): EmbedBuilder {
  if (menu.embed) return buildDiscordEmbed(menu.embed);
  const lines = activeOptions(menu).map(o => {
    const e = o.emoji ? `${o.emoji} ` : '';
    const roles = optionRoleIds(o).map(id => `<@&${id}>`).join(' ');
    const head = o.label ? `**${o.label}**` : roles;
    const tail = o.label ? ` → ${roles}` : '';
    return `${e}${head}${tail}${o.description ? `\n_${o.description}_` : ''}`;
  });
  const ct = componentType(menu);
  const hint = ct === 'REACTION'
    ? 'Reagiere mit dem passenden Emoji, um die Rollen-Option auszuführen.'
    : ct === 'SELECT'
      ? 'Wähle eine Rollen-Option im Dropdown-Menü aus.'
      : 'Klicke auf einen Button, um die Rollen-Option auszuführen.';
  const desc = [
    Brand.divider,
    menu.description ?? '',
    lines.join('\n') || '_Keine Optionen._',
    Brand.divider,
    `Modus: \`${menu.mode}\` ${menu.mode === 'SINGLE' ? '(nur eine Rolle gleichzeitig)' : '(mehrere Rollen erlaubt)'}`,
    hint,
  ].filter(s => s !== '').join('\n');
  return vEmbed(Colors.Primary)
    .setTitle(`🎭 ${menu.title}`)
    .setDescription(desc)
    .setFooter({ text: `${Brand.footerText} • Self-Role-Menu` });
}

async function buildMenuMessage(menu: MenuFull): Promise<{ embed: EmbedBuilder; files: AttachmentBuilder[] }> {
  if (menu.embed) {
    const { files, resolved } = await buildEmbedMedia(menu.embed);
    return { embed: buildDiscordEmbed(menu.embed, resolved), files };
  }
  return { embed: buildMenuEmbed(menu), files: [] };
}

export function buildMenuRows(menu: MenuFull): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  const opts = activeOptions(menu).sort((a, b) => a.position - b.position);
  const ct = componentType(menu);
  if (ct === 'REACTION') return [];

  if (ct === 'SELECT') {
    if (opts.length === 0) return [];
    const select = new StringSelectMenuBuilder()
      .setCustomId(`selfrole_sel_${menu.id}`)
      .setPlaceholder('Rollen auswählen…')
      .setMinValues(1)
      .setMaxValues(1);
    for (const opt of opts.slice(0, 25)) {
      const so = new StringSelectMenuOptionBuilder()
        .setLabel(opt.label.slice(0, 100))
        .setValue(opt.id);
      if (opt.description) so.setDescription(opt.description.slice(0, 100));
      if (opt.emoji) { try { so.setEmoji(opt.emoji); } catch { /* invalid */ } }
      select.addOptions(so);
    }
    return [new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(select)];
  }

  const rows: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];
  let current = new ActionRowBuilder<MessageActionRowComponentBuilder>();
  let count = 0;
  for (const opt of opts) {
    if (count > 0 && count % 5 === 0) {
      rows.push(current);
      current = new ActionRowBuilder<MessageActionRowComponentBuilder>();
    }
    if (rows.length >= 5) break;
    const btn = new ButtonBuilder()
      .setCustomId(`selfrole_${menu.id}_${opt.id}`)
      .setLabel(opt.label.slice(0, 80))
      .setStyle(buttonStyleOf(opt.buttonStyle));
    if (opt.emoji) { try { btn.setEmoji(opt.emoji); } catch { /* invalid */ } }
    current.addComponents(btn);
    count++;
  }
  if (current.components.length > 0 && rows.length < 5) rows.push(current);
  return rows;
}

export async function getMenuFull(menuId: string): Promise<MenuFull | null> {
  const m = await prisma.selfRoleMenu.findUnique({
    where: { id: menuId },
    include: { options: { orderBy: { position: 'asc' } }, embed: true },
  });
  if (!m) return null;
  const raw = m as unknown as { options?: Array<{ id?: string }> };
  const modes = await getOptionAssignModeMap((raw.options ?? []).map(o => String(o.id ?? '')).filter(Boolean));
  return normalizeMenu(m, modes);
}

function normalizeMenu(m: unknown, modes: Map<string, OptionAssignMode> = new Map()): MenuFull {
  const row = m as Record<string, unknown> & { options?: unknown[]; embed?: EmbedData | null };
  const opts = Array.isArray(row.options) ? row.options : [];
  return {
    id: String(row.id),
    guildId: String(row.guildId),
    channelId: String(row.channelId),
    messageId: (row.messageId as string | null) ?? null,
    title: String(row.title ?? ''),
    description: (row.description as string | null) ?? null,
    mode: String(row.mode ?? 'MULTI'),
    isActive: row.isActive !== false,
    componentType: String(row.componentType ?? 'BUTTON'),
    assignMode: String(row.assignMode ?? 'TOGGLE'),
    maxRolesPerUser: (row.maxRolesPerUser as number | null) ?? null,
    archived: row.archived === true,
    embedId: (row.embedId as string | null) ?? null,
    embed: (row.embed as EmbedData | null) ?? null,
    options: opts.map((o) => {
      const opt = o as Record<string, unknown>;
      const id = String(opt.id);
      const roleId = String(opt.roleId);
      const rawRoleIds = Array.isArray(opt.roleIds) ? (opt.roleIds as unknown[]).map(String).filter(Boolean) : [];
      const roleIds = rawRoleIds.length > 0 ? [...new Set(rawRoleIds)] : (roleId ? [roleId] : []);
      return {
        id,
        roleId,
        roleIds,
        label: String(opt.label ?? ''),
        emoji: (opt.emoji as string | null) ?? null,
        description: (opt.description as string | null) ?? null,
        confirmMessage: (opt.confirmMessage as string | null) ?? null,
        position: typeof opt.position === 'number' ? opt.position : 0,
        buttonStyle: String(opt.buttonStyle ?? 'SECONDARY'),
        isActive: opt.isActive !== false,
        assignMode: modes.get(id) ?? null,
      };
    }),
  };
}

async function safeSetRole(
  guild: Guild,
  member: GuildMember,
  menu: MenuFull,
  roleId: string,
  add: boolean,
): Promise<string | null> {
  const me = guild.members.me;
  if (!me) return '❌ Bot-Mitglied nicht verfügbar.';
  if (roleId === guild.id) return '❌ @everyone kann nicht vergeben werden.';
  const role = await guild.roles.fetch(roleId).catch(() => null);
  if (!role) return '❌ Rolle existiert nicht mehr im Server.';
  if (role.managed) return '❌ Diese Rolle wird von einer Integration verwaltet und kann nicht vergeben werden.';
  if (me.roles.highest.position <= role.position) return '❌ Ich kann diese Rolle nicht vergeben (Bot-Rolle muss höher stehen).';
  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) return '❌ Mir fehlt die Berechtigung „Rollen verwalten".';

  const has = member.roles.cache.has(roleId);
  if (add && !has) {
    await member.roles.add(roleId, `SelfRole-Menu ${menu.id}: hinzugefügt`);
    logAudit('SELFROLE_ADDED', 'USER', { menuId: menu.id, roleId, userId: member.id });
  } else if (!add && has) {
    await member.roles.remove(roleId, `SelfRole-Menu ${menu.id}: entfernt`);
    logAudit('SELFROLE_REMOVED', 'USER', { menuId: menu.id, roleId, userId: member.id });
  }
  return null;
}

function emptyOutcome(): RoleOutcome {
  return { added: [], removed: [], alreadyHad: [], notHad: [], warnings: [], errors: [] };
}

async function applyOptionAction(
  guild: Guild,
  member: GuildMember,
  menu: MenuFull,
  opt: MenuOption,
  wantAdd: boolean,
): Promise<RoleOutcome> {
  const out = emptyOutcome();
  const roleIds = optionRoleIds(opt).filter(id => id !== guild.id);
  for (const id of roleIds) {
    if (!guild.roles.cache.has(id)) await guild.roles.fetch(id).catch(() => null);
  }

  if (wantAdd && menu.mode === 'SINGLE') {
    const others = allMenuRoleIds(menu).filter(id => !roleIds.includes(id) && member.roles.cache.has(id));
    for (const id of others) {
      const err = await safeSetRole(guild, member, menu, id, false).catch(() => '❌ Rolle konnte nicht entfernt werden.');
      if (err) out.errors.push(err); else out.removed.push(id);
    }
  }

  if (wantAdd && menu.mode !== 'SINGLE' && menu.maxRolesPerUser && menu.maxRolesPerUser > 0) {
    const menuRoles = new Set(allMenuRoleIds(menu));
    const heldNow = [...member.roles.cache.keys()].filter(id => menuRoles.has(id));
    const toAdd = roleIds.filter(id => !member.roles.cache.has(id));
    if (heldNow.length + toAdd.length > menu.maxRolesPerUser) {
      out.warnings.push(`Du kannst aus diesem Menü höchstens **${menu.maxRolesPerUser}** Rolle(n) gleichzeitig haben.`);
      return out;
    }
  }

  for (const id of roleIds) {
    const has = member.roles.cache.has(id);
    if (wantAdd && has) { out.alreadyHad.push(id); continue; }
    if (!wantAdd && !has) { out.notHad.push(id); continue; }
    const err = await safeSetRole(guild, member, menu, id, wantAdd);
    if (err) out.errors.push(err);
    else if (wantAdd) out.added.push(id);
    else out.removed.push(id);
  }
  return out;
}

async function applyOption(guild: Guild, member: GuildMember, menu: MenuFull, opt: MenuOption): Promise<RoleOutcome> {
  const roleIds = optionRoleIds(opt).filter(id => id !== guild.id);
  const mode = optionAssignMode(menu, opt);
  const hasAll = roleIds.length > 0 && roleIds.every(id => member.roles.cache.has(id));
  const wantAdd = mode === 'GIVE' ? true : mode === 'REMOVE' ? false : !hasAll;
  return applyOptionAction(guild, member, menu, opt, wantAdd);
}

function roleLabelList(guild: Guild, ids: string[]): string {
  return ids.map(id => `„${guild.roles.cache.get(id)?.name ?? id}“`).join(', ');
}

function personalEmbed(
  guild: Guild,
  menu: MenuFull,
  opt: MenuOption,
  member: GuildMember,
  out: RoleOutcome,
): EmbedBuilder {
  const title = opt.label ? opt.label : menu.title;
  const parts: string[] = [];
  if (out.added.length) {
    const word = out.added.length > 1 ? 'Rollen' : 'Rolle';
    parts.push(`✅ Du hast die ${word} ${roleLabelList(guild, out.added)} erhalten.`);
  }
  if (out.removed.length) {
    const word = out.removed.length > 1 ? 'Die Rollen' : 'Die Rolle';
    parts.push(`✅ ${word} ${roleLabelList(guild, out.removed)} wurde dir entfernt.`);
  }
  if (out.alreadyHad.length) {
    const word = out.alreadyHad.length > 1 ? 'Rollen' : 'Rolle';
    parts.push(`❕ Du besitzt die ${word} ${roleLabelList(guild, out.alreadyHad)} bereits.`);
  }
  if (out.notHad.length) {
    const word = out.notHad.length > 1 ? 'Rollen' : 'Rolle';
    parts.push(`❕ Du besitzt die ${word} ${roleLabelList(guild, out.notHad)} nicht.`);
  }
  if (out.warnings.length) parts.push(...out.warnings.map(w => `⚠️ ${w}`));
  if (out.errors.length) parts.push(...out.errors.map(e => (e.startsWith('❌') ? e : `❌ ${e}`)));
  if (parts.length === 0) parts.push('❕ Keine Änderungen.');

  const custom = opt.confirmMessage
    ? opt.confirmMessage.replace(/\{user\}/gi, `<@${member.id}>`).replace(/\{username\}/gi, member.displayName)
    : '';
  const desc = [custom, parts.join('\n')].filter(s => s && s.trim() !== '').join('\n\n');
  const color = out.errors.length
    ? Colors.Error
    : out.warnings.length
      ? Colors.Warning
      : (out.added.length || out.removed.length)
        ? Colors.Success
        : Colors.Info;
  return vEmbed(color)
    .setTitle(title.slice(0, 256))
    .setDescription(desc.slice(0, 4096) || '❕ Keine Änderungen.')
    .setFooter({ text: `${Brand.footerText} • Self-Role` });
}

function errorEmbed(title: string, message: string): EmbedBuilder {
  return vEmbed(Colors.Error).setTitle(title).setDescription(`❌ ${message}`).setFooter({ text: `${Brand.footerText} • Self-Role` });
}

export async function handleSelfRoleButton(btn: ButtonInteraction): Promise<void> {
  const parts = btn.customId.split('_');
  if (parts.length < 3 || parts[1] === 'sel') return;
  const menuId = parts[1];
  const token = parts.slice(2).join('_');
  if (!btn.guild || !btn.member) {
    await btn.reply({ embeds: [errorEmbed('Self-Role', 'Nur in Servern verfügbar.')], flags: MessageFlags.Ephemeral });
    return;
  }

  let menu: MenuFull | null;
  try { menu = await getMenuFull(menuId); }
  catch (e) {
    logger.warn('SelfRole: Menu-Load fehlgeschlagen', e as Error);
    await btn.reply({ embeds: [errorEmbed('Self-Role', 'Menü konnte nicht geladen werden.')], flags: MessageFlags.Ephemeral });
    return;
  }
  if (!menu || !menu.isActive || menu.archived) {
    await btn.reply({ embeds: [errorEmbed('Self-Role', 'Menü ist inaktiv oder nicht gefunden.')], flags: MessageFlags.Ephemeral });
    return;
  }
  const opt = menu.options.find(o => o.id === token && o.isActive)
    ?? menu.options.find(o => o.roleId === token && o.isActive);
  if (!opt) {
    await btn.reply({ embeds: [errorEmbed('Self-Role', 'Diese Rollen-Option existiert nicht mehr.')], flags: MessageFlags.Ephemeral });
    return;
  }

  try {
    const out = await applyOption(btn.guild as Guild, btn.member as GuildMember, menu, opt);
    await btn.reply({ embeds: [personalEmbed(btn.guild as Guild, menu, opt, btn.member as GuildMember, out)], flags: MessageFlags.Ephemeral });
  } catch (e) {
    logger.error('SelfRole-Button fehlgeschlagen', e as Error);
    try {
      await btn.reply({ embeds: [errorEmbed('Rollenaktion fehlgeschlagen', String((e as Error)?.message ?? e).slice(0, 200))], flags: MessageFlags.Ephemeral });
    } catch { /* already answered */ }
  }
}

export async function handleSelfRoleSelect(sel: StringSelectMenuInteraction): Promise<void> {
  const menuId = sel.customId.slice('selfrole_sel_'.length);
  if (!menuId) return;
  if (!sel.guild || !sel.member) {
    await sel.reply({ embeds: [errorEmbed('Self-Role', 'Nur in Servern verfügbar.')], flags: MessageFlags.Ephemeral });
    return;
  }

  let menu: MenuFull | null;
  try { menu = await getMenuFull(menuId); }
  catch (e) {
    logger.warn('SelfRole: Menu-Load (Select) fehlgeschlagen', e as Error);
    await sel.reply({ embeds: [errorEmbed('Self-Role', 'Menü konnte nicht geladen werden.')], flags: MessageFlags.Ephemeral });
    return;
  }
  if (!menu || !menu.isActive || menu.archived) {
    await sel.reply({ embeds: [errorEmbed('Self-Role', 'Menü ist inaktiv oder nicht gefunden.')], flags: MessageFlags.Ephemeral });
    return;
  }
  const opt = menu.options.find(o => o.isActive && o.id === sel.values[0]);
  if (!opt) {
    await sel.reply({ embeds: [errorEmbed('Self-Role', 'Diese Rollen-Option existiert nicht mehr.')], flags: MessageFlags.Ephemeral });
    return;
  }

  await sel.deferUpdate();
  try {
    const guild = sel.guild as Guild;
    const member = sel.member as GuildMember;
    const out = await applyOption(guild, member, menu, opt);
    await sel.editReply({ components: buildMenuRows(menu) });
    await sel.followUp({ embeds: [personalEmbed(guild, menu, opt, member, out)], flags: MessageFlags.Ephemeral });
  } catch (e) {
    logger.error('SelfRole-Select fehlgeschlagen', e as Error);
    try {
      await sel.editReply({ components: buildMenuRows(menu) });
      await sel.followUp({ embeds: [errorEmbed('Rollenaktion fehlgeschlagen', String((e as Error)?.message ?? e).slice(0, 200))], flags: MessageFlags.Ephemeral });
    } catch { /* ignore */ }
  }
}

function matchEmoji(stored: string | null, reactedName: string | null, reactedId: string | null): boolean {
  if (!stored) return false;
  const custom = stored.match(/^<a?:\w+:(\d+)>$/);
  if (custom) return reactedId === custom[1];
  return stored === reactedName;
}

async function sendReactionFeedback(guild: Guild, menu: MenuFull, member: GuildMember, embed: EmbedBuilder): Promise<void> {
  try {
    await member.send({ embeds: [embed] });
    return;
  } catch { /* DMs disabled */ }

  const channel = guild.channels.cache.get(menu.channelId)
    ?? await guild.channels.fetch(menu.channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || channel.isDMBased()) return;
  try {
    const notice = await (channel as TextChannel).send({
      content: `<@${member.id}>`,
      embeds: [embed],
      allowedMentions: { users: [member.id] },
    });
    setTimeout(() => { void notice.delete().catch(() => {}); }, 8000);
  } catch { /* best effort */ }
}

export async function handleSelfRoleReaction(
  guild: Guild,
  messageId: string,
  reactedName: string | null,
  reactedId: string | null,
  member: GuildMember,
  added: boolean,
): Promise<boolean> {
  const row = await prisma.selfRoleMenu.findFirst({
    where: { guildId: guild.id, messageId, componentType: 'REACTION', isActive: true, archived: false },
    select: { id: true },
  });
  if (!row) return false;
  const menu = await getMenuFull(row.id);
  if (!menu || !menu.isActive || menu.archived) return false;
  const opt = menu.options.find(o => o.isActive && matchEmoji(o.emoji, reactedName, reactedId));
  if (!opt) return false;

  const mode = optionAssignMode(menu, opt);
  if (!added && mode !== 'TOGGLE') return true;
  const wantAdd = mode === 'TOGGLE' ? added : mode === 'GIVE';

  try {
    const out = await applyOptionAction(guild, member, menu, opt, wantAdd);
    await sendReactionFeedback(guild, menu, member, personalEmbed(guild, menu, opt, member, out));
  } catch (e) {
    logger.error('SelfRole-Reaktion fehlgeschlagen', e as Error);
    await sendReactionFeedback(guild, menu, member, errorEmbed('Rollenaktion fehlgeschlagen', String((e as Error)?.message ?? e).slice(0, 200)));
  }
  return true;
}

export async function publishMenu(menu: MenuFull, channel: TextChannel): Promise<string> {
  if (menu.embedId) return attachMenuToEmbed(menu, channel);

  const { embed, files } = await buildMenuMessage(menu);
  const rows = buildMenuRows(menu);
  const content = menu.embed?.content ? String(menu.embed.content).slice(0, 2000) : undefined;
  let message: Message;
  if (menu.messageId) {
    try {
      const existing = await channel.messages.fetch(menu.messageId);
      await existing.edit({ content: content ?? null, embeds: [embed], components: rows, files, attachments: [] });
      message = existing;
    } catch {
      message = await channel.send({ content, embeds: [embed], components: rows, files, allowedMentions: { parse: [] } });
      await prisma.selfRoleMenu.update({ where: { id: menu.id }, data: { messageId: message.id } });
    }
  } else {
    message = await channel.send({ content, embeds: [embed], components: rows, files, allowedMentions: { parse: [] } });
    await prisma.selfRoleMenu.update({ where: { id: menu.id }, data: { messageId: message.id } });
  }

  if (componentType(menu) === 'REACTION') {
    for (const opt of activeOptions(menu)) {
      if (!opt.emoji) continue;
      try { await message.react(opt.emoji); } catch { /* invalid */ }
    }
  }
  return message.id;
}

export async function detachMenuComponents(
  client: Client,
  channelId: string,
  messageId: string,
  isReaction: boolean,
): Promise<void> {
  const channel = client.channels.cache.get(channelId)
    ?? await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || channel.isDMBased()) return;
  const msg = await (channel as TextChannel).messages.fetch(messageId).catch(() => null);
  if (!msg) return;
  await msg.edit({ components: [] }).catch(() => {});
  if (isReaction) await msg.reactions.removeAll().catch(() => {});
}

async function attachMenuToEmbed(menu: MenuFull, channel: TextChannel): Promise<string> {
  const emb = menu.embedId
    ? await prisma.dashboardEmbed.findUnique({ where: { id: menu.embedId }, select: { channelId: true, messageId: true } })
    : null;
  if (!emb?.channelId || !emb.messageId) throw new Error('Die verknüpfte Einbettung wurde noch nicht in einen Channel gesendet.');

  const target = channel.id === emb.channelId
    ? channel
    : await channel.guild.channels.fetch(emb.channelId).catch(() => null);
  if (!target || !target.isTextBased() || target.isDMBased()) throw new Error('Der Channel der verknüpften Einbettung ist nicht verfügbar.');
  const message = await (target as TextChannel).messages.fetch(emb.messageId);
  await message.edit({ components: buildMenuRows(menu) });

  if (menu.messageId !== emb.messageId || menu.channelId !== emb.channelId) {
    await prisma.selfRoleMenu.update({ where: { id: menu.id }, data: { channelId: emb.channelId, messageId: emb.messageId } });
  }
  if (componentType(menu) === 'REACTION') {
    for (const opt of activeOptions(menu)) {
      if (!opt.emoji) continue;
      try { await message.react(opt.emoji); } catch { /* invalid */ }
    }
  }
  return message.id;
}
