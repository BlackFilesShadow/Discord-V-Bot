/**
 * Guild-Level-Ticket-Templates (Phase 6).
 *
 * GET    /                 -> alle Templates der Guild (max 5)
 * POST   /                 -> neuen Template anlegen (slot 1..5, eindeutig)
 * PUT    /:id              -> Patch
 * DELETE /:id              -> Loeschen (Cascade auf Instances)
 * POST   /:id/post         -> Embed im konfigurierten Channel posten/aktualisieren
 * GET    /instances        -> offene Tickets der Guild
 *
 * Mutations: requireGuildOwner (Tickets sind Owner-only-Konfiguration).
 */
import { Router } from 'express';
import type { TicketTemplate } from '@prisma/client';
import { requireGuildOwner, requireGuildPermission } from '../../middleware/auth';
import prisma from '../../../database/prisma';
import { logAuditDb } from '../../../utils/logger';
import { emitGuildEvent } from '../../socket/emitter';
import { tryGetDashboardClient } from '../../clientRegistry';
import { postTemplateEmbed, unpostTemplateEmbed, purgeTemplateInstances } from '../../../modules/tickets/ticketSystem';
import { validateBotChannelAccess } from '../../../utils/discordChannel';
import { PermissionFlagsBits } from 'discord.js';

export const ticketsRouter = Router({ mergeParams: true });

const HEX_RE = /^#?[0-9a-fA-F]{6}$/;
const SNOWFLAKE_RE = /^\d{17,20}$/;
const MAX_WELCOME_MESSAGES = 5;
const WELCOME_MSG_MAX = 2000;

interface TemplateBody {
  slot?: number;
  label?: string;
  buttonLabel?: string | null;
  welcomeText?: string;
  welcomeMessages?: unknown;
  embedTitle?: string;
  embedColor?: string;
  postChannelId?: string;
  categoryId?: string | null;
  staffRoleId?: string | null;
  managerRoleIds?: unknown;
  mentionRoleIds?: unknown;
  transcriptChannelId?: string;
  archiveChannelId?: string | null;
  isActive?: boolean;
}

