import crypto from 'node:crypto';

export interface RadarLockClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

export function radarScopeLockKeys(guildId: string, nitradoConnId: string): [number, number] {
  const digest = crypto.createHash('sha256')
    .update(`radar-autoban-scope:v1\u0000${guildId}\u0000${nitradoConnId}`)
    .digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

/**
 * Gemeinsame Transaktionsgrenze fuer Radar-Konfigurationsaenderungen und Auto-Bans.
 * Eine Zonen-/Kartenmutation kann dadurch niemals zwischen Revalidierung und
 * Ban-Commit rutschen.
 */
export async function lockRadarScope(
  client: RadarLockClient,
  guildId: string,
  nitradoConnId: string,
): Promise<void> {
  const [key1, key2] = radarScopeLockKeys(guildId, nitradoConnId);
  await client.$queryRawUnsafe('SELECT pg_advisory_xact_lock($1, $2)', key1, key2);
}
