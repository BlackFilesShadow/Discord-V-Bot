/**
 * Nitrado-Slot-Verwaltung. NUR Owner — niemals delegierbar.
 *
 * GET    /              listet alle Slots (alias5 sichtbar, Token nie)
 * POST   /              { slot, alias, token, nitradoServerId? } -> validiert Token, speichert verschluesselt
 * DELETE /:slot         loescht Slot (Cascade!)
 * GET    /:slot/services proxy zu NitradoClient.listServices()
 */
import { Router } from 'express';
import { requireGuildOwner } from '../../middleware/auth';
import { listSlots, createSlot, deleteSlot, getSlot, getDecryptedToken, updateToken, updateAlias, updateServiceId } from '../../../modules/nitrado/repository';
import { NitradoClient } from '../../../modules/nitrado/nitradoClient';
import { asUserDiscordId, asNitradoConnId } from '../../../types/scope';
import { logAuditDb, logger } from '../../../utils/logger';

export const nitradoRouter = Router({ mergeParams: true });

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

  // Token vor dem Speichern validieren
  const valid = await new NitradoClient(token).validateToken();
  if (!valid) { res.status(400).json({ error: 'Nitrado-Token ungueltig.' }); return; }

  const created = await createSlot({
    guildId: scope.guildId,
    slot,
    alias,
    rawToken: token,
    nitradoServerId: nitradoServerId ?? null,
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
});

/**
 * PATCH /:slot/token  body: { token: string }
 * Tauscht den Token eines bestehenden Slots aus (z.B. nach Token-Rotation
 * im Nitrado-Account). Validiert vorher gegen Nitrado-API.
 * Owner-only — niemals delegierbar.
 */
nitradoRouter.patch('/:slot/token', requireGuildOwner, async (req, res) => {
  const scope = req.guildScope!;
  const slot = Number(String(req.params.slot));
  if (!Number.isInteger(slot) || slot < 1 || slot > 5) { res.status(400).json({ error: 'slot 1..5' }); return; }
  const { token } = req.body ?? {};
  if (typeof token !== 'string' || token.length < 16) { res.status(400).json({ error: 'token zu kurz' }); return; }

  const existing = await getSlot(scope.guildId, slot);
  if (!existing) { res.status(404).json({ error: 'Slot nicht gefunden.' }); return; }

  const valid = await new NitradoClient(token).validateToken();
  if (!valid) { res.status(400).json({ error: 'Nitrado-Token ungueltig.' }); return; }

  const updated = await updateToken(scope.guildId, slot, token);
  if (!updated) { res.status(500).json({ error: 'Update fehlgeschlagen.' }); return; }

  logAuditDb('NITRADO_SLOT_TOKEN_UPDATED', 'NITRADO', {
    actorUserId: req.auth!.userId, guildId: scope.guildId,
    details: { slot, alias5: updated.alias5 },
  });
  res.json({ ok: true, slot: updated.slot, status: updated.status });
});

/**
 * PATCH /:slot/alias  body: { alias: string }
 * Aktualisiert nur den Anzeige-Namen eines Slots. Owner-only.
 */
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

/**
 * PATCH /:slot/service  body: { nitradoServerId: string | null }
 *
 * Verknuepft den Slot mit einer konkreten Nitrado-Service-ID. Ohne diese
 * Verknuepfung koennen weder Whitelist-Jobs noch ADM-Sync ausgefuehrt werden
 * (Worker setzt entsprechende Jobs auf DEAD). Owner-only.
 *
 * `null` entfernt die Verknuepfung wieder.
 */
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

  // Wenn gesetzt: gegen Nitrado-API pruefen, dass die Service-ID dem Token-Owner gehoert
  let normalized: string | null = nitradoServerId;
  if (typeof nitradoServerId === 'string') {
    const trimmed = nitradoServerId.trim();
    if (!/^\d{1,20}$/.test(trimmed)) { res.status(400).json({ error: 'Service-ID muss numerisch sein.' }); return; }
    try {
      const token = await getDecryptedToken(scope.guildId, asNitradoConnId(existing.id));
      const services = await new NitradoClient(token).listServices();
      const found = services.find(s => String(s.id) === trimmed);
      if (!found) { res.status(400).json({ error: 'Service-ID gehoert nicht zu diesem Token.' }); return; }
    } catch (e) {
      logger.error('Nitrado-Service-Check:', e as Error);
      res.status(502).json({ error: 'Nitrado-API-Fehler bei Service-Pruefung.' }); return;
    }
    normalized = trimmed;
  }

  let updated;
  try {
    updated = await updateServiceId(scope.guildId, slot, normalized);
  } catch (e) {
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