function validateBody(b: TemplateBody, partial: boolean): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
  const data: Record<string, unknown> = {};
  if (b.slot !== undefined) {
    if (!Number.isInteger(b.slot) || b.slot < 1 || b.slot > 5) return { ok: false, error: 'slot muss 1..5 sein.' };
    data.slot = b.slot;
  } else if (!partial) return { ok: false, error: 'slot fehlt.' };

  if (b.label !== undefined) {
    if (typeof b.label !== 'string' || b.label.trim().length < 1 || b.label.length > 80) return { ok: false, error: 'label 1..80 Zeichen.' };
    data.label = b.label.trim();
  } else if (!partial) return { ok: false, error: 'label fehlt.' };

  // Optionaler separater Button-Text. null = explizit ruecksetzen, leer-string = ruecksetzen.
  if (b.buttonLabel !== undefined) {
    if (b.buttonLabel === null || (typeof b.buttonLabel === 'string' && b.buttonLabel.trim().length === 0)) {
      data.buttonLabel = null;
    } else if (typeof b.buttonLabel !== 'string' || b.buttonLabel.length > 80) {
      return { ok: false, error: 'buttonLabel max 80 Zeichen.' };
    } else {
      data.buttonLabel = b.buttonLabel.trim();
    }
  }

  // welcomeMessages (Array, 1..5, je 1..2000 Zeichen) — Single source of truth.
  // welcomeText wird als Legacy-Feld immer aus messages[0] gespiegelt.
  if (b.welcomeMessages !== undefined) {
    if (!Array.isArray(b.welcomeMessages)) return { ok: false, error: 'welcomeMessages muss ein Array sein.' };
    if (b.welcomeMessages.length < 1 || b.welcomeMessages.length > MAX_WELCOME_MESSAGES) {
      return { ok: false, error: `welcomeMessages: 1..${MAX_WELCOME_MESSAGES} Eintraege.` };
    }
    const cleaned: string[] = [];
    for (const m of b.welcomeMessages) {
      if (typeof m !== 'string') return { ok: false, error: 'welcomeMessages-Eintraege muessen Strings sein.' };
      const t = m.trim();
      if (t.length < 1 || t.length > WELCOME_MSG_MAX) return { ok: false, error: `Jede Welcome-Message: 1..${WELCOME_MSG_MAX} Zeichen.` };
      cleaned.push(t);
    }
    data.welcomeMessages = cleaned;
    data.welcomeText = cleaned[0]; // Legacy-Spiegel
  } else if (b.welcomeText !== undefined) {
    // Backward-Compat: alter Client schickt nur welcomeText
    if (typeof b.welcomeText !== 'string' || b.welcomeText.length < 1 || b.welcomeText.length > 4000) return { ok: false, error: 'welcomeText 1..4000 Zeichen.' };
    data.welcomeText = b.welcomeText;
    data.welcomeMessages = [b.welcomeText.trim().slice(0, WELCOME_MSG_MAX)];
  } else if (!partial) return { ok: false, error: 'welcomeMessages fehlt.' };

  if (b.embedTitle !== undefined) {
    if (typeof b.embedTitle !== 'string' || b.embedTitle.trim().length < 1 || b.embedTitle.length > 200) return { ok: false, error: 'embedTitle 1..200 Zeichen.' };
    data.embedTitle = b.embedTitle.trim();
  } else if (!partial) return { ok: false, error: 'embedTitle fehlt.' };

  if (b.embedColor !== undefined) {
    if (typeof b.embedColor !== 'string' || !HEX_RE.test(b.embedColor)) return { ok: false, error: 'embedColor muss Hex sein (z.B. #dc2626).' };
    data.embedColor = b.embedColor.startsWith('#') ? b.embedColor : `#${b.embedColor}`;
  }

  if (b.postChannelId !== undefined) {
    if (typeof b.postChannelId !== 'string' || !SNOWFLAKE_RE.test(b.postChannelId)) return { ok: false, error: 'postChannelId ungueltig.' };
    data.postChannelId = b.postChannelId;
  } else if (!partial) return { ok: false, error: 'postChannelId fehlt.' };

  if (b.transcriptChannelId !== undefined) {
    if (typeof b.transcriptChannelId !== 'string' || !SNOWFLAKE_RE.test(b.transcriptChannelId)) return { ok: false, error: 'transcriptChannelId ungueltig.' };
    data.transcriptChannelId = b.transcriptChannelId;
  } else if (!partial) return { ok: false, error: 'transcriptChannelId fehlt.' };

  if (b.categoryId !== undefined) {
    if (b.categoryId === null) data.categoryId = null;
    else if (typeof b.categoryId === 'string' && SNOWFLAKE_RE.test(b.categoryId)) data.categoryId = b.categoryId;
    else return { ok: false, error: 'categoryId ungueltig.' };
  }

  if (b.staffRoleId !== undefined) {
    if (b.staffRoleId === null) data.staffRoleId = null;
    else if (typeof b.staffRoleId === 'string' && SNOWFLAKE_RE.test(b.staffRoleId)) data.staffRoleId = b.staffRoleId;
    else return { ok: false, error: 'staffRoleId ungueltig.' };
  }

  if (b.mentionRoleIds !== undefined) {
    if (!Array.isArray(b.mentionRoleIds)) return { ok: false, error: 'mentionRoleIds muss ein Array sein.' };
    if (b.mentionRoleIds.length > 5) return { ok: false, error: 'Maximal 5 Mention-Rollen.' };
    const cleaned: string[] = [];
    for (const r of b.mentionRoleIds) {
      if (typeof r !== 'string' || !SNOWFLAKE_RE.test(r)) return { ok: false, error: 'mentionRoleIds: ungueltige Rollen-ID.' };
      if (!cleaned.includes(r)) cleaned.push(r);
    }
    data.mentionRoleIds = cleaned;
  }

  if (b.managerRoleIds !== undefined) {
    if (!Array.isArray(b.managerRoleIds)) return { ok: false, error: 'managerRoleIds muss ein Array sein.' };
    if (b.managerRoleIds.length > 10) return { ok: false, error: 'Maximal 10 Manager-Rollen.' };
    const cleaned: string[] = [];
    for (const r of b.managerRoleIds) {
      if (typeof r !== 'string' || !SNOWFLAKE_RE.test(r)) return { ok: false, error: 'managerRoleIds: ungueltige Rollen-ID.' };
      if (!cleaned.includes(r)) cleaned.push(r);
    }
    data.managerRoleIds = cleaned;
  }

  if (b.archiveChannelId !== undefined) {
    if (b.archiveChannelId === null || b.archiveChannelId === '') data.archiveChannelId = null;
    else if (typeof b.archiveChannelId === 'string' && SNOWFLAKE_RE.test(b.archiveChannelId)) data.archiveChannelId = b.archiveChannelId;
    else return { ok: false, error: 'archiveChannelId ungueltig.' };
  }

  if (b.isActive !== undefined) {
    if (typeof b.isActive !== 'boolean') return { ok: false, error: 'isActive muss bool sein.' };
    data.isActive = b.isActive;
  }

  if (partial && Object.keys(data).length === 0) return { ok: false, error: 'Keine gueltigen Felder.' };
  return { ok: true, data };
}

