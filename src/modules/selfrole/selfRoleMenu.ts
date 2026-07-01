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
import type { AttachmentBuilder } from 'discord.js';
import prisma from '../../database/prisma';
import { Colors, Brand, vEmbed } from '../../utils/embedDesign';
import { logger, logAudit } from '../../utils/logger';
import { buildDiscordEmbed, buildEmbedMedia, type EmbedData } from '../embeds/embedBuilder';

/**
 * SelfRole-Modul: Admin baut Menus, User toggelt Rollen via Button/Select/Reaktion.
 * customId-Schema Button: selfrole_<menuId>_<optionId>
 * customId-Schema Select: selfrole_sel_<menuId>
 *
 * Phase 2 (Reaktions-Embeds, additiv/non-breaking):
 *  - componentType: BUTTON | SELECT | REACTION
 *  - assignMode:    GIVE | REMOVE | TOGGLE
 *  - maxRolesPerUser: Obergrenze gleichzeitiger Menu-Rollen (nur MULTI)
 *  - Option.buttonStyle: PRIMARY | SECONDARY | SUCCESS | DANGER
 *  - Option.isActive: deaktivierte Optionen werden nicht angeboten
 *  - embedId: optionales Nachrichtendesign aus dem Embed-Builder
 *
 * ProBot-Stil (additiv/non-breaking):
 *  - Option.roleIds: bis zu 5 Rollen pro Button (Fallback [roleId])
 *  - Option.label: frei waehlbarer Button-Name
 *  - Option.confirmMessage: personalisiertes Bestaetigungs-Embed beim Klick
 */

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

/** Rollen einer Option (1..5). Faellt auf [roleId] zurueck (Alt-Datensaetze). */
function optionRoleIds(opt: MenuOption): string[] {
  const ids = Array.isArray(opt.roleIds) && opt.roleIds.length > 0 ? opt.roleIds : (opt.roleId ? [opt.roleId] : []);
  return [...new Set(ids)];
}

