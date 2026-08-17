import prisma from '../../database/prisma';
import { leaveCleanupJobKey } from './leaveCleanupSaga';

/**
 * Bewusst eigener Fehler-Typ: Produktive Link-Einstiege muessen fail-closed
 * abbrechen, solange ein Leave-Reset fuer exakt dieselbe Guild+Discord-ID nicht
 * erfolgreich abgeschlossen ist. Dazu zaehlt auch ein FAILED/Dead-Letter-Job:
 * Teilcleanup darf niemals mit frischem Rejoin-State vermischt werden.
 */
export class LeaveCleanupPendingError extends Error {
  constructor() {
    super('Dein vorheriger Austritts-Cleanup ist noch nicht erfolgreich abgeschlossen. Bitte versuche die Verknuepfung spaeter erneut.');
    this.name = 'LeaveCleanupPendingError';
  }
}

export async function hasOpenLeaveCleanupRequest(guildId: string, discordId: string): Promise<boolean> {
  const jobKey = leaveCleanupJobKey(guildId, discordId);
  const row = await prisma.dataDeletionRequest.findFirst({
    where: {
      userId: jobKey,
      requestType: 'PARTIAL_DELETION',
      status: { in: ['PENDING', 'IN_PROGRESS', 'FAILED'] },
    },
    select: { id: true },
  });
  return row !== null;
}

export async function assertNoOpenLeaveCleanupRequest(guildId: string, discordId: string): Promise<void> {
  if (await hasOpenLeaveCleanupRequest(guildId, discordId)) throw new LeaveCleanupPendingError();
}
