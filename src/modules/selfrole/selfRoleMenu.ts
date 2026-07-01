import {
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
import prisma from '../../database/prisma';
import { Colors, Brand, vEmbed } from '../../utils/embedDesign';
import { logger, logAudit } from '../../utils/logger';
import { buildDiscordEmbed, type EmbedData } from '../embeds/embedBuilder';

/**
 * SelfRole-Modul: Admin baut Menus, User toggelt Rollen via Button/Select/Reaktion.
 * customId-Schema Button: selfrole_<menuId>_<roleId>
 * customId-Schema Select: selfrole_sel_<menuId>
 *
 * Phase 2 (Reaktions-Embeds, additiv/non-breaking):
 *  - componentType: BUTTON | SELECT | REACTION
 *  - assignMode:    GIVE | REMOVE | TOGGLE
 *  - maxRolesPerUser: Obergrenze gleichzeitiger Menu-Rollen (nur MULTI)
 *  - Option.buttonStyle: PRIMARY | SECONDARY | SUCCESS | DANGER
 *  - Option.isActive: deaktivierte Optionen werden nicht angeboten
 *  - embedId: optionales Nachrichtendesign aus dem Embed-Builder
 */

interface MenuOption {
  id: string;
  roleId: string;
  label: string;
  emoji: string | null;
  description: string | null;
  position: number;
  buttonStyle: string;
  isActive: boolean;
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

function componentType(menu: MenuFull): ComponentType {
  return menu.componentType === 'SELECT' || menu.componentType === 'REACTION'
    ? menu.componentType
    : 'BUTTON';
}

function assignMode(menu: MenuFull): AssignMode {
  return menu.assignMode === 'GIVE' || menu.assignMode === 'REMOVE' ? menu.assignMode : 'TOGGLE';
}

/** Nur aktive Optionen — deaktivierte werden nicht mehr angeboten. */
function activeOptions(menu: MenuFull): MenuOption[] {
  return menu.options.filter(o => o.isActive);
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
  // Eigenes Embed-Design (Embed-Builder) hat Vorrang, falls verknuepft.
  if (menu.embed) {
    return buildDiscordEmbed(menu.embed);
  }
  const lines = activeOptions(menu).map(o => {
    const e = o.emoji ? `${o.emoji} ` : '';
    return `${e}<@&${o.roleId}>${o.description ? ` — ${o.description}` : ''}`;
  });
  const ct = componentType(menu);
  const hint = ct === 'REACTION'
    ? 'Reagiere mit dem passenden Emoji, um die Rolle zu erhalten.'
    : ct === 'SELECT'
      ? 'Wähle deine Rollen im Dropdown-Menü aus.'
      : 'Klicke auf einen Button, um die Rolle zu erhalten.';
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

/**
 * Baut die Nachrichten-Komponenten passend zum componentType.
 * BUTTON  -> bis zu 25 Buttons in 5 Rows (Farbe je Option).
 * SELECT  -> ein StringSelectMenu (min/max je nach Modus).
 * REACTION-> keine Komponenten (Emojis werden nach dem Post als Reaktion gesetzt).
 */
export function buildMenuRows(menu: MenuFull): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  const opts = activeOptions(menu).sort((a, b) => a.position - b.position);
  const ct = componentType(menu);

  if (ct === 'REACTION') return [];

  if (ct === 'SELECT') {
    const select = new StringSelectMenuBuilder()
      .setCustomId(`selfrole_sel_${menu.id}`)
      .setPlaceholder('Rollen auswählen…')
      .setMinValues(0)
      .setMaxValues(Math.max(1, menu.mode === 'SINGLE' ? 1 : opts.length));
    for (const opt of opts.slice(0, 25)) {
      const so = new StringSelectMenuOptionBuilder()
        .setLabel(opt.label.slice(0, 100))
        .setValue(opt.roleId);
      if (opt.description) so.setDescription(opt.description.slice(0, 100));
      if (opt.emoji) { try { so.setEmoji(opt.emoji); } catch { /* ungueltig */ } }
      select.addOptions(so);
    }
    if (opts.length === 0) return [];
    return [new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(select)];
  }

  // BUTTON
  const rows: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];
  let current = new ActionRowBuilder<MessageActionRowComponentBuilder>();
  let count = 0;
  for (const opt of opts) {
    if (count > 0 && count % 5 === 0) {
      rows.push(current);
      current = new ActionRowBuilder<MessageActionRowComponentBuilder>();
    }
    if (rows.length >= 5) break; // max 5 Rows = 25 Buttons
    const btn = new ButtonBuilder()
      .setCustomId(`selfrole_${menu.id}_${opt.roleId}`)
      .setLabel(opt.label.slice(0, 80))
      .setStyle(buttonStyleOf(opt.buttonStyle));
    if (opt.emoji) {
      try { btn.setEmoji(opt.emoji); } catch { /* ungueltig, ignorieren */ }
    }
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
  return normalizeMenu(m);
}

/** Prisma-Row -> MenuFull (defensiv, mit Defaults fuer Alt-Datensaetze). */
function normalizeMenu(m: unknown): MenuFull {
  const row = m as Record<string, unknown> & {
    options?: unknown[];
    embed?: EmbedData | null;
  };
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
      return {
        id: String(opt.id),
        roleId: String(opt.roleId),
        label: String(opt.label ?? ''),
        emoji: (opt.emoji as string | null) ?? null,
        description: (opt.description as string | null) ?? null,
        position: typeof opt.position === 'number' ? opt.position : 0,
        buttonStyle: String(opt.buttonStyle ?? 'SECONDARY'),
        isActive: opt.isActive !== false,
      };
    }),
  };
}

