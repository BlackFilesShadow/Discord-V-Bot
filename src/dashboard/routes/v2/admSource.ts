import { Router, type Request, type Response } from 'express';
import { requireGuildPermission } from '../../middleware/auth';
import prisma from '../../../database/prisma';
import { getSlot } from '../../../modules/nitrado/repository';
import { NitradoClient } from '../../../modules/nitrado/nitradoClient';
import { config } from '../../../config';
import { decrypt } from '../../../utils/security';
import {
  isValidIanaTimeZone,
  resolveAdmProfile,
  setManualAdmProfile,
} from '../../../modules/nitrado/adm/profileResolver';
import { rebaselineAdmTimeZoneAnchor } from '../../../modules/nitrado/adm/timeZoneRebaseline';
import {
  isAdmBindingFenceError,
  readCurrentAdmBinding,
  withFreshAdmBinding,
  type AdmBindingSnapshot,
} from '../../../modules/nitrado/adm/bindingFence';
import { logAuditDb } from '../../../utils/logger';

export const admSourceRouter = Router({ mergeParams: true });

interface SlotContext {
  guildId: string;
  slot: number;
  binding: AdmBindingSnapshot;
  client: NitradoClient;
}

function readSlot(raw: unknown): number | null {
  const slot = Number(String(raw ?? ''));
  return Number.isInteger(slot) && slot >= 1 && slot <= 5 ? slot : null;
}

function sendAdmError(res: Response, error: unknown, fallbackStatus: number): void {
  if (isAdmBindingFenceError(error)) {
    res.status(409).json({ error: 'Nitrado-Bindung wurde parallel geaendert oder wird gerade verwendet. Bitte erneut versuchen.' });
    return;
  }
  res.status(fallbackStatus).json({ error: (error as Error).message });
}

async function resolveSlotContext(req: Request, res: Response): Promise<SlotContext | null> {
  const guildId = req.guildScope!.guildId;
  const slot = readSlot(req.query.slot);
  if (!slot) { res.status(400).json({ error: 'slot 1..5 ist erforderlich.' }); return null; }
  const found = await getSlot(guildId, slot);
  if (!found) { res.status(404).json({ error: 'Nitrado-Slot nicht gefunden.' }); return null; }

  const binding = await readCurrentAdmBinding({ id: found.id, guildId });
  if (!binding) {
    res.status(409).json({ error: 'Slot ist nicht aktiv oder noch mit keiner Nitrado-Service-ID verknuepft.' });
    return null;
  }
  const token = decrypt(binding.encryptedToken, config.security.encryptionKey);
  return {
    guildId,
    slot,
    binding,
    client: new NitradoClient(token),
  };
}

// Page 2 (Killfeed & ADM) teilt bewusst denselben delegierbaren Manage-Scope.
// `dashboard.access` erbt diesen Scope ueber die zentrale hasPermission-Logik,
// waehrend Page-1-Operationen (Token/Service/Slot) weiterhin Owner-only bleiben.
admSourceRouter.get('/', requireGuildPermission('killfeed.manage'), async (req, res) => {
  try {
    const ctx = await resolveSlotContext(req, res);
    if (!ctx) return;
    const writeFence = <T>(work: () => Promise<T>): Promise<T> => withFreshAdmBinding(ctx.binding, work);
    const resolved = await resolveAdmProfile(
      { id: ctx.binding.id, guildId: ctx.guildId, nitradoServerId: ctx.binding.nitradoServerId },
      ctx.client,
      writeFence,
    );
    const files = await ctx.client.listAdmFiles(ctx.binding.nitradoServerId, resolved.profileDir);
    await withFreshAdmBinding(ctx.binding, async () => undefined);
    const latest = files.sort((a, b) => b.modified_at - a.modified_at || b.name.localeCompare(a.name))[0] ?? null;
    res.json({
      slot: ctx.slot,
      connectionId: ctx.binding.id,
      profileDir: resolved.profileDir,
      source: resolved.source,
      timeZone: resolved.timeZone,
      fileCount: files.length,
      latestFile: latest,
    });
  } catch (error) {
    sendAdmError(res, error, 502);
  }
});