/**
 * Stellt sicher, dass die channel-/category-Slots nicht vermischt werden:
 * postChannelId, transcriptChannelId, archiveChannelId, categoryId muessen paarweise
 * verschieden sein (sofern gesetzt). User-Vorgabe: "niemals vermischt werden darf".
 */
async function validateTicketChannels(
  guildId: string,
  channels: { postChannelId?: string; transcriptChannelId?: string; archiveChannelId?: string | null },
): Promise<string | null> {
  const client = tryGetDashboardClient();
  if (!client) return null; // kein Bot-Client (Tests) -> Skip
  const writePerms = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
  ];
  const checks: Array<[string, string]> = [];
  if (channels.postChannelId) checks.push(['Post-Channel', channels.postChannelId]);
  if (channels.transcriptChannelId) checks.push(['Transcript-Channel', channels.transcriptChannelId]);
  if (channels.archiveChannelId) checks.push(['Archiv-Channel', channels.archiveChannelId]);
  for (const [label, id] of checks) {
    const v = await validateBotChannelAccess(client, guildId, id, writePerms);
    if (!v.ok) return `${label}: ${v.reason}`;
  }
  return null;
}

function enforceNoChannelMix(merged: {
  postChannelId?: string | null;
  transcriptChannelId?: string | null;
  archiveChannelId?: string | null;
  categoryId?: string | null;
}): string | null {
  const entries: Array<[string, string]> = [];
  if (merged.postChannelId) entries.push(['Post-Channel', merged.postChannelId]);
  if (merged.transcriptChannelId) entries.push(['Transcript-Channel', merged.transcriptChannelId]);
  if (merged.archiveChannelId) entries.push(['Archiv-Channel', merged.archiveChannelId]);
  if (merged.categoryId) entries.push(['Kategorie', merged.categoryId]);
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (entries[i][1] === entries[j][1]) {
        return `${entries[i][0]} und ${entries[j][0]} duerfen nicht identisch sein.`;
      }
    }
  }
  return null;
}

function normalizeWelcomeMessages(raw: unknown, fallback: string): string[] {
  if (Array.isArray(raw)) {
    const out = raw.filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
      .map(m => m.slice(0, WELCOME_MSG_MAX));
    if (out.length > 0) return out.slice(0, MAX_WELCOME_MESSAGES);
  }
  return fallback ? [fallback.slice(0, WELCOME_MSG_MAX)] : [''];
}

function serialize(t: TicketTemplate) {
  return {
    id: t.id,
    slot: t.slot,
    label: t.label,
    buttonLabel: (t as unknown as { buttonLabel?: string | null }).buttonLabel ?? null,
    welcomeText: t.welcomeText,
    welcomeMessages: normalizeWelcomeMessages(t.welcomeMessages, t.welcomeText),
    embedTitle: t.embedTitle,
    embedColor: t.embedColor,
    postChannelId: t.postChannelId,
    postedMessageId: t.postedMessageId,
    categoryId: t.categoryId,
    staffRoleId: t.staffRoleId,
    managerRoleIds: (t as unknown as { managerRoleIds?: string[] }).managerRoleIds ?? [],
    mentionRoleIds: t.mentionRoleIds ?? [],
    transcriptChannelId: t.transcriptChannelId,
    archiveChannelId: t.archiveChannelId,
    isActive: t.isActive,
    ticketCounter: (t as unknown as { ticketCounter?: number }).ticketCounter ?? 0,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

ticketsRouter.get('/', requireGuildPermission('tickets.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const templates = await prisma.ticketTemplate.findMany({
    where: { guildId: scope.guildId },
    orderBy: { slot: 'asc' },
  });
  res.json({ templates: templates.map(serialize), max: 5 });
});

