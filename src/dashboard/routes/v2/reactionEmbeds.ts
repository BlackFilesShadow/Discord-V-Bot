/**
 * Reaktions-Embeds Routen — Self-Role-Menus mit Buttons/Select/Reaktionen pro Guild.
 * Dashboard-only: es existieren KEINE Slash-/Prefix-Commands fuer dieses Feature.
 *
 * Baut additiv auf dem bestehenden SelfRoleMenu/SelfRoleOption-Modell auf
 * (Phase 2). Optional kann ein DashboardEmbed (Embed-Builder) als Nachrichten-
 * design verknuepft werden.
 *
 *   GET    /                    Menus der Guild auflisten
 *   GET    /:id                 Einzelnes Menu (inkl. Optionen)
 *   POST   /                    Menu anlegen
 *   PUT    /:id                 Menu aktualisieren
 *   DELETE /:id                 Menu loeschen (+ ggf. gepostete Nachricht best-effort)
 *   POST   /:id/options         Option hinzufuegen
 *   PUT    /:id/options/:optId  Option aktualisieren
 *   DELETE /:id/options/:optId  Option entfernen
 *   POST   /:id/reorder         Optionen neu sortieren
 *   POST   /:id/send            In Ziel-Channel posten (oder editieren)
 *   POST   /:id/sync            Bereits gepostete Nachricht aktualisieren
 *   POST   /:id/archive         Menu archivieren/reaktivieren
 *
 * Strikte guildId-Scope-Pruefung in jeder Operation (jede Prisma-Query traegt guildId).
 * Rollen-Schutz: nie @everyone, keine managed-Rollen, Bot-Hierarchie + ManageRoles.
 */

import { Router } from 'express';
import { PermissionFlagsBits, TextChannel } from 'discord.js';
import { requireGuildPermission } from '../../middleware/auth';
import prisma from '../../../database/prisma';
import { tryGetDashboardClient } from '../../clientRegistry';
import { validateBotChannelAccess } from '../../../utils/discordChannel';
import { logAuditDb, logger } from '../../../utils/logger';
import { emitGuildEvent } from '../../socket/emitter';
import { getMenuFull, publishMenu } from '../../../modules/selfrole/selfRoleMenu';

export const reactionEmbedsRouter = Router({ mergeParams: true });

const SNOWFLAKE_RE = /^\d{17,20}$/;
const COMPONENT_TYPES = new Set(['BUTTON', 'SELECT', 'REACTION']);
const ASSIGN_MODES = new Set(['GIVE', 'REMOVE', 'TOGGLE']);
const MODES = new Set(['MULTI', 'SINGLE']);
const BUTTON_STYLES = new Set(['PRIMARY', 'SECONDARY', 'SUCCESS', 'DANGER']);

// ── Serialisierung ──────────────────────────────────────────────────────────
interface MenuRow {
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
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  options?: OptionRow[];
}
interface OptionRow {
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

function optionToApi(o: OptionRow) {
  const roleIds = Array.isArray(o.roleIds) && o.roleIds.length > 0 ? o.roleIds : (o.roleId ? [o.roleId] : []);
  return {
    id: o.id,
    roleId: o.roleId,
    roleIds,
    label: o.label,
    emoji: o.emoji,
    description: o.description,
    confirmMessage: o.confirmMessage ?? null,
    position: o.position,
    buttonStyle: o.buttonStyle,
    isActive: o.isActive,
  };
}

function menuToApi(m: MenuRow) {
  return {
    id: m.id,
    channelId: m.channelId,
    messageId: m.messageId,
    isPosted: m.messageId != null,
    title: m.title,
    description: m.description,
    mode: m.mode,
    isActive: m.isActive,
    componentType: m.componentType,
    assignMode: m.assignMode,
    maxRolesPerUser: m.maxRolesPerUser,
    archived: m.archived,
    embedId: m.embedId,
    createdBy: m.createdBy,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    options: (m.options ?? []).map(optionToApi),
  };
}

// ── Body-Parsing ─────────────────────────────────────────────────────────────
function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}
function optStr(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length ? t.slice(0, max) : null;
}

interface MenuInput {
  title: string;
  description: string | null;
  mode: string;
  componentType: string;
  assignMode: string;
  maxRolesPerUser: number | null;
  embedId: string;
}

