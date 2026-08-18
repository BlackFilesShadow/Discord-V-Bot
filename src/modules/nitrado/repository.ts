/**
 * Nitrado-Connection-Repository — pro Guild bis zu 5 Slots.
 *
 * Token wird AES-256-GCM verschluesselt via `utils/security.encrypt`,
 * niemals roh in der DB, niemals roh im Log.
 */

import prisma from '../../database/prisma';
import { config } from '../../config';
import { encrypt, decrypt } from '../../utils/security';
import type { GuildId, NitradoConnId, UserDiscordId } from '../../types/scope';
import { asNitradoConnId } from '../../types/scope';
import type { NitradoConnectionStatus } from '@prisma/client';
import { tryAcquireNitradoConfigMutationLock } from './configMutationLock';
import { syncAdmBindingState, type AdmBindingStateClient } from './adm/bindingState';

export interface NitradoConnectionRow {
  id: NitradoConnId;
  guildId: GuildId;
  slot: number;
  alias: string;
  alias5: string;
  nitradoServerId: string | null;
  status: NitradoConnectionStatus;
  addedBy: UserDiscordId;
  createdAt: Date;
  updatedAt: Date;
}

export class NitradoSlotVersionConflictError extends Error {
  constructor() {
    super('Nitrado-Slot wurde waehrend der Validierung parallel geaendert.');
    this.name = 'NitradoSlotVersionConflictError';
  }
}

export class NitradoConnectionBusyError extends Error {
  constructor() {
    super('Nitrado-Connection wird gerade von einem Remote-Job verwendet.');
    this.name = 'NitradoConnectionBusyError';
  }
}

async function withConfigMutationLock<T>(
  nitradoConnId: NitradoConnId,
  work: () => Promise<T>,
): Promise<T> {
  const lock = await tryAcquireNitradoConfigMutationLock(nitradoConnId);
  if (!lock) throw new NitradoConnectionBusyError();
  try {
    return await work();
  } finally {
    await lock.release();
  }
}