/** Alle Rollen, die von irgendeiner Option dieses Menus vergeben werden. */
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
  // Eigenes Embed-Design (Embed-Builder) hat Vorrang, falls verknuepft.
  if (menu.embed) {
    return buildDiscordEmbed(menu.embed);
  }
  const lines = activeOptions(menu).map(o => {
    const e = o.emoji ? `${o.emoji} ` : '';
    const roles = optionRoleIds(o).map(id => `<@&${id}>`).join(' ');
    // Frei waehlbarer Button-Name (label) steht im Vordergrund; Rollen dahinter.
    const head = o.label ? `**${o.label}**` : roles;
    const tail = o.label ? ` → ${roles}` : '';
    return `${e}${head}${tail}${o.description ? `\n_${o.description}_` : ''}`;
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
 * Baut Embed + anzuhaengende Dateien fuer die Menu-Nachricht.
 * Ist ein Embed-Design (Embed-Builder) verknuepft, werden dessen lokal
 * hochgeladene Bilder als Discord-Attachments (`attachment://`) aufgeloest —
 * analog zum Embed-Builder-Send-Pfad, damit Bilder in Discord sichtbar sind.
 */
async function buildMenuMessage(
  menu: MenuFull,
): Promise<{ embed: EmbedBuilder; files: AttachmentBuilder[] }> {
  if (menu.embed) {
    const { files, resolved } = await buildEmbedMedia(menu.embed);
    return { embed: buildDiscordEmbed(menu.embed, resolved), files };
  }
  return { embed: buildMenuEmbed(menu), files: [] };
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
        .setValue(opt.id);
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
      .setCustomId(`selfrole_${menu.id}_${opt.id}`)
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
      const roleId = String(opt.roleId);
      const rawRoleIds = Array.isArray(opt.roleIds) ? (opt.roleIds as unknown[]).map(String).filter(Boolean) : [];
      const roleIds = rawRoleIds.length > 0 ? [...new Set(rawRoleIds)] : (roleId ? [roleId] : []);
      return {
        id: String(opt.id),
        roleId,
        roleIds,
        label: String(opt.label ?? ''),
        emoji: (opt.emoji as string | null) ?? null,
        description: (opt.description as string | null) ?? null,
        confirmMessage: (opt.confirmMessage as string | null) ?? null,
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
 * Wendet eine komplette Option (1..5 Rollen) auf ein Mitglied an und baut ein
 * personalisiertes Bestaetigungs-Embed (ProBot-Stil).
 *
 * Verhalten je assignMode:
 *  - GIVE   -> alle Rollen der Option hinzufuegen
 *  - REMOVE -> alle Rollen der Option entfernen
 *  - TOGGLE -> hat das Mitglied ALLE Rollen bereits, werden sie entfernt, sonst hinzugefuegt
 *
 * SINGLE-Menu: beim Hinzufuegen werden zuerst alle anderen Menu-Rollen entfernt.
 * maxRolesPerUser: begrenzt die Anzahl gleichzeitig gehaltener Menu-Rollen.
 */
async function applyOption(
  guild: Guild,
  member: GuildMember,
  menu: MenuFull,
  opt: MenuOption,
): Promise<EmbedBuilder> {
  const roleIds = optionRoleIds(opt).filter(id => id !== guild.id);
  const mode = assignMode(menu);
  const hasAll = roleIds.length > 0 && roleIds.every(id => member.roles.cache.has(id));
  const wantAdd = mode === 'GIVE' ? true : mode === 'REMOVE' ? false : !hasAll;

  const added: string[] = [];
  const removed: string[] = [];
  const errors: string[] = [];

  // SINGLE: andere Menu-Rollen zuerst entfernen (nur beim Hinzufuegen).
  if (wantAdd && menu.mode === 'SINGLE') {
    const others = allMenuRoleIds(menu).filter(id => !roleIds.includes(id) && member.roles.cache.has(id));
    for (const id of others) {
      const err = await safeSetRole(guild, member, menu, id, false).catch(() => 'err');
      if (!err && !removed.includes(id)) removed.push(id);
    }
  }

  // maxRolesPerUser: Obergrenze pruefen (nur beim Hinzufuegen, nur MULTI).
  if (wantAdd && menu.mode !== 'SINGLE' && menu.maxRolesPerUser && menu.maxRolesPerUser > 0) {
    const menuRoles = new Set(allMenuRoleIds(menu));
    const heldNow = [...member.roles.cache.keys()].filter(id => menuRoles.has(id));
    const toAdd = roleIds.filter(id => !member.roles.cache.has(id));
    if (heldNow.length + toAdd.length > menu.maxRolesPerUser) {
      return personalEmbed(menu, opt, member, [], [], [
        `Du kannst aus diesem Menü höchstens **${menu.maxRolesPerUser}** Rolle(n) gleichzeitig haben.`,
      ]);
    }
  }

  for (const id of roleIds) {
    const has = member.roles.cache.has(id);
    if (wantAdd && has) continue;
    if (!wantAdd && !has) continue;
    const err = await safeSetRole(guild, member, menu, id, wantAdd);
    if (err) errors.push(err);
    else if (wantAdd) added.push(id);
    else removed.push(id);
  }

  return personalEmbed(menu, opt, member, added, removed, errors);
}

/** Baut das personalisierte Bestaetigungs-Embed fuer eine Interaktion. */
function personalEmbed(
  menu: MenuFull,
  opt: MenuOption,
  member: GuildMember,
  added: string[],
  removed: string[],
  errors: string[],
): EmbedBuilder {
  const title = opt.label ? opt.label : menu.title;
  const parts: string[] = [];
  if (added.length) parts.push(`✅ Hinzugefügt: ${added.map(id => `<@&${id}>`).join(' ')}`);
  if (removed.length) parts.push(`➖ Entfernt: ${removed.map(id => `<@&${id}>`).join(' ')}`);
  if (!added.length && !removed.length && !errors.length) parts.push('ℹ️ Keine Änderungen.');
  if (errors.length) parts.push('', ...errors.map(e => (e.startsWith('❌') ? e : `❌ ${e}`)));

  // Personalisierte, pro-Button hinterlegte Nachricht (optional).
  const custom = opt.confirmMessage
    ? opt.confirmMessage.replace(/\{user\}/gi, `<@${member.id}>`).replace(/\{username\}/gi, member.displayName)
    : '';

  const desc = [custom, parts.join('\n')].filter(s => s && s.trim() !== '').join('\n\n');
  const color = errors.length ? Colors.Error : Colors.Success;
  return vEmbed(color)
    .setTitle(title.slice(0, 256))
    .setDescription(desc.slice(0, 4096) || 'ℹ️ Keine Änderungen.')
    .setFooter({ text: `${Brand.footerText} • Self-Role` });
}

/**
 * Wird aus events/interactionCreate.ts aufgerufen wenn customId mit "selfrole_" startet.
 */
export async function handleSelfRoleButton(btn: ButtonInteraction): Promise<void> {
  const parts = btn.customId.split('_');
  // selfrole_<menuId>_<optionId> (Select-IDs "selfrole_sel_..." ignorieren)
  if (parts.length < 3 || parts[1] === 'sel') return;
  const menuId = parts[1];
  const token = parts.slice(2).join('_');

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
  // Option per id finden (neu). Fallback: alte Buttons trugen die roleId.
  const opt = menu.options.find(o => o.id === token && o.isActive)
    ?? menu.options.find(o => o.roleId === token && o.isActive);
  if (!opt) {
    await btn.reply({ content: '❌ Diese Rollen-Option existiert nicht mehr.', ephemeral: true });
    return;
  }

  try {
    const embed = await applyOption(btn.guild as Guild, btn.member as GuildMember, menu, opt);
    await btn.reply({ embeds: [embed], ephemeral: true });
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
  const active = menu.options.filter(o => o.isActive);
  const selectedOptIds = new Set(sel.values.filter(v => active.some(o => o.id === v)));
  const mode = assignMode(menu);

  // Zielzustand je Rolle bestimmen (TOGGLE: auf Auswahl synchronisieren).
  const desiredAdd = new Set<string>();
  const desiredRemove = new Set<string>();
  for (const opt of active) {
    const wantSelected = selectedOptIds.has(opt.id);
    for (const roleId of optionRoleIds(opt)) {
      if (roleId === guild.id) continue;
      if (mode === 'GIVE') { if (wantSelected) desiredAdd.add(roleId); }
      else if (mode === 'REMOVE') { if (wantSelected) desiredRemove.add(roleId); }
      else { (wantSelected ? desiredAdd : desiredRemove).add(roleId); }
    }
  }

  // maxRolesPerUser: Obergrenze auf resultierende Menu-Rollen pruefen (nur MULTI).
  if (mode !== 'REMOVE' && menu.mode !== 'SINGLE' && menu.maxRolesPerUser) {
    const menuRoles = new Set(allMenuRoleIds(menu));
    const resulting = new Set([...member.roles.cache.keys()].filter(id => menuRoles.has(id)));
    for (const id of desiredRemove) resulting.delete(id);
    for (const id of desiredAdd) resulting.add(id);
    if (resulting.size > menu.maxRolesPerUser) {
      await sel.reply({ content: `❌ Du darfst höchstens ${menu.maxRolesPerUser} Rolle(n) gleichzeitig haben.`, ephemeral: true });
      return;
    }
  }

  const added: string[] = [];
  const removed: string[] = [];
  const errors: string[] = [];
  try {
    for (const roleId of desiredAdd) {
      if (member.roles.cache.has(roleId)) continue;
      const err = await safeSetRole(guild, member, menu, roleId, true);
      if (err) errors.push(err); else added.push(roleId);
    }
    for (const roleId of desiredRemove) {
      if (!member.roles.cache.has(roleId)) continue;
      const err = await safeSetRole(guild, member, menu, roleId, false);
      if (err) errors.push(err); else removed.push(roleId);
    }
    const parts: string[] = [];
    if (added.length) parts.push(`✅ Hinzugefügt: ${added.map(id => `<@&${id}>`).join(' ')}`);
    if (removed.length) parts.push(`➖ Entfernt: ${removed.map(id => `<@&${id}>`).join(' ')}`);
    if (errors.length) parts.push(...errors.map(e => (e.startsWith('❌') ? e : `❌ ${e}`)));
    await sel.reply({
      content: parts.length ? parts.join('\n') : 'ℹ️ Keine Änderungen.',
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

  const roleIds = optionRoleIds(opt).filter(id => id !== guild.id);
  try {
    if (doAdd && menu.mode === 'SINGLE') {
      const others = allMenuRoleIds(menu).filter(id => !roleIds.includes(id) && member.roles.cache.has(id));
      for (const id of others) {
        await safeSetRole(guild, member, menu, id, false).catch(() => { /* best effort */ });
      }
    } else if (doAdd && menu.maxRolesPerUser && menu.maxRolesPerUser > 0) {
      const menuRoles = new Set(allMenuRoleIds(menu));
      const held = [...member.roles.cache.keys()].filter(id => menuRoles.has(id));
      const toAdd = roleIds.filter(id => !member.roles.cache.has(id));
      if (held.length + toAdd.length > menu.maxRolesPerUser) {
        return true; // Obergrenze erreicht -> Reaktion ignorieren (stumm)
      }
    }
    for (const id of roleIds) {
      await safeSetRole(guild, member, menu, id, doAdd).catch(() => { /* best effort */ });
    }
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
  const { embed, files } = await buildMenuMessage(menu);
  const rows = buildMenuRows(menu);
  const content = menu.embed?.content ? String(menu.embed.content).slice(0, 2000) : undefined;

  let message: Message;
  if (menu.messageId) {
    try {
      const existing = await channel.messages.fetch(menu.messageId);
      // attachments: [] entfernt alte Anhaenge; `files` laedt aktuelle Uploads neu hoch.
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
      try { await message.react(opt.emoji); } catch { /* ungueltiges Emoji ignorieren */ }
    }
  }
  return message.id;
}
