/**
 * Whitelist: lokale DB als Source-of-Truth, Push zu Nitrado im Hintergrund
 * via NitradoJob (Outbox, Haertung A2). REST-Routen erstellen nur den Job
 * und den DB-Eintrag, kein synchroner API-Call.
 *
 * GET    /                           Liste lokaler Eintraege
 * POST   /                           body: { gameId, source? } -> WhitelistEntry + NitradoJob('WHITELIST_ADD')
 * DELETE /:gameId                    -> Loescht Entry + NitradoJob('WHITELIST_REMOVE')
 * GET    /requests                   PENDING-Requests
 * POST   /requests/:id/decision      body: { approve: boolean, reason? }
 */
import { Router } from 'express';
import { requireGuildPermission } from '../../middleware/auth';
import prisma from '../../../database/prisma';
import { logAuditDb, logger } from '../../../utils/logger';
import { emitGuildEvent } from '../../socket/emitter';
import { getDecryptedToken } from '../../../modules/nitrado/repository';
import { NitradoClient } from '../../../modules/nitrado/nitradoClient';
import { asNitradoConnId } from '../../../types/scope';
import { ensureNitradoWriteAllowed } from '../../middleware/nitradoWriteGuard';

export const whitelistRouter = Router({ mergeParams: true });

// Nitrado verwaltet die Whitelist per Spielername. Wir validieren nur Form
// und Laenge — alles andere geht 1:1 an Nitrado.
const NAME_RE = /^[^\r\n\t]{1,64}$/;
function isValidName(s: unknown): s is string {
  return typeof s === 'string' && NAME_RE.test(s.trim()) && s.trim().length >= 1;
}

async function activeSlotId(guildId: string, slotParam: unknown): Promise<string | null> {
  if (typeof slotParam === 'string' && /^[1-5]$/.test(slotParam)) {
    const c = await prisma.nitradoConnection.findUnique({
      where: { guildId_slot: { guildId, slot: Number(slotParam) } }, select: { id: true },
    });
    return c?.id ?? null;
  }
  const c = await prisma.nitradoConnection.findFirst({
    where: { guildId, status: 'ACTIVE' }, orderBy: { slot: 'asc' }, select: { id: true },
  });
  return c?.id ?? null;
}

whitelistRouter.get('/', requireGuildPermission('whitelist.view'), async (req, res) => {
  const scope = req.guildScope!;
  const connId = await activeSlotId(scope.guildId, req.query.slot);
  if (!connId) { res.status(404).json({ error: 'Kein Nitrado-Slot.' }); return; }
  const rows = await prisma.whitelistEntry.findMany({
    where: { guildId: scope.guildId, nitradoConnId: connId },
    orderBy: { approvedAt: 'desc' },
    take: 1000,
  });
  res.json({ entries: rows.map(r => ({ gameId: r.gameId, approvedBy: r.approvedByDiscordId, source: r.source, approvedAt: r.approvedAt })) });
});

whitelistRouter.post('/', requireGuildPermission('whitelist.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const connId = await activeSlotId(scope.guildId, req.query.slot);
  if (!connId) { res.status(404).json({ error: 'Kein Nitrado-Slot.' }); return; }
  const { gameId: rawId, source } = req.body ?? {};
  if (!isValidName(rawId)) { res.status(400).json({ error: 'Name erforderlich (1-64 Zeichen, keine Zeilenumbrueche).' }); return; }
  const gameId = (rawId as string).trim();
  const src = (source === 'REQUEST' || source === 'IMPORT') ? source : 'DIRECT';

  // Spec §12: erstellt einen NitradoJob('WHITELIST_ADD') -> schreibende
  // Nitrado-Aktion. Bei aktivem Schreibschutz Confirm + Reason + Audit noetig.
  if (!ensureNitradoWriteAllowed(req, res, { action: 'NITRADO_WHITELIST_ADD', danger: false })) return;

  try {
    await prisma.$transaction(async tx => {
      await tx.whitelistEntry.create({
        data: {
          guildId: scope.guildId, nitradoConnId: connId, gameId, source: src,
          approvedByDiscordId: scope.actorDiscordId,
        },
      });
      await tx.nitradoJob.create({
        data: {
          guildId: scope.guildId, nitradoConnId: connId,
          operation: 'WHITELIST_ADD', payload: { gameId },
        },
      });
    });
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') {
      res.status(409).json({ error: 'gameId bereits in Whitelist.' }); return;
    }
    throw e;
  }
  logAuditDb('WHITELIST_ADD', 'WHITELIST', { actorUserId: req.auth!.userId, guildId: scope.guildId, details: { slotId: connId, gameId } });
  emitGuildEvent(scope.guildId, { type: 'whitelist.changed', payload: { guildId: scope.guildId, action: 'added' } });
  res.status(201).json({ ok: true });
});