function rowToConn(r: {
  id: string;
  guildId: string;
  slot: number;
  alias: string;
  alias5: string;
  nitradoServerId: string | null;
  status: NitradoConnectionStatus;
  addedByDiscordId: string;
  createdAt: Date;
  updatedAt: Date;
}): NitradoConnectionRow {
  return {
    id: r.id as NitradoConnId,
    guildId: r.guildId as GuildId,
    slot: r.slot,
    alias: r.alias,
    alias5: r.alias5,
    nitradoServerId: r.nitradoServerId,
    status: r.status,
    addedBy: r.addedByDiscordId as UserDiscordId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function gen5(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ohne O/0/I/1
  let out = '';
  for (let i = 0; i < 5; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

async function uniqueAlias5(): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const c = gen5();
    // eslint-disable-next-line local/no-unscoped-prisma-query -- alias5 ist global eindeutig
    const exists = await prisma.nitradoConnection.findUnique({ where: { alias5: c } });
    if (!exists) return c;
  }
  throw new Error('Konnte keinen freien 5-Identifier generieren');
}

export async function listSlots(guildId: GuildId): Promise<NitradoConnectionRow[]> {
  const rows = await prisma.nitradoConnection.findMany({
    where: { guildId },
    orderBy: { slot: 'asc' },
  });
  return rows.map(rowToConn);
}

export async function getSlot(guildId: GuildId, slot: number): Promise<NitradoConnectionRow | null> {
  const row = await prisma.nitradoConnection.findUnique({
    where: { guildId_slot: { guildId, slot } },
  });
  return row ? rowToConn(row) : null;
}

export async function getById(guildId: GuildId, id: NitradoConnId): Promise<NitradoConnectionRow | null> {
  const row = await prisma.nitradoConnection.findFirst({
    where: { id, guildId }, // Cross-Scope-Lock
  });
  return row ? rowToConn(row) : null;
}

export async function getDecryptedToken(guildId: GuildId, id: NitradoConnId): Promise<string> {
  const row = await prisma.nitradoConnection.findFirst({
    where: { id, guildId },
    select: { encryptedToken: true },
  });
  if (!row) throw new Error('Nitrado-Connection nicht gefunden oder anderer Guild');
  return decrypt(row.encryptedToken, config.security.encryptionKey);
}

export async function createSlot(args: {
  guildId: GuildId;
  slot: number;
  alias: string;
  rawToken: string;
  nitradoServerId: string | null;
  addedBy: UserDiscordId;
}): Promise<NitradoConnectionRow> {
  if (args.slot < 1 || args.slot > 5) throw new Error('Slot muss 1..5 sein');
  if (!args.alias || args.alias.length < 1 || args.alias.length > 40) throw new Error('Alias 1..40 Zeichen');
  const encryptedToken = encrypt(args.rawToken, config.security.encryptionKey);
  const alias5 = await uniqueAlias5();
  const row = await prisma.$transaction(async tx => {
    const created = await tx.nitradoConnection.create({
      data: {
        guildId: args.guildId,
        slot: args.slot,
        alias: args.alias,
        alias5,
        encryptedToken,
        nitradoServerId: args.nitradoServerId,
        addedByDiscordId: args.addedBy,
        status: 'ACTIVE',
      },
    });
    await syncAdmBindingState(
      tx as unknown as AdmBindingStateClient,
      { guildId: args.guildId, nitradoConnId: created.id },
      args.nitradoServerId,
    );
    return created;
  });
  return rowToConn(row);
}

export async function deleteSlot(guildId: GuildId, slot: number): Promise<NitradoConnId | null> {
  const row = await prisma.nitradoConnection.findUnique({
    where: { guildId_slot: { guildId, slot } },
    select: { id: true },
  });
  if (!row) return null;
  const targetId = asNitradoConnId(row.id);

  return withConfigMutationLock(targetId, async () => {
    // Delete+Recreate desselben Slot-Indexes darf von einer alten Delete-Anfrage
    // niemals getroffen werden. Nach gewonnenem Lock deshalb exakt den zuvor
    // gelesenen Connection-Datensatz erneut verifizieren.
    const current = await prisma.nitradoConnection.findFirst({
      where: { id: targetId, guildId, slot },
      select: { id: true },
    });
    if (!current) return null;

    const scopedKnowledge = await prisma.guildKnowledgeScope.findMany({
      where: { guildId, nitradoConnId: targetId },
      select: { knowledgeId: true },
    });
    const knowledgeIds = scopedKnowledge.map((entry) => entry.knowledgeId);

    await prisma.$transaction([
      ...(knowledgeIds.length > 0
        ? [
            prisma.guildKnowledgeProvenance.deleteMany({ where: { guildId, knowledgeId: { in: knowledgeIds } } }),
            prisma.guildKnowledge.deleteMany({ where: { guildId, id: { in: knowledgeIds } } }),
          ]
        : []),
      prisma.guildKnowledgeScope.deleteMany({ where: { guildId, nitradoConnId: targetId } }),
      prisma.nitradoValidationHealth.deleteMany({ where: { guildId, nitradoConnId: targetId } }),
      prisma.nitradoAdmBindingState.deleteMany({ where: { guildId, nitradoConnId: targetId } }),
      prisma.nitradoConnection.deleteMany({ where: { id: targetId, guildId, slot } }),
    ]);
    return targetId;
  });
}

export async function setStatus(
  guildId: GuildId,
  id: NitradoConnId,
  status: NitradoConnectionStatus,
): Promise<void> {
  await prisma.nitradoConnection.updateMany({
    where: { id, guildId },
    data: { status },
  });
}

export async function markValidated(
  guildId: GuildId,
  id: NitradoConnId,
): Promise<void> {
  await prisma.$transaction([
    prisma.nitradoConnection.updateMany({
      where: { id, guildId },
      data: { status: 'ACTIVE', lastValidatedAt: new Date(), lastErrorMessage: null },
    }),
    prisma.nitradoValidationHealth.updateMany({
      where: { guildId, nitradoConnId: id },
      data: {
        failureCount: 0,
        lastErrorMessage: null,
        lastFailureAt: null,
        lastAlertAt: null,
      },
    }),
  ]);
}

/**
 * Tauscht den verschluesselten Token eines existierenden Slots aus.
 *
 * `expectedId + expectedUpdatedAt` bilden den exakt remote validierten
 * Slot-Snapshot. Damit kann weder eine parallele Aenderung noch Delete+Recreate
 * desselben Slot-Namens unbemerkt mit dem neuen Token vermischt werden.
 * Zusaetzlich serialisiert derselbe Advisory-Key wie im NitradoJob-Worker den
 * Commit gegen bereits laufende Remote-Jobs.
 */
export async function updateToken(
  guildId: GuildId,
  slot: number,
  rawToken: string,
  options: {
    resetServiceId?: boolean;
    expectedId?: NitradoConnId;
    expectedUpdatedAt?: Date;
  } = {},
): Promise<NitradoConnectionRow | null> {
  if (!rawToken || rawToken.length < 8) throw new Error('Token leer/zu kurz');
  const encryptedToken = encrypt(rawToken, config.security.encryptionKey);
  const current = await prisma.nitradoConnection.findUnique({
    where: { guildId_slot: { guildId, slot } },
    select: { id: true },
  });
  if (!current) return null;
  if (options.expectedId && current.id !== options.expectedId) {
    throw new NitradoSlotVersionConflictError();
  }

  const targetId = options.expectedId ?? asNitradoConnId(current.id);
  return withConfigMutationLock(targetId, async () => {
    const resetServiceId = options.resetServiceId === true;
    const changed = await prisma.$transaction(async tx => {
      const exactWhere = {
        guildId,
        slot,
        id: targetId,
        ...(options.expectedUpdatedAt ? { updatedAt: options.expectedUpdatedAt } : {}),
      };
      const before = await tx.nitradoConnection.findFirst({
        where: exactWhere,
        select: { nitradoServerId: true },
      });
      if (!before) {
        if (options.expectedId || options.expectedUpdatedAt) throw new NitradoSlotVersionConflictError();
        return false;
      }
      if (resetServiceId) {
        await syncAdmBindingState(
          tx as unknown as AdmBindingStateClient,
          { guildId, nitradoConnId: targetId },
          before.nitradoServerId,
        );
      }

      const updated = await tx.nitradoConnection.updateMany({
        where: exactWhere,
        data: {
          encryptedToken,
          status: 'ACTIVE',
          lastErrorMessage: null,
          ...(resetServiceId ? { nitradoServerId: null, serviceId: null } : {}),
        },
      });
      if (updated.count !== 1) {
        if (options.expectedId || options.expectedUpdatedAt) throw new NitradoSlotVersionConflictError();
        return false;
      }

      if (resetServiceId) {
        await syncAdmBindingState(
          tx as unknown as AdmBindingStateClient,
          { guildId, nitradoConnId: targetId },
          null,
        );
        if (before.nitradoServerId !== null) {
          await tx.nitradoAdmProfileConfig.updateMany({
            where: { guildId, nitradoConnId: targetId },
            data: { lastVerifiedAt: null, lastError: null },
          });
        }
      }

      await tx.nitradoValidationHealth.updateMany({
        where: { guildId, nitradoConnId: targetId },
        data: {
          failureCount: 0,
          lastErrorMessage: null,
          lastFailureAt: null,
          lastAlertAt: null,
        },
      });
      return true;
    });
    if (!changed) return null;

    const row = await prisma.nitradoConnection.findFirst({
      where: { id: targetId, guildId, slot },
    });
    return row ? rowToConn(row) : null;
  });
}

/**
 * Aktualisiert die verknuepfte Nitrado-Service-ID (oder loescht sie via null).
 * `expectedId + expectedUpdatedAt` binden den Write an exakt den Slot-Snapshot,
 * dessen Token kurz zuvor fuer die Service-Zugehoerigkeitspruefung verwendet
 * wurde. Ein Delete+Recreate desselben Slot-Indexes verliert damit den CAS.
 * Der Connection-Lock verhindert parallel laufende Worker-Remotezugriffe.
 */
export async function updateServiceId(
  guildId: GuildId,
  slot: number,
  nitradoServerId: string | null,
  options: { expectedId?: NitradoConnId; expectedUpdatedAt?: Date } = {},
): Promise<NitradoConnectionRow | null> {
  if (nitradoServerId !== null) {
    const trimmed = nitradoServerId.trim();
    if (!/^\d{1,20}$/.test(trimmed)) throw new Error('Service-ID muss numerisch sein (1..20 Stellen)');
    nitradoServerId = trimmed;
  }

  const current = await prisma.nitradoConnection.findUnique({
    where: { guildId_slot: { guildId, slot } },
    select: { id: true },
  });
  if (!current) return null;
  if (options.expectedId && current.id !== options.expectedId) {
    throw new NitradoSlotVersionConflictError();
  }
  const targetId = options.expectedId ?? asNitradoConnId(current.id);

  return withConfigMutationLock(targetId, async () => {
    const changed = await prisma.$transaction(async tx => {
      const exactWhere = {
        guildId,
        slot,
        id: targetId,
        ...(options.expectedUpdatedAt ? { updatedAt: options.expectedUpdatedAt } : {}),
      };
      const before = await tx.nitradoConnection.findFirst({
        where: exactWhere,
        select: { nitradoServerId: true },
      });
      if (!before) {
        if (options.expectedId || options.expectedUpdatedAt) throw new NitradoSlotVersionConflictError();
        return false;
      }

      await syncAdmBindingState(
        tx as unknown as AdmBindingStateClient,
        { guildId, nitradoConnId: targetId },
        before.nitradoServerId,
      );

      const updated = await tx.nitradoConnection.updateMany({
        where: exactWhere,
        data: { nitradoServerId, serviceId: nitradoServerId },
      });
      if (updated.count !== 1) {
        if (options.expectedId || options.expectedUpdatedAt) throw new NitradoSlotVersionConflictError();
        return false;
      }

      await syncAdmBindingState(
        tx as unknown as AdmBindingStateClient,
        { guildId, nitradoConnId: targetId },
        nitradoServerId,
      );
      if (before.nitradoServerId !== nitradoServerId) {
        await tx.nitradoAdmProfileConfig.updateMany({
          where: { guildId, nitradoConnId: targetId },
          data: { lastVerifiedAt: null, lastError: null },
        });
      }
      return true;
    });
    if (!changed) return null;

    const row = await prisma.nitradoConnection.findFirst({
      where: { id: targetId, guildId, slot },
    });
    return row ? rowToConn(row) : null;
  });
}

export async function updateAlias(
  guildId: GuildId,
  slot: number,
  alias: string,
): Promise<NitradoConnectionRow | null> {
  const trimmed = alias.trim();
  if (trimmed.length < 1 || trimmed.length > 40) throw new Error('Alias 1..40 Zeichen');
  const updated = await prisma.nitradoConnection.updateMany({
    where: { guildId, slot },
    data: { alias: trimmed },
  });
  if (updated.count === 0) return null;
  const row = await prisma.nitradoConnection.findUnique({
    where: { guildId_slot: { guildId, slot } },
  });
  return row ? rowToConn(row) : null;
}