ticketsRouter.get('/instances', requireGuildPermission('tickets.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const instances = await prisma.ticketInstance.findMany({
    where: { guildId: scope.guildId },
    orderBy: { openedAt: 'desc' },
    take: 100,
    include: { template: { select: { label: true, slot: true } } },
  });
  res.json({
    instances: instances.map(i => ({
      id: i.id,
      ticketNumber: (i as unknown as { ticketNumber?: number }).ticketNumber ?? null,
      templateLabel: i.template.label,
      templateSlot: i.template.slot,
      channelId: i.channelId,
      openerDiscordId: i.openerDiscordId,
      openerName: i.openerName,
      status: i.status,
      openedAt: i.openedAt.toISOString(),
      closedAt: i.closedAt?.toISOString() ?? null,
      closedBy: i.closedBy,
      userIds: (i as unknown as { userIds?: string[] }).userIds ?? [],
    })),
  });
});

ticketsRouter.post('/', requireGuildOwner, async (req, res) => {
  const scope = req.guildScope!;
  const v = validateBody(req.body ?? {}, false);
  if (!v.ok) { res.status(400).json({ error: v.error }); return; }

  const count = await prisma.ticketTemplate.count({ where: { guildId: scope.guildId } });
  if (count >= 5) { res.status(400).json({ error: 'Maximal 5 Templates pro Guild.' }); return; }

  const slotTaken = await prisma.ticketTemplate.findUnique({
    where: { guildId_slot: { guildId: scope.guildId, slot: v.data.slot as number } },
  });
  if (slotTaken) { res.status(409).json({ error: 'Slot bereits belegt.' }); return; }

  const mixErr = enforceNoChannelMix({
    postChannelId: v.data.postChannelId as string,
    transcriptChannelId: v.data.transcriptChannelId as string,
    archiveChannelId: (v.data.archiveChannelId as string | null | undefined) ?? null,
    categoryId: (v.data.categoryId as string | null | undefined) ?? null,
  });
  if (mixErr) { res.status(400).json({ error: mixErr }); return; }

  // Channel-Validierung: existiert + in Guild + Bot-Permissions vorhanden.
  const chErr = await validateTicketChannels(scope.guildId, {
    postChannelId: v.data.postChannelId as string,
    transcriptChannelId: v.data.transcriptChannelId as string,
    archiveChannelId: (v.data.archiveChannelId as string | null | undefined) ?? null,
  });
  if (chErr) { res.status(400).json({ error: chErr }); return; }

  const created = await prisma.ticketTemplate.create({
    data: {
      guildId: scope.guildId,
      slot: v.data.slot as number,
      label: v.data.label as string,
      welcomeText: v.data.welcomeText as string,
      welcomeMessages: (v.data.welcomeMessages as string[] | undefined) ?? [v.data.welcomeText as string],
      embedTitle: v.data.embedTitle as string,
      embedColor: (v.data.embedColor as string | undefined) ?? '#dc2626',
      postChannelId: v.data.postChannelId as string,
      transcriptChannelId: v.data.transcriptChannelId as string,
      archiveChannelId: (v.data.archiveChannelId as string | null | undefined) ?? null,
      categoryId: (v.data.categoryId as string | null | undefined) ?? null,
      staffRoleId: (v.data.staffRoleId as string | null | undefined) ?? null,
      managerRoleIds: (v.data.managerRoleIds as string[] | undefined) ?? [],
      mentionRoleIds: (v.data.mentionRoleIds as string[] | undefined) ?? [],
      isActive: (v.data.isActive as boolean | undefined) ?? true,
    },
  });
  logAuditDb('TICKET_TEMPLATE_CREATED', 'TICKET', { actorUserId: req.auth!.userId, guildId: scope.guildId, details: { templateId: created.id, slot: created.slot, label: created.label } });
  emitGuildEvent(scope.guildId, { type: 'tickets.changed', payload: { guildId: scope.guildId, templateId: created.id } });
  res.status(201).json(serialize(created));
});