admSourceRouter.patch('/', requireGuildPermission('killfeed.manage'), async (req, res) => {
  try {
    const ctx = await resolveSlotContext(req, res);
    if (!ctx) return;

    const body = req.body ?? {};
    const profileDirRaw = body.profileDir;
    const hasProfileDir = typeof profileDirRaw === 'string' && profileDirRaw.trim().length > 0;
    const hasTimeZone = Object.prototype.hasOwnProperty.call(body, 'timeZone');
    if (!hasProfileDir && !hasTimeZone) {
      res.status(400).json({ error: 'profileDir oder timeZone ist erforderlich.' });
      return;
    }

    const timeZoneRaw = body.timeZone;
    const timeZone = timeZoneRaw == null || String(timeZoneRaw).trim() === '' ? null : String(timeZoneRaw).trim();
    if (timeZone && !isValidIanaTimeZone(timeZone)) {
      res.status(400).json({ error: 'timeZone muss eine gueltige IANA-Zeitzone sein, z.B. Europe/Berlin.' });
      return;
    }

    const writeFence = <T>(work: () => Promise<T>): Promise<T> => withFreshAdmBinding(ctx.binding, work);
    const scope = { id: ctx.binding.id, guildId: ctx.guildId, nitradoServerId: ctx.binding.nitradoServerId };
    const before = await resolveAdmProfile(scope, ctx.client, writeFence);

    let saved = before;
    if (hasProfileDir) {
      saved = await setManualAdmProfile(
        scope,
        ctx.client,
        String(profileDirRaw).trim(),
        timeZone,
        writeFence,
      );
    } else {
      await writeFence(() => prisma.nitradoAdmProfileConfig.updateMany({
        where: { guildId: ctx.guildId, nitradoConnId: ctx.binding.id },
        data: { timeZone, lastVerifiedAt: new Date(), lastError: null },
      }));
      saved = { ...before, timeZone };
    }

    const timeZoneChanged = before.timeZone !== saved.timeZone;
    // Ein explizites reines Zeitzonen-Speichern rebaselined auch bei gleichem
    // Wert. Das ist idempotent, repariert aber bereits durch den alten Bug um
    // +24h verschobene Continuation-Anker ohne Cursor-/Feed-Reset.
    const shouldRebaselineTimeZone = hasTimeZone && (!hasProfileDir || timeZoneChanged);
    const timeRebaseline = shouldRebaselineTimeZone
      ? await writeFence(() => rebaselineAdmTimeZoneAnchor(
          { guildId: ctx.guildId, nitradoConnId: ctx.binding.id },
          before.timeZone,
          saved.timeZone,
        ))
      : null;

    logAuditDb('NITRADO_ADM_SOURCE_UPDATED', 'NITRADO', {
      actorUserId: req.auth!.userId,
      guildId: ctx.guildId,
      details: {
        slot: ctx.slot,
        nitradoConnId: ctx.binding.id,
        bindingVersion: ctx.binding.bindingVersion,
        profileDir: saved.profileDir,
        source: saved.source,
        previousTimeZone: before.timeZone,
        timeZone: saved.timeZone,
        timeRebaseline,
      },
    });
    res.json({ ok: true, ...saved, timeRebaseline });
  } catch (error) {
    sendAdmError(res, error, 400);
  }
});

admSourceRouter.post('/rediscover', requireGuildPermission('killfeed.manage'), async (req, res) => {
  try {
    const ctx = await resolveSlotContext(req, res);
    if (!ctx) return;
    const writeFence = <T>(work: () => Promise<T>): Promise<T> => withFreshAdmBinding(ctx.binding, work);
    await writeFence(() => prisma.nitradoAdmProfileConfig.deleteMany({
      where: { guildId: ctx.guildId, nitradoConnId: ctx.binding.id },
    }));
    const resolved = await resolveAdmProfile(
      { id: ctx.binding.id, guildId: ctx.guildId, nitradoServerId: ctx.binding.nitradoServerId },
      ctx.client,
      writeFence,
    );
    logAuditDb('NITRADO_ADM_SOURCE_REDISCOVERED', 'NITRADO', {
      actorUserId: req.auth!.userId,
      guildId: ctx.guildId,
      details: {
        slot: ctx.slot,
        nitradoConnId: ctx.binding.id,
        bindingVersion: ctx.binding.bindingVersion,
        profileDir: resolved.profileDir,
      },
    });
    res.json({ ok: true, ...resolved });
  } catch (error) {
    sendAdmError(res, error, 502);
  }
});