whitelistRouter.delete('/:gameId', requireGuildPermission('whitelist.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const connId = await activeSlotId(scope.guildId, req.query.slot);
  if (!connId) { res.status(404).json({ error: 'Kein Nitrado-Slot.' }); return; }
  const gameId = String(req.params.gameId).trim();
  if (!isValidName(gameId)) { res.status(400).json({ error: 'Ungueltiger Name.' }); return; }
  // Spec §12: erstellt einen NitradoJob('WHITELIST_REMOVE') -> schreibende
  // Nitrado-Aktion. Bei aktivem Schreibschutz Confirm + Reason + Audit noetig.
  if (!ensureNitradoWriteAllowed(req, res, { action: 'NITRADO_WHITELIST_REMOVE', danger: false })) return;
  await prisma.$transaction(async tx => {
    await tx.whitelistEntry.deleteMany({
      where: { guildId: scope.guildId, nitradoConnId: connId, gameId },
    });
    await tx.nitradoJob.create({
      data: {
        guildId: scope.guildId, nitradoConnId: connId,
        operation: 'WHITELIST_REMOVE', payload: { gameId },
      },
    });
    // Cap-Reset (siehe /wl-remove): APPROVED-Requests des urspruenglichen
    // Antragstellers auf CANCELLED setzen, sonst bleibt sein Cap belegt.
    await tx.whitelistRequest.updateMany({
      where: { guildId: scope.guildId, nitradoConnId: connId, gameId, status: 'APPROVED' },
      data: { status: 'CANCELLED' },
    });
  });
  logAuditDb('WHITELIST_REMOVE', 'WHITELIST', { actorUserId: req.auth!.userId, guildId: scope.guildId, details: { slotId: connId, gameId } });
  emitGuildEvent(scope.guildId, { type: 'whitelist.changed', payload: { guildId: scope.guildId, action: 'removed' } });
  res.json({ ok: true });
});

whitelistRouter.get('/requests', requireGuildPermission('whitelist.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const connId = await activeSlotId(scope.guildId, req.query.slot);
  if (!connId) { res.status(404).json({ error: 'Kein Nitrado-Slot.' }); return; }
  const rows = await prisma.whitelistRequest.findMany({
    where: { guildId: scope.guildId, nitradoConnId: connId, status: 'PENDING' },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ requests: rows });
});

