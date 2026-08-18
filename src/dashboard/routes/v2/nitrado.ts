/**
 * Nitrado-Slot-Verwaltung. NUR Owner — niemals delegierbar.
 *
 * GET    /              listet alle Slots (alias5 sichtbar, Token nie)
 * POST   /              { slot, alias, token, nitradoServerId? } -> validiert Token, speichert verschluesselt
 * DELETE /:slot         loescht Slot (Cascade!)
 * GET    /:slot/services proxy zu NitradoClient.listServices()
 */
import { Router, type Response } from 'express';
import { requireGuildOwner } from '../../middleware/auth';
import {
  listSlots,
  createSlot,
  deleteSlot,
  getSlot,
  getDecryptedToken,
  updateToken,
  updateAlias,
  updateServiceId,
  NitradoSlotVersionConflictError,
} from '../../../modules/nitrado/repository';
import { NitradoClient } from '../../../modules/nitrado/nitradoClient';
import { asUserDiscordId, asNitradoConnId } from '../../../types/scope';
import { logAuditDb, logger } from '../../../utils/logger';

export const nitradoRouter = Router({ mergeParams: true });

async function validateTokenOrRespond(token: string, res: Response): Promise<boolean> {
  const r = await new NitradoClient(token).validateTokenDetailed();
  switch (r.kind) {
    case 'VALID':
      return true;
    case 'INVALID':
      res.status(400).json({ error: 'Nitrado-Token ungültig (von Nitrado abgelehnt). Token vollständig kopiert? Benötigte Scopes: rootserver, service, user_info.' });
      return false;
    case 'RATE_LIMITED':
      res.status(429).json({ error: 'Nitrado-Rate-Limit erreicht — bitte in ~1 Minute erneut versuchen.' });
      return false;
    case 'CIRCUIT_OPEN':
      res.status(503).json({ error: 'Nitrado-API vorübergehend gesperrt (zu viele Fehler zuvor) — bitte in ~1 Minute erneut versuchen.' });
      return false;
    default:
      res.status(502).json({ error: `Nitrado-API nicht erreichbar${'message' in r && r.message ? ` (${r.message})` : ''} — bitte erneut versuchen.` });
      return false;
  }
}

class ServiceValidationError extends Error {
  constructor(message: string, readonly status: 400 | 502) { super(message); }
}

async function validateServiceIdForToken(token: string, nitradoServerId: unknown): Promise<string | null> {
  if (nitradoServerId === undefined || nitradoServerId === null) return null;
  if (typeof nitradoServerId !== 'string') throw new ServiceValidationError('nitradoServerId muss String sein.', 400);
  const trimmed = nitradoServerId.trim();
  if (trimmed === '') return null;
  if (!/^\d{1,20}$/.test(trimmed)) throw new ServiceValidationError('Service-ID muss numerisch sein.', 400);
  let services;
  try {
    services = await new NitradoClient(token).listServices();
  } catch (e) {
    logger.error('Nitrado-Service-Check:', e as Error);
    throw new ServiceValidationError('Nitrado-API-Fehler bei Service-Pruefung.', 502);
  }
  if (!services.some(s => String(s.id) === trimmed)) {
    throw new ServiceValidationError('Service-ID gehoert nicht zu diesem Token.', 400);
  }
  return trimmed;
}

function respondVersionConflict(res: Response): void {
  res.status(409).json({
    error: 'Nitrado-Slot wurde parallel geändert. Bitte aktuellen Stand neu laden und die Aktion erneut ausführen.',
    code: 'NITRADO_SLOT_VERSION_CONFLICT',
  });
}

nitradoRouter.get('/', requireGuildOwner, async (req, res) => {
  const scope = req.guildScope!;
  const slots = await listSlots(scope.guildId);
  res.json({
    slots: slots.map(s => ({
      id: s.id,
      slot: s.slot,
      alias: s.alias,
      alias5: s.alias5,
      status: s.status,
      nitradoServerId: s.nitradoServerId,
      addedBy: s.addedBy,
      createdAt: s.createdAt,
    })),
  });
});