/**
 * Setzt eine einzelne Rolle sicher (mit allen Schutzpruefungen).
 * Rueckgabe: Fehlertext (String) oder null bei Erfolg/No-op.
 */
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
  if (me.roles.highest.position <= role.position) {
    return '❌ Ich kann diese Rolle nicht vergeben (Bot-Rolle muss höher stehen).';
  }
  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return '❌ Mir fehlt die Berechtigung „Rollen verwalten".';
  }
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

/**
 * Ermittelt fuer ein einzelnes Menu-Item (Button/Reaktion) das gewuenschte
 * Zielverhalten anhand assignMode + Modus + Obergrenze und wendet es an.
 * Rueckgabe: nutzerlesbare Statusmeldung.
 */
async function applyRoleChange(
  guild: Guild,
  member: GuildMember,
  menu: MenuFull,
  roleId: string,
): Promise<string> {
  const has = member.roles.cache.has(roleId);
  const mode = assignMode(menu);
  const wantAdd = mode === 'GIVE' ? true : mode === 'REMOVE' ? false : !has;

  if (wantAdd && has) return `ℹ️ Du hast <@&${roleId}> bereits.`;
  if (!wantAdd && !has) return `ℹ️ Du hast <@&${roleId}> nicht.`;

  if (wantAdd && menu.mode === 'SINGLE') {
    // SINGLE: andere Menu-Rollen zuerst entfernen.
    for (const id of menu.options.map(o => o.roleId).filter(id => id !== roleId && member.roles.cache.has(id))) {
      await safeSetRole(guild, member, menu, id, false).catch(() => { /* best effort */ });
    }
  } else if (wantAdd && menu.maxRolesPerUser && menu.maxRolesPerUser > 0) {
    const menuRoleIds = new Set(menu.options.map(o => o.roleId));
    const held = [...member.roles.cache.keys()].filter(id => menuRoleIds.has(id));
    if (held.length >= menu.maxRolesPerUser) {
      return `❌ Du kannst aus diesem Menü höchstens ${menu.maxRolesPerUser} Rolle(n) gleichzeitig haben.`;
    }
  }

  const err = await safeSetRole(guild, member, menu, roleId, wantAdd);
  if (err) return err;
  return wantAdd ? `✅ Rolle <@&${roleId}> hinzugefügt.` : `✅ Rolle <@&${roleId}> entfernt.`;
}