whitelistRouter.post('/requests/:id/decision', requireGuildPermission('whitelist.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const { approve, reason } = req.body ?? {};
  if (typeof approve !== 'boolean') { res.status(400).json({ error: 'approve muss boolean sein.' }); return; }
  if (reason !== undefined && (typeof reason !== 'string' || reason.length > 500)) { res.status(400).json({ error: 'reason max 500.' }); return; }

  // Slot-Scope erzwingen: Decision nur fuer den aktuell ausgewaehlten Nitrado-Slot.
  const connId = await activeSlotId(scope.guildId, req.query.slot);
  if (!connId) { res.status(404).json({ error: 'Kein Nitrado-Slot.' }); return; }

  const reqRow = await prisma.whitelistRequest.findFirst({
    where: { id: String(req.params.id), guildId: scope.guildId, nitradoConnId: connId },
  });
  if (!reqRow) { res.status(404).json({ error: 'Request nicht gefunden.' }); return; }

  // Spec §12: nur die Genehmigung erzeugt einen NitradoJob('WHITELIST_ADD')
  // (schreibende Nitrado-Aktion). Ablehnung schreibt nichts nach Nitrado und
  // bleibt ungated. Guard VOR dem CAS, damit bei 412 kein Statuswechsel erfolgt.
  if (approve && !ensureNitradoWriteAllowed(req, res, { action: 'NITRADO_WHITELIST_REQUEST_APPROVE', danger: false })) return;

  // Atomic CAS: nur entscheiden wenn noch PENDING (schliesst Race mit Discord-Button).
  const cas = await prisma.whitelistRequest.updateMany({
    where: { id: reqRow.id, guildId: scope.guildId, nitradoConnId: connId, status: 'PENDING' },
    data: {
      status: approve ? 'APPROVED' : 'DENIED',
      decidedAt: new Date(),
      decidedByDiscordId: scope.actorDiscordId,
      reason: reason ?? null,
    },
  });
  if (cas.count !== 1) { res.status(409).json({ error: 'Request bereits entschieden.' }); return; }

  if (approve) {
    await prisma.whitelistEntry.upsert({
      where: { guildId_nitradoConnId_gameId: { guildId: scope.guildId, nitradoConnId: reqRow.nitradoConnId, gameId: reqRow.gameId } },
      create: {
        guildId: scope.guildId, nitradoConnId: reqRow.nitradoConnId, gameId: reqRow.gameId,
        source: 'REQUEST', approvedByDiscordId: scope.actorDiscordId,
      },
      update: { approvedByDiscordId: scope.actorDiscordId, source: 'REQUEST', approvedAt: new Date() },
    });
    await prisma.nitradoJob.create({
      data: {
        guildId: scope.guildId, nitradoConnId: reqRow.nitradoConnId,
        operation: 'WHITELIST_ADD', payload: { gameId: reqRow.gameId },
      },
    });
  }
  logAuditDb('WHITELIST_REQUEST_DECISION', 'WHITELIST', {
    actorUserId: req.auth!.userId, guildId: scope.guildId,
    details: { requestId: reqRow.id, approve },
  });
  emitGuildEvent(scope.guildId, { type: 'whitelist.changed', payload: { guildId: scope.guildId, entryId: reqRow.id, action: 'decided' } });

  // Konsistenz mit Discord-Button-Pfad: User per DM benachrichtigen + Decision-Log
  // posten + Approval-Embed im Request-Channel finalisieren (Buttons entfernen).
  try {
    const { notifyRequesterDecision, postDecisionLog, finalizeApprovalEmbed } = await import('../../../modules/whitelist/whitelistChannels.js');
    void Promise.allSettled([
      notifyRequesterDecision({
        requesterDiscordId: reqRow.requesterDiscordId,
        gameId: reqRow.gameId, approved: approve, reason: reason || undefined,
      }),
      postDecisionLog({
        guildId: scope.guildId, nitradoConnId: reqRow.nitradoConnId, approved: approve,
        requesterDiscordId: reqRow.requesterDiscordId, gameId: reqRow.gameId,
        decidedByDiscordId: scope.actorDiscordId, reason: reason || undefined,
      }),
      reqRow.messageId ? finalizeApprovalEmbed({
        guildId: scope.guildId, channelId: reqRow.channelId, messageId: reqRow.messageId,
        approved: approve, decidedByDiscordId: scope.actorDiscordId,
      }) : Promise.resolve(),
    ]);
  } catch { /* nicht-fatal */ }

  res.json({ ok: true });
});

/**
 * POST /sync  body: { mode?: 'preview' | 'apply', direction?: 'pull' | 'push' | 'merge' }
 *
 * Gleicht lokale `WhitelistEntry`-Tabelle und Nitrado-Whitelist (settings.general.whitelist) ab.
 *
 * direction:
 *   - 'pull'   : Nitrado ist Source-of-Truth. Lokal fehlende werden in DB importiert,
 *                lokal ueberzaehlige werden aus DB geloescht. Nitrado bleibt unangetastet.
 *   - 'push'   : DB ist Source-of-Truth. Es entsteht 1 NitradoJob WHITELIST_SYNC,
 *                der die Nitrado-Liste komplett auf den DB-Stand setzt.
 *   - 'merge'  : (default) Vereinigung beider Listen. Lokal fehlende werden importiert,
 *                Nitrado fehlende werden via WHITELIST_ADD-Jobs nachgetragen.
 *
 * mode:
 *   - 'preview' (default): kein Schreibzugriff, nur Diff-Bericht
 *   - 'apply'           : fuehrt die Aenderungen aus
 */
