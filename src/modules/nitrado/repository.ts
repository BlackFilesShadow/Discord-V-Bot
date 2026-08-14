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
  const row = await prisma.nitradoConnection.create({
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
  return rowToConn(row);
}

export async function deleteSlot(guildId: GuildId, slot: number): Promise<NitradoConnId | null> {
  const row = await prisma.nitradoConnection.findUnique({
    where: { guildId_slot: { guildId, slot } },
    select: { id: true },
  });
  if (!row) return null;

  // Diagnosezustand und Connection gemeinsam entfernen. Kein unmodellierter
  // DB-FK noetig; Prisma-Schema und physische DB bleiben drift-frei.
  await prisma.$transaction([
    prisma.nitradoValidationHealth.deleteMany({ where: { guildId, nitradoConnId: row.id } }),
    prisma.nitradoConnection.deleteMany({ where: { id: row.id, guildId } }),
  ]);
  return asNitradoConnId(row.id);
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

/** Markiert eine Verbindung nach erfolgreicher Token-Pruefung als ACTIVE,
 *  vermerkt den Validierungszeitpunkt und beginnt einen neuen Diagnose-Streak. */
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
 * Setzt Status zurueck auf ACTIVE (z.B. wenn vorher EXPIRED war) und loescht
 * den vorherigen Validierungsfehler-Streak.
 * Caller MUSS den neuen Token vorher gegen die Nitrado-API validiert haben.
 */
export async function updateToken(
  guildId: GuildId,
  slot: number,
  rawToken: string,
): Promise<NitradoConnectionRow | null> {
  if (!rawToken || rawToken.length < 8) throw new Error('Token leer/zu kurz');
  const encryptedToken = encrypt(rawToken, config.security.encryptionKey);
  const current = await prisma.nitradoConnection.findUnique({
    where: { guildId_slot: { guildId, slot } },
    select: { id: true },
  });
  if (!current) return null;

  await prisma.$transaction([
    prisma.nitradoConnection.updateMany({
      where: { guildId, slot },
      data: { encryptedToken, status: 'ACTIVE', lastErrorMessage: null },
    }),
    prisma.nitradoValidationHealth.updateMany({
      where: { guildId, nitradoConnId: current.id },
      data: {
        failureCount: 0,
        lastErrorMessage: null,
        lastFailureAt: null,
        lastAlertAt: null,
      },
    }),
  ]);

  const row = await prisma.nitradoConnection.findUnique({
    where: { guildId_slot: { guildId, slot } },
  });
  return row ? rowToConn(row) : null;
}

/**
 * Aktualisiert die verknuepfte Nitrado-Service-ID (oder loescht sie via null).
 * Ohne Service-ID kann der Slot keine Whitelist-/ADM-Operationen ausfuehren.
 */
export async function updateServiceId(
  guildId: GuildId,
  slot: number,
  nitradoServerId: string | null,
): Promise<NitradoConnectionRow | null> {
  if (nitradoServerId !== null) {
    const trimmed = nitradoServerId.trim();
    if (!/^\d{1,20}$/.test(trimmed)) throw new Error('Service-ID muss numerisch sein (1..20 Stellen)');
    nitradoServerId = trimmed;
  }
  const updated = await prisma.nitradoConnection.updateMany({
    where: { guildId, slot },
    // NIT-012: nitradoServerId ist kanonisch; serviceId wird gespiegelt, damit
    // die beiden Felder nicht divergieren (Mirror/Dev lesen serviceId).
    data: { nitradoServerId, serviceId: nitradoServerId },
  });
  if (updated.count === 0) return null;
  const row = await prisma.nitradoConnection.findUnique({
    where: { guildId_slot: { guildId, slot } },
  });
  return row ? rowToConn(row) : null;
}

/**
 * Aktualisiert nur das frei waehlbare Anzeige-Alias eines Slots.
 * `alias5` ist unveraenderlich (eindeutige System-Kennung).
 */
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