ticketsRouter.put('/:id', requireGuildOwner, async (req, res) => {
  const scope = req.guildScope!;
  const id = String(req.params.id);
  const existing = await prisma.ticketTemplate.findUnique({ where: { id } });
  if (!existing || existing.guildId !== scope.guildId) { res.status(404).json({ error: 'Template nicht gefunden.' }); return; }

  const v = validateBody(req.body ?? {}, true);
  if (!v.ok) { res.status(400).json({ error: v.error }); return; }

  if (v.data.slot !== undefined && v.data.slot !== existing.slot) {
    const slotTaken = await prisma.ticketTemplate.findUnique({
      where: { guildId_slot: { guildId: scope.guildId, slot: v.data.slot as number } },
    });
    if (slotTaken) { res.status(409).json({ error: 'Slot bereits belegt.' }); return; }
  }

  const mixErr = enforceNoChannelMix({
    postChannelId: (v.data.postChannelId as string | undefined) ?? existing.postChannelId,
    transcriptChannelId: (v.data.transcriptChannelId as string | undefined) ?? existing.transcriptChannelId,
    archiveChannelId: v.data.archiveChannelId !== undefined
      ? (v.data.archiveChannelId as string | null)
      : existing.archiveChannelId,
    categoryId: v.data.categoryId !== undefined
      ? (v.data.categoryId as string | null)
      : existing.categoryId,
  });
  if (mixErr) { res.status(400).json({ error: mixErr }); return; }

  // Channel-Validierung nur fuer geaenderte Channel-Felder.
  const chErr = await validateTicketChannels(scope.guildId, {
    postChannelId: v.data.postChannelId !== undefined ? (v.data.postChannelId as string) : undefined,
    transcriptChannelId: v.data.transcriptChannelId !== undefined ? (v.data.transcriptChannelId as string) : undefined,
    archiveChannelId: v.data.archiveChannelId !== undefined ? (v.data.archiveChannelId as string | null) : undefined,
  });
  if (chErr) { res.status(400).json({ error: chErr }); return; }

  // F2/F3: Vor dem Update pruefen, ob der alte Embed entfernt werden muss
  // (Channel-Wechsel ODER Deaktivierung).
  const willChangePostChannel = v.data.postChannelId !== undefined && v.data.postChannelId !== existing.postChannelId;
  const willDeactivate = v.data.isActive === false && existing.isActive;
  const willReactivate = v.data.isActive === true && !existing.isActive;
  if ((willChangePostChannel || willDeactivate) && existing.postedMessageId) {
    const client = tryGetDashboardClient();
    if (client) {
      await unpostTemplateEmbed(client, existing.id).catch(() => {});
    }
  }

  const updated = await prisma.ticketTemplate.update({ where: { id }, data: v.data });

  // G11: Auto-Repost wenn Template aktiv ist und (Channel gewechselt oder reaktiviert).
  if (updated.isActive && (willChangePostChannel || willReactivate)) {
    const client = tryGetDashboardClient();
    if (client) {
      await postTemplateEmbed(client, updated.id).catch(err => {
        logAuditDb('TICKET_AUTO_REPOST_FAILED', 'TICKET', {
          actorUserId: req.auth!.userId, guildId: scope.guildId,
          details: { templateId: id, error: (err as Error).message },
        });
      });
    }
  }
  logAuditDb('TICKET_TEMPLATE_UPDATED', 'TICKET', { actorUserId: req.auth!.userId, guildId: scope.guildId, details: { templateId: id, fields: Object.keys(v.data) } });
  emitGuildEvent(scope.guildId, { type: 'tickets.changed', payload: { guildId: scope.guildId, templateId: id } });
  res.json(serialize(updated));
});