/**
 * Wird aus events/interactionCreate.ts aufgerufen wenn customId mit "selfrole_" startet.
 */
export async function handleSelfRoleButton(btn: ButtonInteraction): Promise<void> {
  const parts = btn.customId.split('_');
  // selfrole_<menuId>_<roleId> (Select-IDs "selfrole_sel_..." ignorieren)
  if (parts.length < 3 || parts[1] === 'sel') return;
  const menuId = parts[1];
  const roleId = parts.slice(2).join('_');

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
  if (!menu || !menu.isActive || menu.archived) {
    await btn.reply({ content: '❌ Menu ist inaktiv oder nicht gefunden.', ephemeral: true });
    return;
  }
  const opt = menu.options.find(o => o.roleId === roleId && o.isActive);
  if (!opt) {
    await btn.reply({ content: '❌ Diese Rollen-Option existiert nicht mehr.', ephemeral: true });
    return;
  }

  try {
    const msg = await applyRoleChange(btn.guild as Guild, btn.member as GuildMember, menu, roleId);
    await btn.reply({ content: msg, ephemeral: true });
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
 * Wird aus events/interactionCreate.ts aufgerufen wenn customId mit
 * "selfrole_sel_" startet (StringSelectMenu). Die Auswahl beschreibt den
 * gewuenschten Zielzustand (bei TOGGLE); GIVE/REMOVE nur additiv/subtraktiv.
 */
export async function handleSelfRoleSelect(sel: StringSelectMenuInteraction): Promise<void> {
  const menuId = sel.customId.slice('selfrole_sel_'.length);
  if (!menuId) return;
  if (!sel.guild || !sel.member) {
    await sel.reply({ content: '❌ Nur in Servern verfügbar.', ephemeral: true });
    return;
  }

  let menu: MenuFull | null;
  try {
    menu = await getMenuFull(menuId);
  } catch (e) {
    logger.warn('SelfRole: Menu-Load (Select) fehlgeschlagen', e as Error);
    await sel.reply({ content: '❌ Menu konnte nicht geladen werden.', ephemeral: true });
    return;
  }
  if (!menu || !menu.isActive || menu.archived) {
    await sel.reply({ content: '❌ Menu ist inaktiv oder nicht gefunden.', ephemeral: true });
    return;
  }

  const guild = sel.guild as Guild;
  const member = sel.member as GuildMember;
  const activeRoleIds = menu.options.filter(o => o.isActive).map(o => o.roleId);
  const selected = new Set(sel.values.filter(v => activeRoleIds.includes(v)));
  const mode = assignMode(menu);

  if (mode !== 'REMOVE' && menu.mode !== 'SINGLE' && menu.maxRolesPerUser && selected.size > menu.maxRolesPerUser) {
    await sel.reply({ content: `❌ Du darfst höchstens ${menu.maxRolesPerUser} Rolle(n) auswählen.`, ephemeral: true });
    return;
  }

  const changes: string[] = [];
  try {
    for (const roleId of activeRoleIds) {
      const wantSelected = selected.has(roleId);
      const has = member.roles.cache.has(roleId);
      let add: boolean;
      if (mode === 'GIVE') { if (!wantSelected) continue; add = true; }
      else if (mode === 'REMOVE') { if (!wantSelected) continue; add = false; }
      else { add = wantSelected; } // TOGGLE: auf Auswahl synchronisieren
      if (add === has) continue;
      const err = await safeSetRole(guild, member, menu, roleId, add);
      changes.push(err ?? `${add ? '➕' : '➖'} <@&${roleId}>`);
    }
    await sel.reply({
      content: changes.length ? changes.join('\n') : 'ℹ️ Keine Änderungen.',
      ephemeral: true,
    });
  } catch (e) {
    logger.error('SelfRole-Select fehlgeschlagen', e as Error);
    try {
      await sel.reply({
        content: `❌ Fehler beim Setzen der Rollen: ${String((e as Error)?.message ?? e).slice(0, 200)}`,
        ephemeral: true,
      });
    } catch { /* */ }
  }
}

/** Vergleicht ein gespeichertes Emoji (Unicode oder `<:name:id>`) mit einer Reaktion. */
function matchEmoji(stored: string | null, reactedName: string | null, reactedId: string | null): boolean {
  if (!stored) return false;
  const custom = stored.match(/^<a?:\w+:(\d+)>$/);
  if (custom) return reactedId === custom[1];
  return stored === reactedName;
}

/**
 * REACTION-Menus: wird aus messageReactionAdd/Remove aufgerufen.
 * Rueckgabe true, wenn eine SelfRole-Reaktion verarbeitet wurde (Event kann stoppen).
 */
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
    include: { options: { orderBy: { position: 'asc' } }, embed: true },
  });
  if (!row) return false;
  const menu = normalizeMenu(row);
  const opt = menu.options.find(o => o.isActive && matchEmoji(o.emoji, reactedName, reactedId));
  if (!opt) return false;

  const mode = assignMode(menu);
  let doAdd: boolean;
  if (mode === 'TOGGLE') doAdd = added;
  else if (mode === 'GIVE') { if (!added) return true; doAdd = true; }
  else { if (!added) return true; doAdd = false; } // REMOVE

  try {
    if (doAdd && menu.mode === 'SINGLE') {
      for (const id of menu.options.map(o => o.roleId).filter(id => id !== opt.roleId && member.roles.cache.has(id))) {
        await safeSetRole(guild, member, menu, id, false).catch(() => { /* best effort */ });
      }
    } else if (doAdd && menu.maxRolesPerUser && menu.maxRolesPerUser > 0) {
      const menuRoleIds = new Set(menu.options.map(o => o.roleId));
      const held = [...member.roles.cache.keys()].filter(id => menuRoleIds.has(id));
      if (held.length >= menu.maxRolesPerUser && !member.roles.cache.has(opt.roleId)) {
        return true; // Obergrenze erreicht -> Reaktion ignorieren (stumm)
      }
    }
    await safeSetRole(guild, member, menu, opt.roleId, doAdd);
  } catch (e) {
    logger.error('SelfRole-Reaktion fehlgeschlagen', e as Error);
  }
  return true;
}

