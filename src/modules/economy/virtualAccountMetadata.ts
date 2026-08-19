import { randomUUID } from 'node:crypto';
import prisma from '../../database/prisma';
import type { GuildId, NitradoConnId, UserDiscordId } from '../../types/scope';
import { assertEconomyScopeReady } from './scopeMigration';
import {
  getVirtualAccountById,
  normalizeVirtualAccountName,
  type VirtualAccountRow,
} from './virtualAccounts';

export interface VirtualAccountMetadata {
  accountId: string;
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  description: string | null;
  channelId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface DbMetadataRow {
  accountId: string;
  guildId: string;
  nitradoConnId: string;
  description: string | null;
  channelId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface RawDb {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

const DESCRIPTION_MAX = 280;
const CHANNEL_ID_RE = /^\d{17,20}$/;

function rawDb(client: unknown = prisma): RawDb {
  return client as RawDb;
}

function toMetadata(row: DbMetadataRow): VirtualAccountMetadata {
  return {
    ...row,
    guildId: row.guildId as GuildId,
    nitradoConnId: row.nitradoConnId as NitradoConnId,
  };
}

export function normalizeVirtualAccountDescription(input: unknown): string | null {
  if (input === undefined || input === null || input === '') return null;
  if (typeof input !== 'string') throw new Error('Beschreibung muss String oder null sein.');
  const normalized = input.normalize('NFKC');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)) {
    throw new Error(`Beschreibung darf keine Steuerzeichen enthalten und maximal ${DESCRIPTION_MAX} Zeichen lang sein.`);
  }
  const clean = normalized.trim().replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
  if (!clean) return null;
  if (clean.length > DESCRIPTION_MAX) {
    throw new Error(`Beschreibung darf maximal ${DESCRIPTION_MAX} Zeichen lang sein.`);
  }
  return clean;
}

export function normalizeVirtualAccountChannelId(input: unknown): string | null {
  if (input === undefined || input === null || input === '') return null;
  if (typeof input !== 'string') throw new Error('Channel-ID muss String oder null sein.');
  const clean = input.trim();
  if (!CHANNEL_ID_RE.test(clean)) throw new Error('Channel-ID ist ungueltig.');
  return clean;
}

export async function getVirtualAccountMetadata(
  guildId: GuildId,
  nitradoConnId: NitradoConnId,
  accountId: string,
): Promise<VirtualAccountMetadata | null> {
  const rows = await rawDb().$queryRawUnsafe<DbMetadataRow[]>(
    'SELECT "accountId", "guildId", "nitradoConnId", "description", "channelId", "createdAt", "updatedAt" FROM "EconomyVirtualAccountMetadata" WHERE "accountId"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 LIMIT 1',
    accountId, String(guildId), String(nitradoConnId),
  );
  return rows[0] ? toMetadata(rows[0]) : null;
}

export async function getVirtualAccountMetadataMap(
  guildId: GuildId,
  nitradoConnId: NitradoConnId,
): Promise<Map<string, VirtualAccountMetadata>> {
  const rows = await rawDb().$queryRawUnsafe<DbMetadataRow[]>(
    'SELECT "accountId", "guildId", "nitradoConnId", "description", "channelId", "createdAt", "updatedAt" FROM "EconomyVirtualAccountMetadata" WHERE "guildId"=$1 AND "nitradoConnId"=$2',
    String(guildId), String(nitradoConnId),
  );
  return new Map(rows.map(row => [row.accountId, toMetadata(row)]));
}

export async function createCustomVirtualAccountWithMetadata(args: {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  name: string;
  description?: unknown;
  channelId?: unknown;
  expiresAt?: Date | null;
  acceptUserTransfers?: boolean;
  createdByDiscordId: UserDiscordId;
}): Promise<{ account: VirtualAccountRow; metadata: VirtualAccountMetadata }> {
  const { name, nameKey } = normalizeVirtualAccountName(args.name);
  const description = normalizeVirtualAccountDescription(args.description);
  const channelId = normalizeVirtualAccountChannelId(args.channelId);
  if (args.expiresAt && args.expiresAt.getTime() <= Date.now()) throw new Error('Ablaufzeit muss in der Zukunft liegen.');
  await assertEconomyScopeReady(args.guildId, args.nitradoConnId);

  const accountId = randomUUID();
  try {
    await prisma.$transaction(async tx => {
      const raw = rawDb(tx);
      const accountChanged = await raw.$executeRawUnsafe(
        'INSERT INTO "EconomyVirtualAccount" ("id", "guildId", "nitradoConnId", "kind", "name", "nameKey", "balance", "status", "acceptUserTransfers", "expiresAt", "archivedAt", "archivedByDiscordId", "createdByDiscordId", "createdAt", "updatedAt") VALUES ($1,$2,$3,\'CUSTOM\'::"EconomyVirtualAccountKind",$4,$5,0,\'ACTIVE\'::"EconomyVirtualAccountStatus",$6,$7,NULL,NULL,$8,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)',
        accountId, String(args.guildId), String(args.nitradoConnId), name, nameKey,
        args.acceptUserTransfers ?? true, args.expiresAt ?? null, String(args.createdByDiscordId),
      );
      if (accountChanged !== 1) throw new Error('Virtuelles Konto konnte nicht erstellt werden.');

      const metadataChanged = await raw.$executeRawUnsafe(
        'INSERT INTO "EconomyVirtualAccountMetadata" ("accountId", "guildId", "nitradoConnId", "description", "channelId", "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,$5,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)',
        accountId, String(args.guildId), String(args.nitradoConnId), description, channelId,
      );
      if (metadataChanged !== 1) throw new Error('Metadaten des virtuellen Kontos konnten nicht erstellt werden.');
    });
  } catch (error) {
    const candidate = typeof error === 'object' && error !== null
      ? error as { code?: string; meta?: { code?: string } }
      : {};
    if (candidate.code === '23505' || candidate.code === 'P2002' || candidate.meta?.code === '23505') {
      throw new Error('Ein virtuelles Konto mit diesem Namen existiert bereits auf diesem Gameserver.');
    }
    throw error;
  }

  const [account, metadata] = await Promise.all([
    getVirtualAccountById(args.guildId, args.nitradoConnId, accountId),
    getVirtualAccountMetadata(args.guildId, args.nitradoConnId, accountId),
  ]);
  if (!account || !metadata) throw new Error('Virtuelles Konto wurde erstellt, konnte aber nicht konsistent gelesen werden.');
  return { account, metadata };
}
