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
import { requireGuildOwner, requireGuildPermission } from '../../middleware/auth';
import prisma from '../../../database/prisma';
import { logAuditDb } from '../../../utils/logger';
import { emitGuildEvent } from '../../socket/emitter';
import { tryGetDashboardClient } from '../../clientRegistry';
import { postTemplateEmbed } from '../../../modules/tickets/ticketSystem';

export const ticketsRouter = Router({ mergeParams: true });

const HEX_RE = /^#?[0-9a-fA-F]{6}$/;
const SNOWFLAKE_RE = /^\d{17,20}$/;

interface TemplateBody {
  slot?: number;
  label?: string;
  welcomeText?: string;
  embedTitle?: string;
  embedColor?: string;
  postChannelId?: string;
  categoryId?: string | null;
  staffRoleId?: string | null;
  transcriptChannelId?: string;
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

  if (b.welcomeText !== undefined) {
    if (typeof b.welcomeText !== 'string' || b.welcomeText.length < 1 || b.welcomeText.length > 4000) return { ok: false, error: 'welcomeText 1..4000 Zeichen.' };
    data.welcomeText = b.welcomeText;
  } else if (!partial) return { ok: false, error: 'welcomeText fehlt.' };

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

  if (b.isActive !== undefined) {
    if (typeof b.isActive !== 'boolean') return { ok: false, error: 'isActive muss bool sein.' };
    data.isActive = b.isActive;
  }

  if (partial && Object.keys(data).length === 0) return { ok: false, error: 'Keine gueltigen Felder.' };
  return { ok: true, data };
}

function serialize(t: {
  id: string; guildId: string; slot: number; label: string; welcomeText: string;
  embedTitle: string; embedColor: string; postChannelId: string; postedMessageId: string | null;
  categoryId: string | null; staffRoleId: string | null; transcriptChannelId: string;
  isActive: boolean; createdAt: Date; updatedAt: Date;
}) {
  return {
    id: t.id,
    slot: t.slot,
    label: t.label,
    welcomeText: t.welcomeText,
    embedTitle: t.embedTitle,
    embedColor: t.embedColor,
    postChannelId: t.postChannelId,
    postedMessageId: t.postedMessageId,
    categoryId: t.categoryId,
    staffRoleId: t.staffRoleId,
    transcriptChannelId: t.transcriptChannelId,
    isActive: t.isActive,
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
      templateLabel: i.template.label,
      templateSlot: i.template.slot,
      channelId: i.channelId,
      openerDiscordId: i.openerDiscordId,
      openerName: i.openerName,
      status: i.status,
      openedAt: i.openedAt.toISOString(),
      closedAt: i.closedAt?.toISOString() ?? null,
      closedBy: i.closedBy,
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

  const created = await prisma.ticketTemplate.create({
    data: {
      guildId: scope.guildId,
      slot: v.data.slot as number,
      label: v.data.label as string,
      welcomeText: v.data.welcomeText as string,
      embedTitle: v.data.embedTitle as string,
      embedColor: (v.data.embedColor as string | undefined) ?? '#dc2626',
      postChannelId: v.data.postChannelId as string,
      transcriptChannelId: v.data.transcriptChannelId as string,
      categoryId: (v.data.categoryId as string | null | undefined) ?? null,
      staffRoleId: (v.data.staffRoleId as string | null | undefined) ?? null,
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

  const updated = await prisma.ticketTemplate.update({ where: { id }, data: v.data });
  logAuditDb('TICKET_TEMPLATE_UPDATED', 'TICKET', { actorUserId: req.auth!.userId, guildId: scope.guildId, details: { templateId: id, fields: Object.keys(v.data) } });
  emitGuildEvent(scope.guildId, { type: 'tickets.changed', payload: { guildId: scope.guildId, templateId: id } });
  res.json(serialize(updated));
});

ticketsRouter.delete('/:id', requireGuildOwner, async (req, res) => {
  const scope = req.guildScope!;
  const id = String(req.params.id);
  const existing = await prisma.ticketTemplate.findUnique({ where: { id } });
  if (!existing || existing.guildId !== scope.guildId) { res.status(404).json({ error: 'Template nicht gefunden.' }); return; }

  await prisma.ticketTemplate.delete({ where: { id } });
  logAuditDb('TICKET_TEMPLATE_DELETED', 'TICKET', { actorUserId: req.auth!.userId, guildId: scope.guildId, details: { templateId: id, slot: existing.slot, label: existing.label } });
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
