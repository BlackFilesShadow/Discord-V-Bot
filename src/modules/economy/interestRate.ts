import prisma from '../../database/prisma';
import { MAX_INTEREST_BASIS_POINTS, normalizeInterestBasisPoints } from './bankInterest';

interface RawDb {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

function rawDb(client: unknown = prisma): RawDb {
  return client as RawDb;
}

/** Parse 0..100 with at most two decimal places into basis points. */
export function parseInterestPercent(value: unknown): number {
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error('bankInterestPercent fehlt.');
  const text = String(value).trim().replace(',', '.');
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) throw new Error('bankInterestPercent muss 0..100 mit maximal zwei Nachkommastellen sein.');
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? '').padEnd(2, '0') || '0');
  const basisPoints = whole * 100 + fraction;
  if (basisPoints > MAX_INTEREST_BASIS_POINTS) throw new Error('bankInterestPercent darf maximal 100,00 sein.');
  return normalizeInterestBasisPoints(basisPoints);
}

/** Nur fuer API/UI-Darstellung; Geldberechnung nutzt immer BasisPoints+BigInt. */
export function interestBasisPointsToPercent(basisPoints: number): number {
  return normalizeInterestBasisPoints(basisPoints) / 100;
}

export async function getInterestBasisPoints(guildId: string, nitradoConnId: string, client: unknown = prisma): Promise<number> {
  const rows = await rawDb(client).$queryRawUnsafe<Array<{ bankInterestBasisPoints: number; bankInterestPercent: number }>>(
    'SELECT "bankInterestBasisPoints", "bankInterestPercent" FROM "EconomyConfig" WHERE "guildId"=$1 AND "nitradoConnId"=$2 LIMIT 1',
    guildId,
    nitradoConnId,
  );
  if (!rows[0]) return 0;
  return normalizeInterestBasisPoints(rows[0].bankInterestBasisPoints ?? rows[0].bankInterestPercent * 100);
}

export async function setInterestBasisPoints(
  guildId: string,
  nitradoConnId: string,
  basisPoints: number,
  client: unknown = prisma,
): Promise<void> {
  const bp = normalizeInterestBasisPoints(basisPoints);
  const changed = await rawDb(client).$executeRawUnsafe(
    'UPDATE "EconomyConfig" SET "bankInterestBasisPoints"=$3, "bankInterestPercent"=$4, "updatedAt"=CURRENT_TIMESTAMP WHERE "guildId"=$1 AND "nitradoConnId"=$2',
    guildId,
    nitradoConnId,
    bp,
    Math.floor(bp / 100),
  );
  if (changed !== 1) throw new Error('Bankzinssatz konnte nicht gespeichert werden.');
}
