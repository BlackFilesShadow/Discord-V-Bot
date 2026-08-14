/**
 * Keep-Online-Outbox-Helfer.
 *
 * Beim Deaktivieren von Keep-Online duerfen bereits geplante Auto-Start-Jobs
 * nicht spaeter doch noch ausgefuehrt werden. PENDING-Jobs werden deshalb
 * dauerhaft auf DEAD gesetzt. Ein bereits RUNNING geclaimter Job wird vom
 * Worker unmittelbar vor der Remote-Aktion nochmals gegen das kanonische
 * `NitradoConnection.keepOnlineEnabled` geprueft.
 */

export interface KeepOnlineJobClient {
  nitradoJob: {
    updateMany: (args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => Promise<{ count: number }>;
  };
}

export interface KeepOnlineJobScope {
  guildId: string;
  nitradoConnId: string;
}

export async function cancelPendingKeepOnlineJobs(
  client: KeepOnlineJobClient,
  scope: KeepOnlineJobScope,
  now: Date = new Date(),
): Promise<number> {
  const result = await client.nitradoJob.updateMany({
    where: {
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
      operation: 'RESTART_IF_DOWN',
      status: 'PENDING',
    },
    data: {
      status: 'DEAD',
      lastError: 'Keep-Online deaktiviert; geplanter Auto-Start verworfen.',
      updatedAt: now,
    },
  });
  return result.count;
}