ticketsRouter.delete('/:id', requireGuildOwner, async (req, res) => {
  const scope = req.guildScope!;
  const id = String(req.params.id);
  const existing = await prisma.ticketTemplate.findUnique({ where: { id } });
  if (!existing || existing.guildId !== scope.guildId) { res.status(404).json({ error: 'Template nicht gefunden.' }); return; }

  // F4: Vor Cascade alle offenen Discord-Channels schliessen + Embed entfernen.
  const client = tryGetDashboardClient();
  let purged: { closed: number; failed: number } = { closed: 0, failed: 0 };
  if (client) {
    purged = await purgeTemplateInstances(client, id).catch(() => ({ closed: 0, failed: 0 }));
    if (existing.postedMessageId) {
      await unpostTemplateEmbed(client, id).catch(() => {});
    }
  }

  await prisma.ticketTemplate.delete({ where: { id } });
  logAuditDb('TICKET_TEMPLATE_DELETED', 'TICKET', { actorUserId: req.auth!.userId, guildId: scope.guildId, details: { templateId: id, slot: existing.slot, label: existing.label, purged } });
  emitGuildEvent(scope.guildId, { type: 'tickets.changed', payload: { guildId: scope.guildId, templateId: id } });
  res.status(204).end();
});

ticketsRouter.post('/:id/post', requireGuildOwner, async (req, res) => {
  const scope = req.guildScope!;
  const id = String(req.params.id);
  const existing = await prisma.ticketTemplate.findUnique({ where: { id } });
  if (!existing || existing.guildId !== scope.guildId) { res.status(404).json({ error: 'Template nicht gefunden.' }); return; }

  const client = tryGetDashboardClient();
  if (!client) { res.status(503).json({ error: 'Bot nicht bereit.' }); return; }

  try {
    const r = await postTemplateEmbed(client, id);
    res.json({ messageId: r.messageId });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/**
 * Setzt den Per-Template Ticket-Counter zurueck. Nur erlaubt, wenn keine OPEN-Instances
 * mehr existieren — sonst wuerde die naechste neue Nummer mit einer aktiven Instance
 * (templateNumber) kollidieren bzw. die Eindeutigkeit pro Template waere irrefuehrend.
 * Channels werden NICHT umbenannt.
 */
ticketsRouter.post('/:id/reset-counter', requireGuildOwner, async (req, res) => {
  const scope = req.guildScope!;
  const id = String(req.params.id);
  const existing = await prisma.ticketTemplate.findUnique({ where: { id } });
  if (!existing || existing.guildId !== scope.guildId) {
    res.status(404).json({ error: 'Template nicht gefunden.' });
    return;
  }
  const openCount = await prisma.ticketInstance.count({
    where: { templateId: id, status: 'OPEN' },
  });
  if (openCount > 0) {
    res.status(409).json({ error: `Es existieren noch ${openCount} offene Tickets in diesem Slot. Bitte zuerst schliessen.` });
    return;
  }
  const before = (existing as unknown as { ticketCounter?: number }).ticketCounter ?? 0;
  const updated = await prisma.ticketTemplate.update({
    where: { id },
    data: { ticketCounter: 0 },
  });
  logAuditDb('TICKET_TEMPLATE_COUNTER_RESET', 'TICKET', {
    actorUserId: req.auth!.userId,
    guildId: scope.guildId,
    details: { templateId: id, slot: existing.slot, before, after: 0 },
  });
  emitGuildEvent(scope.guildId, { type: 'tickets.changed', payload: { guildId: scope.guildId, templateId: id } });
  res.json(serialize(updated));
});

// --- Ticket-User-Management ---
// Validiert userId als Discord-Snowflake (17-20 stellige Zahl).
const USER_SNOWFLAKE_RE = /^\d{17,20}$/;

ticketsRouter.post('/instances/:instanceId/users', requireGuildPermission('tickets.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const instanceIdRaw = req.params.instanceId;
  if (!instanceIdRaw || Array.isArray(instanceIdRaw)) {
    return res.status(400).json({ error: 'Ungültige instanceId' });
  }
  const instanceId = instanceIdRaw;
  const userId = req.body?.userId;
  if (!userId || typeof userId !== 'string' || !USER_SNOWFLAKE_RE.test(userId)) {
    return res.status(400).json({ error: 'userId (Discord-ID) erforderlich' });
  }
  try {
    const ticket = await prisma.ticketInstance.findUnique({ where: { id: instanceId } });
    if (!ticket) return res.status(404).json({ error: 'Ticket-Instanz nicht gefunden' });
    // Guild-Scope-Check: Cross-Guild-Manipulation verhindern (IDOR-Schutz).
    if (ticket.guildId !== scope.guildId) {
      return res.status(404).json({ error: 'Ticket-Instanz nicht gefunden' });
    }
    if (ticket.status !== 'OPEN') {
      return res.status(409).json({ error: 'Ticket ist nicht (mehr) offen' });
    }
    if (ticket.userIds.includes(userId)) {
      return res.status(409).json({ error: 'User bereits hinzugefügt' });
    }
    const updated = await prisma.ticketInstance.update({
      where: { id: instanceId },
      data: { userIds: { set: [...ticket.userIds, userId] } },
    });
    // Discord-Channel-Permissions synchron halten (best-effort).
    const cli = tryGetDashboardClient();
    if (cli) {
      const ch = await cli.channels.fetch(ticket.channelId).catch(() => null);
      if (ch && ch.isTextBased() && !ch.isDMBased() && 'permissionOverwrites' in ch) {
        await (ch as unknown as { permissionOverwrites: { edit: (id: string, perms: object) => Promise<unknown> } })
          .permissionOverwrites.edit(userId, {
            ViewChannel: true,
            SendMessages: true,
            ReadMessageHistory: true,
            AttachFiles: true,
          }).catch(() => {});
      }
    }
    logAuditDb('TICKET_USER_ADDED', 'TICKET', {
      actorUserId: req.auth!.userId,
      guildId: scope.guildId,
      details: { instanceId, addedUser: userId },
    });
    emitGuildEvent(scope.guildId, { type: 'tickets.changed', payload: { guildId: scope.guildId } });
    return res.json({ success: true, userIds: updated.userIds });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: 'Interner Fehler', details: message });
  }
});

ticketsRouter.delete('/instances/:instanceId/users', requireGuildPermission('tickets.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const instanceIdRaw = req.params.instanceId;
  if (!instanceIdRaw || Array.isArray(instanceIdRaw)) {
    return res.status(400).json({ error: 'Ungültige instanceId' });
  }
  const instanceId = instanceIdRaw;
  const userId = req.body?.userId;
  if (!userId || typeof userId !== 'string' || !USER_SNOWFLAKE_RE.test(userId)) {
    return res.status(400).json({ error: 'userId (Discord-ID) erforderlich' });
  }
  try {
    const ticket = await prisma.ticketInstance.findUnique({ where: { id: instanceId } });
    if (!ticket) return res.status(404).json({ error: 'Ticket-Instanz nicht gefunden' });
    if (ticket.guildId !== scope.guildId) {
      return res.status(404).json({ error: 'Ticket-Instanz nicht gefunden' });
    }
    // Opener darf nicht entfernt werden (verhindert Inkonsistenz).
    if (userId === ticket.openerDiscordId) {
      return res.status(409).json({ error: 'Ticket-Eroeffner kann nicht entfernt werden' });
    }
    if (!ticket.userIds.includes(userId)) {
      return res.status(404).json({ error: 'User nicht in Ticket' });
    }
    const updated = await prisma.ticketInstance.update({
      where: { id: instanceId },
      data: { userIds: { set: ticket.userIds.filter((id) => id !== userId) } },
    });
    // Discord-Channel-Permissions zurueckziehen (best-effort).
    const cli = tryGetDashboardClient();
    if (cli) {
      const ch = await cli.channels.fetch(ticket.channelId).catch(() => null);
      if (ch && ch.isTextBased() && !ch.isDMBased() && 'permissionOverwrites' in ch) {
        await (ch as unknown as { permissionOverwrites: { delete: (id: string) => Promise<unknown> } })
          .permissionOverwrites.delete(userId).catch(() => {});
      }
    }
    logAuditDb('TICKET_USER_REMOVED', 'TICKET', {
      actorUserId: req.auth!.userId,
      guildId: scope.guildId,
      details: { instanceId, removedUser: userId },
    });
    emitGuildEvent(scope.guildId, { type: 'tickets.changed', payload: { guildId: scope.guildId } });
    return res.json({ success: true, userIds: updated.userIds });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: 'Interner Fehler', details: message });
  }
});