nitradoRouter.post('/', requireGuildOwner, async (req, res) => {
  const scope = req.guildScope!;
  const { slot, alias, token, nitradoServerId } = req.body ?? {};
  if (typeof slot !== 'number' || slot < 1 || slot > 5) { res.status(400).json({ error: 'slot 1..5' }); return; }
  if (typeof alias !== 'string' || alias.length < 1 || alias.length > 40) { res.status(400).json({ error: 'alias 1..40' }); return; }
  if (typeof token !== 'string' || token.length < 16) { res.status(400).json({ error: 'token zu kurz' }); return; }
  if (nitradoServerId !== undefined && typeof nitradoServerId !== 'string') { res.status(400).json({ error: 'nitradoServerId muss String sein.' }); return; }

  const existing = await getSlot(scope.guildId, slot);
  if (existing) { res.status(409).json({ error: `Slot ${slot} ist bereits belegt.` }); return; }

  if (!(await validateTokenOrRespond(token, res))) return;

  let normalizedServiceId: string | null;
  try {
    normalizedServiceId = await validateServiceIdForToken(token, nitradoServerId);
  } catch (e) {
    if (e instanceof ServiceValidationError) { res.status(e.status).json({ error: e.message }); return; }
    throw e;
  }

  try {
    const created = await createSlot({
      guildId: scope.guildId,
      slot,
      alias,
      rawToken: token,
      nitradoServerId: normalizedServiceId,
      addedBy: asUserDiscordId(scope.actorDiscordId),
    });
    logAuditDb('NITRADO_SLOT_CREATED', 'NITRADO', {
      actorUserId: req.auth!.userId, guildId: scope.guildId,
      details: { slot, alias, alias5: created.alias5 },
    });
    res.status(201).json({
      id: created.id,
      slot: created.slot,
      alias: created.alias,
      alias5: created.alias5,
      status: created.status,
    });
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') {
      res.status(409).json({ error: `Slot ${slot} ist bereits belegt.` }); return;
    }
    throw e;
  }
});

nitradoRouter.patch('/:slot/token', requireGuildOwner, async (req, res) => {
  const scope = req.guildScope!;
  const slot = Number(String(req.params.slot));
  if (!Number.isInteger(slot) || slot < 1 || slot > 5) { res.status(400).json({ error: 'slot 1..5' }); return; }
  const { token } = req.body ?? {};
  if (typeof token !== 'string' || token.length < 16) { res.status(400).json({ error: 'token zu kurz' }); return; }

  const existing = await getSlot(scope.guildId, slot);
  if (!existing) { res.status(404).json({ error: 'Slot nicht gefunden.' }); return; }

  const client = new NitradoClient(token);
  if (!(await validateTokenOrRespond(token, res))) return;

  let serviceMismatch = false;
  if (existing.nitradoServerId) {
    let services;
    try {
      services = await client.listServices();
    } catch (e) {
      logger.warn(`NIT-003: Service-Recheck bei Tokenrotation fehlgeschlagen (Slot ${slot}): ${(e as Error).message}`);
      res.status(502).json({
        error: 'Token wurde nicht geändert: Die vorhandene Nitrado-Service-Zuordnung konnte mit dem neuen Token nicht verifiziert werden.',
      });
      return;
    }
    serviceMismatch = !services.some((s) => String(s.id) === existing.nitradoServerId);
  }

  let updated;
  try {
    updated = await updateToken(scope.guildId, slot, token, {
      resetServiceId: serviceMismatch,
      expectedUpdatedAt: existing.updatedAt,
    });
  } catch (e) {
    if (e instanceof NitradoSlotVersionConflictError) { respondVersionConflict(res); return; }
    throw e;
  }
  if (!updated) { res.status(404).json({ error: 'Slot nicht gefunden.' }); return; }

  logAuditDb('NITRADO_SLOT_TOKEN_UPDATED', 'NITRADO', {
    actorUserId: req.auth!.userId, guildId: scope.guildId,
    details: { slot, alias5: updated.alias5, serviceReset: serviceMismatch },
  });
  res.json({ ok: true, slot: updated.slot, status: updated.status, serviceReset: serviceMismatch });
});