whitelistRouter.post('/sync', requireGuildPermission('whitelist.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const connId = await activeSlotId(scope.guildId, req.query.slot);
  if (!connId) { res.status(404).json({ error: 'Kein Nitrado-Slot.' }); return; }

  const mode = (req.body?.mode === 'apply') ? 'apply' : 'preview';
  const direction = (['pull', 'push', 'merge'].includes(req.body?.direction))
    ? req.body.direction as 'pull' | 'push' | 'merge'
    : 'merge';

  const conn = await prisma.nitradoConnection.findFirst({
    where: { id: connId, guildId: scope.guildId },
    select: { id: true, nitradoServerId: true, status: true },
  });
  if (!conn) { res.status(404).json({ error: 'Slot nicht gefunden.' }); return; }
  if (!conn.nitradoServerId) { res.status(400).json({ error: 'Slot hat keine Nitrado-Service-ID.' }); return; }
  if (conn.status !== 'ACTIVE') { res.status(400).json({ error: `Slot ist ${conn.status}.` }); return; }

  // 1) Beide Quellen lesen
  let nitradoList: string[];
  try {
    const token = await getDecryptedToken(scope.guildId, asNitradoConnId(conn.id));
    const remote = await new NitradoClient(token).getWhitelist(conn.nitradoServerId);
    nitradoList = remote.map(r => r.identifier);
  } catch (e) {
    logger.error('Whitelist-Sync: Nitrado-Read fehlgeschlagen', e as Error);
    res.status(502).json({ error: 'Nitrado-API nicht erreichbar.' }); return;
  }
  const localRows = await prisma.whitelistEntry.findMany({
    where: { guildId: scope.guildId, nitradoConnId: connId },
    select: { gameId: true },
  });
  const localList = localRows.map(r => r.gameId);

  const localSet = new Set(localList);
  const remoteSet = new Set(nitradoList);
  const onlyLocal = localList.filter(n => !remoteSet.has(n));   // bei push: nach Nitrado nachtragen
  const onlyRemote = nitradoList.filter(n => !localSet.has(n)); // bei pull: in DB importieren
  const both = localList.filter(n => remoteSet.has(n));

  const diff = {
    direction, mode,
    counts: { local: localList.length, remote: nitradoList.length, both: both.length, onlyLocal: onlyLocal.length, onlyRemote: onlyRemote.length },
    onlyLocal, onlyRemote,
  };

  if (mode === 'preview') { res.json({ ok: true, preview: true, diff }); return; }

  // 2) APPLY
  // Spec §12: Schreibende Nitrado-Aktionen (Remote-Whitelist aendern) sind bei
  // aktivem NITRADO_WRITE_PROTECTION durch Confirm + Reason + Audit geschuetzt.
  // 'pull' schreibt nur in die lokale DB (kein Nitrado-Write) und bleibt ungated.
  if ((direction === 'push' || direction === 'merge') && onlyLocal.length + (direction === 'push' ? onlyRemote.length : 0) > 0) {
    if (!ensureNitradoWriteAllowed(req, res, { action: 'NITRADO_WHITELIST_SYNC_PUSH', danger: false })) return;
  }

  let dbInserted = 0, dbDeleted = 0, jobsCreated = 0;

  if (direction === 'pull' || direction === 'merge') {
    // Nitrado -> DB: onlyRemote in DB einfuegen
    for (const name of onlyRemote) {
      try {
        await prisma.whitelistEntry.create({
          data: {
            guildId: scope.guildId, nitradoConnId: connId, gameId: name,
            source: 'IMPORT', approvedByDiscordId: scope.actorDiscordId,
          },
        });
        dbInserted++;
      } catch (e) {
        if ((e as { code?: string }).code !== 'P2002') throw e;
      }
    }
  }
  if (direction === 'pull') {
    // pull: lokal ueberzaehlige loeschen
    if (onlyLocal.length > 0) {
      const r = await prisma.whitelistEntry.deleteMany({
        where: { guildId: scope.guildId, nitradoConnId: connId, gameId: { in: onlyLocal } },
      });
      dbDeleted = r.count;
      // Cap-Reset fuer alle betroffenen User
      await prisma.whitelistRequest.updateMany({
        where: { guildId: scope.guildId, nitradoConnId: connId, gameId: { in: onlyLocal }, status: 'APPROVED' },
        data: { status: 'CANCELLED' },
      });
    }
  }
  if (direction === 'push' || direction === 'merge') {
    // DB -> Nitrado: pro onlyLocal-Eintrag ein WHITELIST_ADD-Job
    // (Worker serialisiert pro Connection, daher kein Datenverlust)
    for (const name of onlyLocal) {
      await prisma.nitradoJob.create({
        data: {
          guildId: scope.guildId, nitradoConnId: connId,
          operation: 'WHITELIST_ADD', payload: { gameId: name },
        },
      });
      jobsCreated++;
    }
  }
  if (direction === 'push') {
    // push: in Nitrado ueberzaehlige entfernen
    for (const name of onlyRemote) {
      await prisma.nitradoJob.create({
        data: {
          guildId: scope.guildId, nitradoConnId: connId,
          operation: 'WHITELIST_REMOVE', payload: { gameId: name },
        },
      });
      jobsCreated++;
    }
  }

  logAuditDb('WHITELIST_SYNC', 'WHITELIST', {
    actorUserId: req.auth!.userId, guildId: scope.guildId,
    details: { direction, dbInserted, dbDeleted, jobsCreated, ...diff.counts },
  });
  emitGuildEvent(scope.guildId, { type: 'whitelist.changed', payload: { guildId: scope.guildId, action: 'added' } });
  res.json({ ok: true, applied: true, diff, dbInserted, dbDeleted, jobsCreated });
});

