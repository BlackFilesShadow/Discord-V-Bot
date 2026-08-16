import prisma from '../../database/prisma';
import type { GuildId, NitradoConnId, UserDiscordId } from '../../types/scope';
import { logAudit } from '../../utils/logger';
import { MAX_GAME_SERVERS_PER_GUILD } from '../nitrado/gameServerScope';

export type EconomyScopeMigrationStatus = 'MIGRATION_REQUIRED' | 'RESOLVED';

export interface EconomyScopeMigrationState {
  guildId: GuildId;
  status: EconomyScopeMigrationStatus;
  primaryNitradoConnId: NitradoConnId | null;
  detectedActiveServerCount: number;
  resolvedByDiscordId: UserDiscordId | null;
  resolvedAt: Date | null;
}

export class EconomyMigrationRequiredError extends Error {
  readonly code = 'ECONOMY_MIGRATION_REQUIRED';
  constructor(message = 'Die Legacy-Economy muss zuerst einem Gameserver zugeordnet werden.') {
    super(message);
    this.name = 'EconomyMigrationRequiredError';
  }
}

export class EconomyScopeMismatchError extends Error {
  readonly code = 'ECONOMY_SCOPE_MISMATCH';
  constructor(message = 'Die Legacy-Economy ist einem anderen Gameserver zugeordnet.') {
    super(message);
    this.name = 'EconomyScopeMismatchError';
  }
}

function asState(row: {
  guildId: string;
  status: string;
  primaryNitradoConnId: string | null;
  detectedActiveServerCount: number;
  resolvedByDiscordId: string | null;
  resolvedAt: Date | null;
}): EconomyScopeMigrationState {
  return {
    guildId: row.guildId as GuildId,
    status: row.status === 'RESOLVED' ? 'RESOLVED' : 'MIGRATION_REQUIRED',
    primaryNitradoConnId: row.primaryNitradoConnId as NitradoConnId | null,
    detectedActiveServerCount: row.detectedActiveServerCount,
    resolvedByDiscordId: row.resolvedByDiscordId as UserDiscordId | null,
    resolvedAt: row.resolvedAt,
  };
}

/**
 * null bedeutet: Fuer diese Guild existieren keine von der Scope-Migration
 * erfassten Legacy-Economy-Daten. Neue, bereits servergescopte Daten duerfen
 * daher normal angelegt werden.
 */
export async function getEconomyScopeMigrationState(
  guildId: GuildId,
): Promise<EconomyScopeMigrationState | null> {
  const row = await prisma.economyScopeMigration.findUnique({ where: { guildId } });
  return row ? asState(row) : null;
}

/**
 * Fail-closed Guard fuer den Uebergang von guildweiter zu serverbezogener
 * Economy. Solange Legacy-Daten nicht eindeutig zugeordnet sind, darf kein
 * Economy-/Casino-Pfad sie lesen oder mutieren.
 *
 * Eine RESOLVED Legacy-Economy bindet ausschliesslich die alten migrierten
 * Zeilen an ihren Primaerserver. Alle heutigen Economy-/Casino-Repositories
 * sind Guild+Gameserver-gescoppt; andere aktive Server duerfen deshalb mit
 * eigenem, leerem Scope normal arbeiten und sehen niemals Legacy-Guthaben.
 */
export async function assertEconomyScopeReady(
  guildId: GuildId,
  nitradoConnId: NitradoConnId,
): Promise<void> {
  const state = await getEconomyScopeMigrationState(guildId);
  if (!state) return;
  if (state.status !== 'RESOLVED' || !state.primaryNitradoConnId) {
    throw new EconomyMigrationRequiredError();
  }
  // RESOLVED bedeutet: alle alten NULL-gescopten Zeilen wurden exakt dem
  // gespeicherten Primaerserver zugeordnet. Ein anderer Server ist danach ein
  // eigener leerer Scope und darf sicher neue Economy-Daten anlegen.
  if (state.primaryNitradoConnId === nitradoConnId) return;
  return;
}

export interface ResolveLegacyEconomyResult {
  alreadyResolved: boolean;
  primaryNitradoConnId: NitradoConnId;
  updatedRows: number;
}

/**
 * Owner-gesteuerte ECO-S03-Aufloesung.
 *
 * Es werden AUSSCHLIESSLICH bestehende NULL-gescopte Legacy-Zeilen auf den
 * ausgewaehlten Server verschoben. Es gibt keinerlei INSERT/COPY von Guthaben.
 * Wiederholung mit demselben Server ist idempotent; ein spaeteres stilles
 * Umschwenken auf einen anderen Server wird verweigert.
 */
