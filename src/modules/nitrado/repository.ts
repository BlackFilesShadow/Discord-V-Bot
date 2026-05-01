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
  if (!args.alias || args.alias.length > 64) throw new Error('Alias 1..64 Zeichen');
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
  await prisma.nitradoConnection.deleteMany({ where: { id: row.id, guildId } }); // Cascade greift
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