/**
 * GET /channels  Owner: liefert die 4 Whitelist-Kanal-IDs.
 */
whitelistRouter.get('/channels', requireGuildPermission('whitelist.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const connId = await activeSlotId(scope.guildId, req.query.slot);
  if (!connId) { res.status(404).json({ error: 'Kein Nitrado-Slot.' }); return; }
  const settings = await prisma.serverSettings.findUnique({
    where: { guildId_nitradoConnId: { guildId: scope.guildId, nitradoConnId: connId } },
  });
  res.json({
    infoChannelId: settings?.whitelistChannelId ?? null,
    requestChannelId: settings?.whitelistRequestChannelId ?? null,
    approveLogChannelId: settings?.whitelistApproveLogChannelId ?? null,
    denyLogChannelId: settings?.whitelistDenyLogChannelId ?? null,
    infoMessageId: settings?.whitelistInfoMessageId ?? null,
  });
});

/**
 * PUT /channels  Owner: setzt eine oder mehrere Kanal-IDs.
 * body: { infoChannelId?, requestChannelId?, approveLogChannelId?, denyLogChannelId? }
 * (null = entfernen). Wenn infoChannelId gesetzt/geaendert wird, wird das
 * Info-Embed automatisch (re)posted.
 */
whitelistRouter.put('/channels', requireGuildPermission('whitelist.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const connId = await activeSlotId(scope.guildId, req.query.slot);
  if (!connId) { res.status(404).json({ error: 'Kein Nitrado-Slot.' }); return; }

  const body = req.body ?? {};
  const validateId = (v: unknown): string | null | undefined => {
    if (v === undefined) return undefined;
    if (v === null || v === '') return null;
    if (typeof v !== 'string' || !/^\d{17,20}$/.test(v)) {
      throw new Error('Ungueltige Channel-ID');
    }
    return v;
  };

  let upd: Record<string, string | null>;
  try {
    upd = {};
    const i = validateId(body.infoChannelId);          if (i !== undefined) upd.whitelistChannelId = i;
    const r = validateId(body.requestChannelId);       if (r !== undefined) upd.whitelistRequestChannelId = r;
    const a = validateId(body.approveLogChannelId);    if (a !== undefined) upd.whitelistApproveLogChannelId = a;
    const d = validateId(body.denyLogChannelId);       if (d !== undefined) upd.whitelistDenyLogChannelId = d;
  } catch (e) {
    res.status(400).json({ error: (e as Error).message }); return;
  }

  // Wenn Info-Channel veraendert wird, alte Nachricht im ALTEN Kanal loeschen
  // und messageId zuruecksetzen, sonst bleiben verwaiste Embeds zurueck.
  const before = await prisma.serverSettings.findUnique({
    where: { guildId_nitradoConnId: { guildId: scope.guildId, nitradoConnId: connId } },
  });
  if ('whitelistChannelId' in upd && upd.whitelistChannelId !== before?.whitelistChannelId) {
    if (before?.whitelistChannelId && before.whitelistInfoMessageId) {
      try {
        const { deleteOldInfoEmbed } = await import('../../../modules/whitelist/whitelistChannels.js');
        await deleteOldInfoEmbed(scope.guildId, before.whitelistChannelId, before.whitelistInfoMessageId);
      } catch (e) {
        logger.warn(`Whitelist: Alte Info-Embed-Loeschung fehlgeschlagen: ${(e as Error).message}`);
      }
    }
    upd.whitelistInfoMessageId = null;
  }

  const after = await prisma.serverSettings.upsert({
    where: { guildId_nitradoConnId: { guildId: scope.guildId, nitradoConnId: connId } },
    create: { guildId: scope.guildId, nitradoConnId: connId, ...upd },
    update: upd,
  });

  // Auto-Post Info-Embed wenn InfoChannel gesetzt
  let infoResult: { posted: boolean; updated: boolean; messageId?: string } | null = null;
  if (after.whitelistChannelId) {
    try {
      const { ensureWhitelistInfoEmbed } = await import('../../../modules/whitelist/whitelistChannels.js');
      infoResult = await ensureWhitelistInfoEmbed(scope.guildId, connId);
    } catch (e) {
      logger.warn(`Whitelist-Info-Embed Post fehlgeschlagen: ${(e as Error).message}`);
    }
  }

  logAuditDb('WHITELIST_CHANNELS_SET', 'WHITELIST', {
    actorUserId: req.auth!.userId, guildId: scope.guildId,
    details: { upd, infoResult },
  });

  res.json({
    ok: true,
    infoChannelId: after.whitelistChannelId,
    requestChannelId: after.whitelistRequestChannelId,
    approveLogChannelId: after.whitelistApproveLogChannelId,
    denyLogChannelId: after.whitelistDenyLogChannelId,
    infoMessageId: after.whitelistInfoMessageId,
    infoResult,
  });
});