function validateMenuBody(body: unknown): { ok: true; data: MenuInput } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const title = str(b.title, 120);
  if (title.length < 1) return { ok: false, error: 'title 1..120 Zeichen.' };
  const description = optStr(b.description, 2000);
  const mode = MODES.has(String(b.mode)) ? String(b.mode) : 'MULTI';
  const componentType = COMPONENT_TYPES.has(String(b.componentType)) ? String(b.componentType) : 'BUTTON';
  const assignMode = ASSIGN_MODES.has(String(b.assignMode)) ? String(b.assignMode) : 'TOGGLE';
  let maxRolesPerUser: number | null = null;
  if (b.maxRolesPerUser != null && b.maxRolesPerUser !== '') {
    const n = Number(b.maxRolesPerUser);
    if (!Number.isInteger(n) || n < 1 || n > 25) return { ok: false, error: 'maxRolesPerUser muss 1..25 sein.' };
    maxRolesPerUser = n;
  }
  // Reaktions-Embeds haengen an einer bestehenden Einbettung -> embedId ist Pflicht.
  const embedId = optStr(b.embedId, 64);
  if (!embedId) return { ok: false, error: 'Bitte eine Einbettung auswählen.' };
  return { ok: true, data: { title, description, mode, componentType, assignMode, maxRolesPerUser, embedId } };
}

/** Prueft, ob eine Rolle sicher als Self-Role verwendet werden kann.
 *  Erwartet, dass Rollen-Cache + Bot-Member zuvor frisch geladen wurden
 *  (siehe refreshGuildRoleState / parseOptionRoles). */
async function validateRole(guildId: string, roleId: string): Promise<string | null> {
  if (!SNOWFLAKE_RE.test(roleId)) return 'Ungültige roleId.';
  if (roleId === guildId) return '@everyone kann nicht als Reaktionsrolle verwendet werden.';
  const client = tryGetDashboardClient();
  const guild = client?.guilds.cache.get(guildId);
  if (!guild) return null; // Ohne Client keine Live-Pruefung (Persistenz erlaubt).
  const role = guild.roles.cache.get(roleId) ?? await guild.roles.fetch(roleId).catch(() => null);
  if (!role) return 'Rolle nicht gefunden.';
  if (role.managed) return 'Von Integrationen verwaltete Rollen sind nicht erlaubt.';
  const me = guild.members.me;
  if (!me) return null; // Bot-Member nicht ermittelbar -> Persistenz erlauben, Laufzeit prueft erneut.
  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return 'Dem Bot fehlt die Berechtigung „Rollen verwalten".';
  }
  // comparePositionTo nutzt die (frisch geladenen) Positionen aus guild.roles.cache.
  if (me.roles.highest.comparePositionTo(role) <= 0) {
    logger.warn(
      `[ReactionRole] Hierarchie-Block: Bot-Top-Rolle "${me.roles.highest.name}" (pos ${me.roles.highest.position}) ` +
      `steht nicht über Ziel-Rolle "${role.name}" (pos ${role.position}) in Guild ${guildId}.`,
    );
    return `Die Bot-Rolle „${me.roles.highest.name}" steht nicht über der Rolle „${role.name}". ` +
      'Ziehe die Bot-Rolle in den Server-Rolleneinstellungen über die zu vergebende Rolle.';
  }
  return null;
}

/** Laedt Rollen-Positionen + Bot-Member erzwungen neu, damit me.roles.highest
 *  korrekt ist (Cache kann nach dem Umsortieren von Rollen veraltet sein). */
async function refreshGuildRoleState(guildId: string): Promise<void> {
  const guild = tryGetDashboardClient()?.guilds.cache.get(guildId);
  if (!guild) return;
  await Promise.all([
    guild.roles.fetch(undefined, { force: true }).catch(() => null),
    guild.members.fetchMe({ force: true }).catch(() => null),
  ]);
}

/**
 * Loest die verknuepfte, bereits GESENDETE Einbettung auf. Reaktions-Buttons
 * haengen ausschliesslich an einer existierenden Embed-Nachricht -> die
 * Einbettung muss channelId + messageId besitzen (also gepostet sein).
 */
async function resolveLinkedEmbed(
  embedId: string,
  guildId: string,
): Promise<{ ok: true; channelId: string; messageId: string } | { ok: false; error: string }> {
  const emb = await prisma.dashboardEmbed.findFirst({
    where: { id: embedId, guildId },
    select: { channelId: true, messageId: true },
  });
  if (!emb) return { ok: false, error: 'Verknüpfte Einbettung gehört nicht zu dieser Guild.' };
  if (!emb.channelId || !emb.messageId) {
    return { ok: false, error: 'Die gewählte Einbettung wurde noch nicht gesendet. Bitte sende sie zuerst im Embed-Builder.' };
  }
  return { ok: true, channelId: emb.channelId, messageId: emb.messageId };
}

