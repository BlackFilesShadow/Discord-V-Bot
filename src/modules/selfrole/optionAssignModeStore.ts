import { Prisma } from '@prisma/client';
import prisma from '../../database/prisma';

export type OptionAssignMode = 'GIVE' | 'REMOVE' | 'TOGGLE';

export function normalizeOptionAssignMode(value: unknown): OptionAssignMode | null {
  return value === 'GIVE' || value === 'REMOVE' || value === 'TOGGLE' ? value : null;
}

export async function getOptionAssignModeMap(optionIds: string[]): Promise<Map<string, OptionAssignMode>> {
  const ids = [...new Set(optionIds.filter(Boolean))];
  if (ids.length === 0 || typeof prisma.$queryRaw !== 'function') return new Map();
  const rows = await prisma.$queryRaw<Array<{ optionId: string; assignMode: string }>>(
    Prisma.sql`SELECT "optionId", "assignMode" FROM "SelfRoleOptionBehavior" WHERE "optionId" IN (${Prisma.join(ids)})`,
  );
  const result = new Map<string, OptionAssignMode>();
  for (const row of rows) {
    const mode = normalizeOptionAssignMode(row.assignMode);
    if (mode) result.set(row.optionId, mode);
  }
  return result;
}

export async function setOptionAssignMode(optionId: string, mode: OptionAssignMode | null): Promise<void> {
  if (!optionId || typeof prisma.$executeRaw !== 'function') return;
  if (!mode) {
    await prisma.$executeRaw`DELETE FROM "SelfRoleOptionBehavior" WHERE "optionId" = ${optionId}`;
    return;
  }
  await prisma.$executeRaw`
    INSERT INTO "SelfRoleOptionBehavior" ("optionId", "assignMode", "updatedAt")
    VALUES (${optionId}, ${mode}, NOW())
    ON CONFLICT ("optionId") DO UPDATE SET "assignMode" = EXCLUDED."assignMode", "updatedAt" = NOW()
  `;
}
