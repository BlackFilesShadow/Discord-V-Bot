import prisma from '../../database/prisma';
import { leaveCleanupJobKey } from './leaveCleanupSaga';

/**
 * Bewusst eigener Fehler-Typ: Produktive Link-Einstiege muessen fail-closed
 * abbrechen, solange ein Leave-Reset fuer exakt dieselbe Guild+Discord-ID offen
 * ist. So kann ein schneller Rejoin keinen frischen Link erzeugen, den der
 * bereits laufende Cleanup spaeter wieder loeschen wuerde.
 */
export class LeaveCleanupPendingError extends Error {
  constructor() {
    super('Dein vorheriger Austritts-Cleanup wird noch abgeschlossen. Bitte versuche die Verknuepfung danach erneut.');
    this.name = 'LeaveCleanupPendingError';
  }
}

export async function hasOpenLeaveCleanupRequest(guildId: string, discordId: string): Promise<boolean> {
  const jobKey = leaveCleanupJobKey(guildId, discordId);
  const row = await prisma.dataDeletionRequest.findFirst({
    where: {
      userId: jobKey,
      requestType: 'PARTIAL_DELETION',
      status: { in: ['PENDING', 'IN_PROGRESS'] },
    },
    select: { id: true },
  });
  return row !== null;
}

export async function assertNoOpenLeaveCleanupRequest(guildId: string, discordId: string): Promise<void> {
  if (await hasOpenLeaveCleanupRequest(guildId, discordId)) throw new LeaveCleanupPendingError();
}
