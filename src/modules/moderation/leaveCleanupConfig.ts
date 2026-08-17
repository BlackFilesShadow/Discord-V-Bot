import prisma from '../../database/prisma';

export interface LeaveCleanupConfig {
  deletePlayerDataOnLeave: boolean;
}

export interface LeaveCleanupConfigState extends LeaveCleanupConfig {
  configured: boolean;
}

const DEFAULT_CONFIG: LeaveCleanupConfig = {
  deletePlayerDataOnLeave: false,
};

function key(guildId: string): string {
  return `leave-cleanup:${guildId}`;
}

/**
 * Destruktiver Leave-Reset ist fail-safe standardmaessig AUS und wird bewusst
 * pro Guild gespeichert. Das globale Feature-Toggle-System ist dafuer ungeeignet,
 * weil eine Guild niemals den Daten-Lifecycle einer anderen Guild steuern darf.
 */
export async function getLeaveCleanupConfig(guildId: string): Promise<LeaveCleanupConfigState> {
  const row = await prisma.botConfig.findUnique({ where: { key: key(guildId) } });
  if (!row) return { ...DEFAULT_CONFIG, configured: false };
  const value = row.value && typeof row.value === 'object' && !Array.isArray(row.value)
    ? row.value as { deletePlayerDataOnLeave?: unknown }
    : {};
  return {
    configured: true,
    // Malformed/legacy JSON faellt absichtlich auf AUS statt fail-open.
    deletePlayerDataOnLeave: value.deletePlayerDataOnLeave === true,
  };
}

export async function setLeaveCleanupConfig(
  guildId: string,
  cfg: LeaveCleanupConfig,
  updatedBy: string,
): Promise<LeaveCleanupConfigState> {
  const value = { deletePlayerDataOnLeave: cfg.deletePlayerDataOnLeave };
  await prisma.botConfig.upsert({
    where: { key: key(guildId) },
    create: {
      key: key(guildId),
      value,
      category: 'member-lifecycle',
      description: `Spielerdaten-Reset bei Guild-Austritt fuer ${guildId}`,
      updatedBy,
    },
    update: { value, updatedBy },
  });
  return { configured: true, ...value };
}