/**
 * Liest & validiert bis zu 5 Rollen fuer eine Option (ProBot-Stil).
 * Akzeptiert `roleIds: string[]` (bevorzugt) oder Fallback `roleId: string`.
 * Prueft jede Rolle einzeln (Snowflake, @everyone, managed, Hierarchie, ManageRoles).
 */
async function parseOptionRoles(
  guildId: string,
  b: Record<string, unknown>,
): Promise<{ ok: true; roleIds: string[] } | { ok: false; error: string }> {
  const raw = Array.isArray(b.roleIds)
    ? b.roleIds
    : (typeof b.roleId === 'string' && b.roleId ? [b.roleId] : []);
  const ids = [...new Set(raw.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map(x => x.trim()))];
  if (ids.length < 1) return { ok: false, error: 'Mindestens eine Rolle ist erforderlich.' };
  if (ids.length > 5) return { ok: false, error: 'Maximal 5 Rollen pro Button.' };
  // Rollen-Positionen + Bot-Member einmalig frisch laden: nach dem Umsortieren
  // von Rollen kann der Cache veraltete Positionen enthalten, wodurch die
  // Hierarchie-Pruefung faelschlich fehlschlaegt.
  await refreshGuildRoleState(guildId);
  for (const id of ids) {
    const err = await validateRole(guildId, id);
    if (err) return { ok: false, error: err };
  }
  return { ok: true, roleIds: ids };
}

// ===========================================================================
//  MENU-CRUD
// ===========================================================================

reactionEmbedsRouter.get('/', requireGuildPermission('reactionroles.view'), async (req, res) => {
  const scope = req.guildScope!;
  const menus = await prisma.selfRoleMenu.findMany({
    where: { guildId: scope.guildId },
    orderBy: { createdAt: 'desc' },
    include: { options: { orderBy: { position: 'asc' } } },
  });
  res.json({ menus: (menus as unknown as MenuRow[]).map(menuToApi) });
});

reactionEmbedsRouter.get('/:id', requireGuildPermission('reactionroles.view'), async (req, res) => {
  const scope = req.guildScope!;
  const menu = await prisma.selfRoleMenu.findFirst({
    where: { id: req.params.id, guildId: scope.guildId },
    include: { options: { orderBy: { position: 'asc' } } },
  });
  if (!menu) { res.status(404).json({ error: 'Menü nicht gefunden.' }); return; }
  res.json(menuToApi(menu as unknown as MenuRow));
});

reactionEmbedsRouter.post('/', requireGuildPermission('reactionroles.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const v = validateMenuBody(req.body);
  if (!v.ok) { res.status(400).json({ error: v.error }); return; }
  const d = v.data;
  const linked = await resolveLinkedEmbed(d.embedId, scope.guildId);
  if (!linked.ok) { res.status(400).json({ error: linked.error }); return; }
  const menu = await prisma.selfRoleMenu.create({
    data: {
      guildId: scope.guildId,
      channelId: linked.channelId,
      messageId: linked.messageId,
      title: d.title,
      description: d.description,
      mode: d.mode,
      componentType: d.componentType,
      assignMode: d.assignMode,
      maxRolesPerUser: d.maxRolesPerUser,
      embedId: d.embedId,
      createdBy: scope.actorDiscordId,
    },
  });
  logAuditDb('REACTION_EMBED_CREATED', 'ROLE', {
    actorUserId: req.auth!.userId, guildId: scope.guildId,
    details: { menuId: menu.id, componentType: d.componentType },
  });
  emitGuildEvent(scope.guildId, { type: 'reactionEmbed.changed', payload: { guildId: scope.guildId, menuId: menu.id } });
  res.status(201).json(menuToApi(menu as unknown as MenuRow));
});

