import type { Client } from 'discord.js';
import type { GuildId, NitradoConnId } from '../../types/scope';
import {
  postVirtualAccountArchive,
  syncVirtualAccountProjection as syncVirtualAccountProjectionUnsafe,
  type VirtualAccountArchiveEvent,
} from './virtualAccountDiscord';

const accountSyncInFlight = new Map<string, Promise<unknown>>();

function keyFor(guildId: GuildId, connId: NitradoConnId, accountId: string): string {
  return `${String(guildId)}:${String(connId)}:${accountId}`;
}

function serializePerAccount<T>(
  guildId: GuildId,
  connId: NitradoConnId,
  accountId: string,
  task: () => Promise<T>,
): Promise<T> {
  const key = keyFor(guildId, connId, accountId);
  const previous = accountSyncInFlight.get(key) ?? Promise.resolve();
  const run = previous
    .catch(() => undefined)
    .then(task);
  accountSyncInFlight.set(key, run);
  void run.finally(() => {
    if (accountSyncInFlight.get(key) === run) accountSyncInFlight.delete(key);
  }).catch(() => undefined);
  return run;
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
  return serializePerAccount(guildId, connId, accountId, () => syncVirtualAccountProjectionUnsafe(client, guildId, connId, accountId));
}

/**
 * Kanonischer Nach-Buchungs-Pfad: Archiv-Eintrag und Live-Projektion laufen in
 * derselben pro-Konto-Serialisierung. Dadurch koennen sich Archiv-Post und
 * Embed-Update zweier gleichzeitiger Buchungen niemals verzahnen (z. B. altes
 * Embed nach neuem Stand). Konten ohne Discord-Integration ueberspringen den
 * Archiv-Post still; der Sync raeumt eine etwaige Alt-Projektion kontrolliert ab.
 */
export function publishVirtualAccountActivityLive(
  client: Client,
  guildId: GuildId,
  connId: NitradoConnId,
  accountId: string,
  archive: Omit<VirtualAccountArchiveEvent, 'guildId' | 'nitradoConnId' | 'accountId'> | null,
): Promise<void> {
  return serializePerAccount(guildId, connId, accountId, async () => {
    if (archive) {
      await postVirtualAccountArchive(client, {
        ...archive,
        guildId,
        nitradoConnId: connId,
        accountId,
      });
    }
    await syncVirtualAccountProjectionUnsafe(client, guildId, connId, accountId);
  });
}