export async function resolveLegacyEconomyPrimaryServer(args: {
  guildId: GuildId;
  primaryNitradoConnId: NitradoConnId;
  actorDiscordId: UserDiscordId;
}): Promise<ResolveLegacyEconomyResult> {
  const conn = await prisma.nitradoConnection.findFirst({
    where: {
      id: args.primaryNitradoConnId,
      guildId: args.guildId,
      status: 'ACTIVE',
      slot: { gte: 1, lte: MAX_GAME_SERVERS_PER_GUILD },
      nitradoServerId: { not: null },
    },
    select: { id: true },
  });
  if (!conn) {
    throw new Error('Der gewaehlte Primaerserver ist fuer diese Guild nicht als aktiver Gameserver nutzbar.');
  }

  const existing = await prisma.economyScopeMigration.findUnique({ where: { guildId: args.guildId } });
  if (!existing) {
    throw new Error('Fuer diese Guild ist keine Legacy-Economy-Migration erforderlich.');
  }
  if (existing.status === 'RESOLVED' && existing.primaryNitradoConnId) {
    if (existing.primaryNitradoConnId !== args.primaryNitradoConnId) {
      throw new EconomyScopeMismatchError('Die Legacy-Economy wurde bereits einem anderen Primaerserver zugeordnet.');
    }
    return {
      alreadyResolved: true,
      primaryNitradoConnId: args.primaryNitradoConnId,
      updatedRows: 0,
    };
  }

  const updatedRows = await prisma.$transaction(async tx => {
    const guildId = String(args.guildId);
    const connId = String(args.primaryNitradoConnId);
    let changed = 0;

    // Gebundene Parameter, keine dynamischen Nutzereingaben in SQL-Identifiers.
    changed += await tx.$executeRawUnsafe(
      'UPDATE "EconomyConfig" SET "nitradoConnId" = $1 WHERE "guildId" = $2 AND "nitradoConnId" IS NULL',
      connId, guildId,
    );
    changed += await tx.$executeRawUnsafe(
      'UPDATE "BankInterestRun" SET "nitradoConnId" = $1 WHERE "guildId" = $2 AND "nitradoConnId" IS NULL',
      connId, guildId,
    );
    changed += await tx.$executeRawUnsafe(
      'UPDATE "EconomyAccount" SET "nitradoConnId" = $1 WHERE "guildId" = $2 AND "nitradoConnId" IS NULL',
      connId, guildId,
    );
    changed += await tx.$executeRawUnsafe(
      'UPDATE "EconomyTransaction" SET "nitradoConnId" = $1 WHERE "guildId" = $2 AND "nitradoConnId" IS NULL',
      connId, guildId,
    );
    changed += await tx.$executeRawUnsafe(
      'UPDATE "EconomyLedgerEntry" SET "nitradoConnId" = $1 WHERE "guildId" = $2 AND "nitradoConnId" IS NULL',
      connId, guildId,
    );
    changed += await tx.$executeRawUnsafe(
      'UPDATE "EconomyRewardRule" SET "nitradoConnId" = $1 WHERE "guildId" = $2 AND "nitradoConnId" IS NULL',
      connId, guildId,
    );
    changed += await tx.$executeRawUnsafe(
      'UPDATE "CasinoGame" SET "nitradoConnId" = $1 WHERE "guildId" = $2 AND "nitradoConnId" IS NULL',
      connId, guildId,
    );
    changed += await tx.$executeRawUnsafe(
      'UPDATE "CasinoRound" r SET "nitradoConnId" = g."nitradoConnId" FROM "CasinoGame" g WHERE r."gameId" = g."id" AND r."guildId" = $1 AND r."nitradoConnId" IS NULL AND g."nitradoConnId" IS NOT NULL',
      guildId,
    );

    await tx.economyScopeMigration.update({
      where: { guildId: args.guildId },
      data: {
        status: 'RESOLVED',
        primaryNitradoConnId: args.primaryNitradoConnId,
        resolvedByDiscordId: args.actorDiscordId,
        resolvedAt: new Date(),
      },
    });
    return changed;
  }, { isolationLevel: 'Serializable' });

  logAudit('ECONOMY_SCOPE_MIGRATION_RESOLVED', 'ECONOMY', {
    guildId: args.guildId,
    nitradoConnId: args.primaryNitradoConnId,
    actorDiscordId: args.actorDiscordId,
    updatedRows,
  });

  return {
    alreadyResolved: false,
    primaryNitradoConnId: args.primaryNitradoConnId,
    updatedRows,
  };
}