/**
 * Postet (oder aktualisiert) das Menu im Channel und speichert messageId.
 * Bei REACTION-Menus werden die Emojis anschliessend als Reaktion gesetzt.
 */
export async function publishMenu(menu: MenuFull, channel: TextChannel): Promise<string> {
  const embed = buildMenuEmbed(menu);
  const rows = buildMenuRows(menu);
  const content = menu.embed?.content ? String(menu.embed.content).slice(0, 2000) : undefined;

  let message: Message;
  if (menu.messageId) {
    try {
      const existing = await channel.messages.fetch(menu.messageId);
      await existing.edit({ content: content ?? null, embeds: [embed], components: rows });
      message = existing;
    } catch {
      message = await channel.send({ content, embeds: [embed], components: rows, allowedMentions: { parse: [] } });
      await prisma.selfRoleMenu.update({ where: { id: menu.id }, data: { messageId: message.id } });
    }
  } else {
    message = await channel.send({ content, embeds: [embed], components: rows, allowedMentions: { parse: [] } });
    await prisma.selfRoleMenu.update({ where: { id: menu.id }, data: { messageId: message.id } });
  }

  if (componentType(menu) === 'REACTION') {
    for (const opt of activeOptions(menu)) {
      if (!opt.emoji) continue;
      try { await message.react(opt.emoji); } catch { /* ungueltiges Emoji ignorieren */ }
    }
  }
  return message.id;
}