/**
 * POST /channels/info/repost  Owner: postet das Info-Embed neu (loescht ggf. das alte).
 */
whitelistRouter.post('/channels/info/repost', requireGuildPermission('whitelist.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const connId = await activeSlotId(scope.guildId, req.query.slot);
  if (!connId) { res.status(404).json({ error: 'Kein Nitrado-Slot.' }); return; }
  // Alte Nachricht im aktuellen Info-Kanal loeschen, dann MessageId reset
  const cur = await prisma.serverSettings.findUnique({
    where: { guildId_nitradoConnId: { guildId: scope.guildId, nitradoConnId: connId } },
  });
  if (cur?.whitelistChannelId && cur.whitelistInfoMessageId) {
    try {
      const { deleteOldInfoEmbed } = await import('../../../modules/whitelist/whitelistChannels.js');
      await deleteOldInfoEmbed(scope.guildId, cur.whitelistChannelId, cur.whitelistInfoMessageId);
    } catch { /* nicht-fatal */ }
  }
  await prisma.serverSettings.updateMany({
    where: { guildId: scope.guildId, nitradoConnId: connId },
    data: { whitelistInfoMessageId: null },
  });
  try {
    const { ensureWhitelistInfoEmbed } = await import('../../../modules/whitelist/whitelistChannels.js');
    const r = await ensureWhitelistInfoEmbed(scope.guildId, connId);
    res.json({ ok: true, ...r });
  } catch (e) {
    logger.error('ensureWhitelistInfoEmbed Fehler:', e as Error);
    res.status(500).json({ error: 'Interner Fehler' });
  }
});
