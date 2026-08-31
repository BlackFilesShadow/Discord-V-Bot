import type { Client } from 'discord.js';
import type { GuildId, NitradoConnId } from '../../types/scope';
import { syncVirtualAccountProjection as syncVirtualAccountProjectionUnsafe } from './virtualAccountDiscord';

const accountSyncInFlight = new Map<string, Promise<unknown>>();

function keyFor(guildId: GuildId, connId: NitradoConnId, accountId: string): string {
  return `${String(guildId)}:${String(connId)}:${accountId}`;
}

/**
 * Serialisiert Discord-Projektionen pro virtuellem Konto. Zwei gleichzeitig
 * bestaetigte Geld-/Dashboard-Aenderungen duerfen damit nicht parallel beide
 * eine neue Live-Nachricht oder einen neuen Archiv-Thread erzeugen. Andere
 * Konten — auch wenn sie denselben Haupt-/Archivkanal benutzen — bleiben
 * voneinander unabhaengig und blockieren sich nicht.
 */
export function syncVirtualAccountProjectionLive(
  client: Client,
  guildId: GuildId,
  connId: NitradoConnId,
  accountId: string,
): ReturnType<typeof syncVirtualAccountProjectionUnsafe> {
  const key = keyFor(guildId, connId, accountId);
  const previous = accountSyncInFlight.get(key) ?? Promise.resolve();
  const run = previous
    .catch(() => undefined)
    .then(() => syncVirtualAccountProjectionUnsafe(client, guildId, connId, accountId));
  accountSyncInFlight.set(key, run);
  void run.finally(() => {
    if (accountSyncInFlight.get(key) === run) accountSyncInFlight.delete(key);
  }).catch(() => undefined);
  return run;
}
