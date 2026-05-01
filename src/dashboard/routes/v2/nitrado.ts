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
import { listSlots, createSlot, deleteSlot, getSlot, getDecryptedToken } from '../../../modules/nitrado/repository';
import { NitradoClient } from '../../../modules/nitrado/nitradoClient';
import { asUserDiscordId, asNitradoConnId } from '../../../types/scope';
import { logAudit, logger } from '../../../utils/logger';

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
  logAudit('NITRADO_SLOT_CREATED', 'NITRADO', {
    guildId: scope.guildId, slot, alias, alias5: created.alias5, actor: scope.actorDiscordId,
  });
  res.status(201).json({
    id: created.id,
    slot: created.slot,
    alias: created.alias,
    alias5: created.alias5,
    status: created.status,
  });
});

nitradoRouter.delete('/:slot', requireGuildOwner, async (req, res) => {
  const scope = req.guildScope!;
  const slot = Number(String(req.params.slot));
  if (!Number.isInteger(slot) || slot < 1 || slot > 5) { res.status(400).json({ error: 'slot 1..5' }); return; }
  const id = await deleteSlot(scope.guildId, slot);
  if (!id) { res.status(404).json({ error: 'Slot nicht gefunden.' }); return; }
  logAudit('NITRADO_SLOT_DELETED', 'NITRADO', { guildId: scope.guildId, slot, id, actor: scope.actorDiscordId });
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