reactionEmbedsRouter.put('/:id', requireGuildPermission('reactionroles.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const existing = await prisma.selfRoleMenu.findFirst({ where: { id: req.params.id, guildId: scope.guildId } });
  if (!existing) { res.status(404).json({ error: 'Menü nicht gefunden.' }); return; }
  const v = validateMenuBody(req.body);
  if (!v.ok) { res.status(400).json({ error: v.error }); return; }
  const d = v.data;
  const linked = await resolveLinkedEmbed(d.embedId, scope.guildId);
  if (!linked.ok) { res.status(400).json({ error: linked.error }); return; }
  await prisma.selfRoleMenu.updateMany({
    where: { id: existing.id, guildId: scope.guildId },
    data: {
      channelId: linked.channelId,
      messageId: linked.messageId,
      title: d.title,
      description: d.description,
      mode: d.mode,
      componentType: d.componentType,
      assignMode: d.assignMode,
      maxRolesPerUser: d.maxRolesPerUser,
      embedId: d.embedId,
    },
  });
  const updated = await prisma.selfRoleMenu.findFirst({
    where: { id: existing.id, guildId: scope.guildId },
    include: { options: { orderBy: { position: 'asc' } } },
  });
  logAuditDb('REACTION_EMBED_UPDATED', 'ROLE', {
    actorUserId: req.auth!.userId, guildId: scope.guildId, details: { menuId: existing.id },
  });
  emitGuildEvent(scope.guildId, { type: 'reactionEmbed.changed', payload: { guildId: scope.guildId, menuId: existing.id } });
  res.json(menuToApi(updated as unknown as MenuRow));
});

reactionEmbedsRouter.delete('/:id', requireGuildPermission('reactionroles.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const existing = await prisma.selfRoleMenu.findFirst({ where: { id: req.params.id, guildId: scope.guildId } });
  if (!existing) { res.status(404).json({ error: 'Menü nicht gefunden.' }); return; }

  let messageDeleted = false;
  if (existing.messageId) {
    const client = tryGetDashboardClient();
    const channel = client?.channels.cache.get(existing.channelId)
      ?? await client?.channels.fetch(existing.channelId).catch(() => null);
    if (channel && channel.isTextBased() && !channel.isDMBased()) {
      await channel.messages.delete(existing.messageId).then(() => { messageDeleted = true; }).catch(() => {});
    }
  }
  await prisma.selfRoleMenu.delete({ where: { id: existing.id } });
  logAuditDb('REACTION_EMBED_DELETED', 'ROLE', {
    actorUserId: req.auth!.userId, guildId: scope.guildId, details: { menuId: existing.id, messageDeleted },
  });
  emitGuildEvent(scope.guildId, { type: 'reactionEmbed.changed', payload: { guildId: scope.guildId, menuId: existing.id } });
  res.json({ ok: true, messageDeleted });
});

// ===========================================================================
//  OPTIONEN
// ===========================================================================

reactionEmbedsRouter.post('/:id/options', requireGuildPermission('reactionroles.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const menu = await prisma.selfRoleMenu.findFirst({ where: { id: req.params.id, guildId: scope.guildId } });
  if (!menu) { res.status(404).json({ error: 'Menü nicht gefunden.' }); return; }

  const b = (req.body ?? {}) as Record<string, unknown>;
  const label = str(b.label, 80);
  const emoji = optStr(b.emoji, 64);
  const description = optStr(b.description, 100);
  const confirmMessage = optStr(b.confirmMessage, 500);
  const buttonStyle = BUTTON_STYLES.has(String(b.buttonStyle)) ? String(b.buttonStyle) : 'SECONDARY';
  if (label.length < 1) { res.status(400).json({ error: 'label 1..80 Zeichen.' }); return; }
  const roles = await parseOptionRoles(scope.guildId, b);
  if (!roles.ok) { res.status(400).json({ error: roles.error }); return; }

  const count = await prisma.selfRoleOption.count({ where: { menuId: menu.id } });
  if (count >= 25) { res.status(400).json({ error: 'Ein Menü unterstützt maximal 25 Optionen.' }); return; }
  try {
    const opt = await prisma.selfRoleOption.create({
      data: {
        menuId: menu.id,
        roleId: roles.roleIds[0],
        roleIds: roles.roleIds,
        label, emoji, description, confirmMessage, buttonStyle, position: count,
      },
    });
    logAuditDb('REACTION_EMBED_OPTION_ADDED', 'ROLE', {
      actorUserId: req.auth!.userId, guildId: scope.guildId, details: { menuId: menu.id, roleIds: roles.roleIds },
    });
    emitGuildEvent(scope.guildId, { type: 'reactionEmbed.changed', payload: { guildId: scope.guildId, menuId: menu.id } });
    res.status(201).json(optionToApi(opt as unknown as OptionRow));
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') { res.status(409).json({ error: 'Diese Rolle ist bereits im Menü.' }); return; }
    throw e;
  }
});

