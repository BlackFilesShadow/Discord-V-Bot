import { Router } from 'express';
import { requireGuildOwner } from '../../middleware/auth';
import prisma from '../../../database/prisma';
import { getSlot, getDecryptedToken } from '../../../modules/nitrado/repository';
import { NitradoClient } from '../../../modules/nitrado/nitradoClient';
import { asNitradoConnId } from '../../../types/scope';
import {
  isValidIanaTimeZone,
  resolveAdmProfile,
  setManualAdmProfile,
} from '../../../modules/nitrado/adm/profileResolver';
import { logAuditDb } from '../../../utils/logger';

export const admSourceRouter = Router({ mergeParams: true });

function readSlot(raw: unknown): number | null {
  const slot = Number(String(raw ?? ''));
  return Number.isInteger(slot) && slot >= 1 && slot <= 5 ? slot : null;
}

async function context(req: Parameters<typeof requireGuildOwner>[0] & { guildScope?: never }) {
  void req;
}

async function resolveSlotContext(req: any, res: any): Promise<{
  guildId: string;
  slot: number;
  conn: Awaited<ReturnType<typeof getSlot>> & { id: string; nitradoServerId: string };
  client: NitradoClient;
} | null> {
  const guildId = req.guildScope!.guildId as string;
  const slot = readSlot(req.query.slot);
  if (!slot) { res.status(400).json({ error: 'slot 1..5 ist erforderlich.' }); return null; }
  const found = await getSlot(guildId, slot);
  if (!found) { res.status(404).json({ error: 'Nitrado-Slot nicht gefunden.' }); return null; }
  if (!found.nitradoServerId) { res.status(409).json({ error: 'Slot ist noch mit keiner Nitrado-Service-ID verknuepft.' }); return null; }
  const token = await getDecryptedToken(guildId, asNitradoConnId(found.id));
  return {
    guildId,
    slot,
    conn: found as typeof found & { id: string; nitradoServerId: string },
    client: new NitradoClient(token),
  };
}

admSourceRouter.get('/', requireGuildOwner, async (req, res) => {
  try {
    const ctx = await resolveSlotContext(req, res);
    if (!ctx) return;
    const resolved = await resolveAdmProfile(
      { id: ctx.conn.id, guildId: ctx.guildId, nitradoServerId: ctx.conn.nitradoServerId },
      ctx.client,
    );
    const files = await ctx.client.listAdmFiles(ctx.conn.nitradoServerId, resolved.profileDir);
    const latest = files.sort((a, b) => b.modified_at - a.modified_at || b.name.localeCompare(a.name))[0] ?? null;
    res.json({
      slot: ctx.slot,
      connectionId: ctx.conn.id,
      profileDir: resolved.profileDir,
      source: resolved.source,
      timeZone: resolved.timeZone,
      fileCount: files.length,
      latestFile: latest,
    });
  } catch (error) {
    res.status(502).json({ error: (error as Error).message });
  }
});

admSourceRouter.patch('/', requireGuildOwner, async (req, res) => {
  try {
    const ctx = await resolveSlotContext(req, res);
    if (!ctx) return;
    const profileDir = req.body?.profileDir;
    const timeZoneRaw = req.body?.timeZone;
    if (typeof profileDir !== 'string' || !profileDir.trim()) {
      res.status(400).json({ error: 'profileDir ist erforderlich.' });
      return;
    }
    const timeZone = timeZoneRaw == null || String(timeZoneRaw).trim() === '' ? null : String(timeZoneRaw).trim();
    if (timeZone && !isValidIanaTimeZone(timeZone)) {
      res.status(400).json({ error: 'timeZone muss eine gueltige IANA-Zeitzone sein, z.B. Europe/Berlin.' });
      return;
    }
    const saved = await setManualAdmProfile(
      { id: ctx.conn.id, guildId: ctx.guildId, nitradoServerId: ctx.conn.nitradoServerId },
      ctx.client,
      profileDir,
      timeZone,
    );
    logAuditDb('NITRADO_ADM_SOURCE_UPDATED', 'NITRADO', {
      actorUserId: req.auth!.userId,
      guildId: ctx.guildId,
      details: { slot: ctx.slot, nitradoConnId: ctx.conn.id, profileDir: saved.profileDir, timeZone: saved.timeZone },
    });
    res.json({ ok: true, ...saved });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

admSourceRouter.post('/rediscover', requireGuildOwner, async (req, res) => {
  try {
    const ctx = await resolveSlotContext(req, res);
    if (!ctx) return;
    await prisma.nitradoAdmProfileConfig.deleteMany({
      where: { guildId: ctx.guildId, nitradoConnId: ctx.conn.id },
    });
    const resolved = await resolveAdmProfile(
      { id: ctx.conn.id, guildId: ctx.guildId, nitradoServerId: ctx.conn.nitradoServerId },
      ctx.client,
    );
    logAuditDb('NITRADO_ADM_SOURCE_REDISCOVERED', 'NITRADO', {
      actorUserId: req.auth!.userId,
      guildId: ctx.guildId,
      details: { slot: ctx.slot, nitradoConnId: ctx.conn.id, profileDir: resolved.profileDir },
    });
    res.json({ ok: true, ...resolved });
  } catch (error) {
    res.status(502).json({ error: (error as Error).message });
  }
});