nitradoRouter.patch('/:slot/alias', requireGuildOwner, async (req, res) => {
  const scope = req.guildScope!;
  const slot = Number(String(req.params.slot));
  if (!Number.isInteger(slot) || slot < 1 || slot > 5) { res.status(400).json({ error: 'slot 1..5' }); return; }
  const { alias } = req.body ?? {};
  if (typeof alias !== 'string' || alias.trim().length < 1 || alias.trim().length > 40) {
    res.status(400).json({ error: 'alias 1..40' }); return;
  }
  let updated;
  try {
    updated = await updateAlias(scope.guildId, slot, alias);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message }); return;
  }
  if (!updated) { res.status(404).json({ error: 'Slot nicht gefunden.' }); return; }
  logAuditDb('NITRADO_SLOT_ALIAS_UPDATED', 'NITRADO', {
    actorUserId: req.auth!.userId, guildId: scope.guildId,
    details: { slot, alias: updated.alias, alias5: updated.alias5 },
  });
  res.json({ ok: true, slot: updated.slot, alias: updated.alias, alias5: updated.alias5 });
});

nitradoRouter.patch('/:slot/service', requireGuildOwner, async (req, res) => {
  const scope = req.guildScope!;
  const slot = Number(String(req.params.slot));
  if (!Number.isInteger(slot) || slot < 1 || slot > 5) { res.status(400).json({ error: 'slot 1..5' }); return; }
  const { nitradoServerId } = req.body ?? {};
  if (nitradoServerId !== null && typeof nitradoServerId !== 'string') {
    res.status(400).json({ error: 'nitradoServerId muss String oder null sein.' }); return;
  }
  const existing = await getSlot(scope.guildId, slot);
  if (!existing) { res.status(404).json({ error: 'Slot nicht gefunden.' }); return; }

  let normalized: string | null;
  if (nitradoServerId === null) {
    normalized = null;
  } else {
    try {
      const token = await getDecryptedToken(scope.guildId, asNitradoConnId(existing.id));
      normalized = await validateServiceIdForToken(token, nitradoServerId);
    } catch (e) {
      if (e instanceof ServiceValidationError) { res.status(e.status).json({ error: e.message }); return; }
      logger.error('Nitrado-Service-Check:', e as Error);
      res.status(502).json({ error: 'Nitrado-API-Fehler bei Service-Pruefung.' }); return;
    }
  }

  let updated;
  try {
    updated = await updateServiceId(scope.guildId, slot, normalized, {
      expectedUpdatedAt: existing.updatedAt,
    });
  } catch (e) {
    if (e instanceof NitradoSlotVersionConflictError) { respondVersionConflict(res); return; }
    res.status(400).json({ error: (e as Error).message }); return;
  }
  if (!updated) { res.status(404).json({ error: 'Slot nicht gefunden.' }); return; }

  logAuditDb('NITRADO_SLOT_SERVICE_UPDATED', 'NITRADO', {
    actorUserId: req.auth!.userId, guildId: scope.guildId,
    details: { slot, alias5: updated.alias5, nitradoServerId: updated.nitradoServerId },
  });
  res.json({ ok: true, slot: updated.slot, nitradoServerId: updated.nitradoServerId });
});

nitradoRouter.delete('/:slot', requireGuildOwner, async (req, res) => {
  const scope = req.guildScope!;
  const slot = Number(String(req.params.slot));
  if (!Number.isInteger(slot) || slot < 1 || slot > 5) { res.status(400).json({ error: 'slot 1..5' }); return; }
  const id = await deleteSlot(scope.guildId, slot);
  if (!id) { res.status(404).json({ error: 'Slot nicht gefunden.' }); return; }
  logAuditDb('NITRADO_SLOT_DELETED', 'NITRADO', { actorUserId: req.auth!.userId, guildId: scope.guildId, details: { slot, id } });
  res.json({ ok: true, deletedId: id });
});

nitradoRouter.get('/:slot/services', requireGuildOwner, async (req, res) => {
  const scope = req.guildScope!;
  const slot = Number(String(req.params.slot));
  if (!Number.isInteger(slot) || slot < 1 || slot > 5) { res.status(400).json({ error: 'slot 1..5' }); return; }
  const conn = await getSlot(scope.guildId, slot);
  if (!conn) { res.status(404).json({ error: 'Slot nicht gefunden.' }); return; }
  try {
    const token = await getDecryptedToken(scope.guildId, asNitradoConnId(conn.id));
    const services = await new NitradoClient(token).listServices();
    res.json({ services });
  } catch (e) {
    logger.error('Nitrado-Services-Fetch:', e as Error);
    res.status(502).json({ error: 'Nitrado-API-Fehler.' });
  }
});