reactionEmbedsRouter.put('/:id/options/:optId', requireGuildPermission('reactionroles.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const menu = await prisma.selfRoleMenu.findFirst({ where: { id: req.params.id, guildId: scope.guildId } });
  if (!menu) { res.status(404).json({ error: 'Menü nicht gefunden.' }); return; }
  const opt = await prisma.selfRoleOption.findFirst({ where: { id: req.params.optId, menuId: menu.id } });
  if (!opt) { res.status(404).json({ error: 'Option nicht gefunden.' }); return; }

  const b = (req.body ?? {}) as Record<string, unknown>;
  const label = str(b.label, 80);
  if (label.length < 1) { res.status(400).json({ error: 'label 1..80 Zeichen.' }); return; }
  const emoji = optStr(b.emoji, 64);
  const description = optStr(b.description, 100);
  const confirmMessage = optStr(b.confirmMessage, 500);
  const buttonStyle = BUTTON_STYLES.has(String(b.buttonStyle)) ? String(b.buttonStyle) : opt.buttonStyle;
  const isActive = typeof b.isActive === 'boolean' ? b.isActive : opt.isActive;

  // Rollen duerfen geaendert werden (1..5). Wenn nicht mitgeschickt, bestehende beibehalten.
  const data: Record<string, unknown> = { label, emoji, description, confirmMessage, buttonStyle, isActive };
  if (b.roleIds !== undefined || b.roleId !== undefined) {
    const roles = await parseOptionRoles(menu.guildId, b);
    if (!roles.ok) { res.status(400).json({ error: roles.error }); return; }
    data.roleIds = roles.roleIds;
    data.roleId = roles.roleIds[0];
  }

  try {
    const updated = await prisma.selfRoleOption.update({ where: { id: opt.id }, data });
    logAuditDb('REACTION_EMBED_OPTION_UPDATED', 'ROLE', {
      actorUserId: req.auth!.userId, guildId: scope.guildId, details: { menuId: menu.id, optionId: opt.id },
    });
    emitGuildEvent(scope.guildId, { type: 'reactionEmbed.changed', payload: { guildId: scope.guildId, menuId: menu.id } });
    res.json(optionToApi(updated as unknown as OptionRow));
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') { res.status(409).json({ error: 'Diese Rolle ist bereits im Menü.' }); return; }
    throw e;
  }
});

reactionEmbedsRouter.delete('/:id/options/:optId', requireGuildPermission('reactionroles.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const menu = await prisma.selfRoleMenu.findFirst({ where: { id: req.params.id, guildId: scope.guildId } });
  if (!menu) { res.status(404).json({ error: 'Menü nicht gefunden.' }); return; }
  await prisma.selfRoleOption.deleteMany({ where: { id: req.params.optId, menuId: menu.id } });
  logAuditDb('REACTION_EMBED_OPTION_REMOVED', 'ROLE', {
    actorUserId: req.auth!.userId, guildId: scope.guildId, details: { menuId: menu.id, optionId: req.params.optId },
  });
  emitGuildEvent(scope.guildId, { type: 'reactionEmbed.changed', payload: { guildId: scope.guildId, menuId: menu.id } });
  res.json({ ok: true });
});

reactionEmbedsRouter.post('/:id/reorder', requireGuildPermission('reactionroles.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const menu = await prisma.selfRoleMenu.findFirst({ where: { id: req.params.id, guildId: scope.guildId } });
  if (!menu) { res.status(404).json({ error: 'Menü nicht gefunden.' }); return; }
  const order = Array.isArray((req.body as { order?: unknown })?.order) ? (req.body as { order: unknown[] }).order : null;
  if (!order) { res.status(400).json({ error: 'order[] erforderlich.' }); return; }
  const ids = order.map(String);
  const existing = await prisma.selfRoleOption.findMany({ where: { menuId: menu.id }, select: { id: true } });
  const existingIds = new Set(existing.map(o => o.id));
  if (ids.length !== existing.length || !ids.every(id => existingIds.has(id))) {
    res.status(400).json({ error: 'order[] muss exakt alle Options-IDs enthalten.' }); return;
  }
  await prisma.$transaction(ids.map((id, idx) =>
    prisma.selfRoleOption.update({ where: { id }, data: { position: idx } }),
  ));
  emitGuildEvent(scope.guildId, { type: 'reactionEmbed.changed', payload: { guildId: scope.guildId, menuId: menu.id } });
  res.json({ ok: true });
});

// ===========================================================================
//  POST / SYNC / ARCHIVE
// ===========================================================================

async function publishToChannel(guildId: string, menuId: string): Promise<{ error?: string; status?: number; messageId?: string }> {
  const full = await getMenuFull(menuId);
  if (!full) return { error: 'Menü nicht gefunden.', status: 404 };
  const activeOpts = full.options.filter(o => o.isActive);
  if (activeOpts.length === 0) return { error: 'Menü hat keine aktiven Optionen.', status: 400 };
  if (full.componentType === 'REACTION' && activeOpts.some(o => !o.emoji)) {
    return { error: 'Bei Reaktions-Menüs benötigt jede aktive Option ein Emoji.', status: 400 };
  }
  const client = tryGetDashboardClient();
  if (!client) return { error: 'Bot ist derzeit nicht verbunden.', status: 503 };
  const access = await validateBotChannelAccess(client, guildId, full.channelId, [
    PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks,
  ]);
  if (!access.ok) return { error: access.reason, status: 400 };
  const guild = client.guilds.cache.get(guildId);
  const channel = guild?.channels.cache.get(full.channelId);
  if (!channel || !channel.isTextBased()) return { error: 'Ziel-Channel nicht gefunden oder kein Text-Channel.', status: 400 };
  const messageId = await publishMenu(full, channel as TextChannel);
  return { messageId };
}

reactionEmbedsRouter.post('/:id/send', requireGuildPermission('reactionroles.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const menu = await prisma.selfRoleMenu.findFirst({ where: { id: req.params.id, guildId: scope.guildId } });
  if (!menu) { res.status(404).json({ error: 'Menü nicht gefunden.' }); return; }
  const r = await publishToChannel(scope.guildId, menu.id);
  if (r.error) { res.status(r.status ?? 400).json({ error: r.error }); return; }
  logAuditDb('REACTION_EMBED_SENT', 'ROLE', {
    actorUserId: req.auth!.userId, guildId: scope.guildId, details: { menuId: menu.id, messageId: r.messageId },
  });
  emitGuildEvent(scope.guildId, { type: 'reactionEmbed.changed', payload: { guildId: scope.guildId, menuId: menu.id } });
  res.json({ ok: true, messageId: r.messageId });
});

reactionEmbedsRouter.post('/:id/sync', requireGuildPermission('reactionroles.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const menu = await prisma.selfRoleMenu.findFirst({ where: { id: req.params.id, guildId: scope.guildId } });
  if (!menu) { res.status(404).json({ error: 'Menü nicht gefunden.' }); return; }
  if (!menu.messageId) { res.status(400).json({ error: 'Menü wurde noch nicht gesendet.' }); return; }
  const r = await publishToChannel(scope.guildId, menu.id);
  if (r.error) { res.status(r.status ?? 400).json({ error: r.error }); return; }
  logAuditDb('REACTION_EMBED_SYNCED', 'ROLE', {
    actorUserId: req.auth!.userId, guildId: scope.guildId, details: { menuId: menu.id, messageId: r.messageId },
  });
  res.json({ ok: true, messageId: r.messageId });
});

reactionEmbedsRouter.post('/:id/archive', requireGuildPermission('reactionroles.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const menu = await prisma.selfRoleMenu.findFirst({ where: { id: req.params.id, guildId: scope.guildId } });
  if (!menu) { res.status(404).json({ error: 'Menü nicht gefunden.' }); return; }
  const archived = typeof (req.body as { archived?: unknown })?.archived === 'boolean'
    ? (req.body as { archived: boolean }).archived
    : !menu.archived;
  const updated = await prisma.selfRoleMenu.update({
    where: { id: menu.id },
    data: { archived, isActive: archived ? false : menu.isActive },
  });
  logAuditDb('REACTION_EMBED_ARCHIVED', 'ROLE', {
    actorUserId: req.auth!.userId, guildId: scope.guildId, details: { menuId: menu.id, archived },
  });
  emitGuildEvent(scope.guildId, { type: 'reactionEmbed.changed', payload: { guildId: scope.guildId, menuId: menu.id } });
  res.json({ id: updated.id, archived: updated.archived, isActive: updated.isActive });
});
