import { config } from '../../config';
import { decrypt } from '../../utils/security';
import { NitradoClient } from '../nitrado/nitradoClient';
import {
  readCurrentAdmBinding,
  withFreshAdmBinding,
} from '../nitrado/adm/bindingFence';

export interface WhitelistRequestPreflightScope {
  guildId: string;
  nitradoConnId: string;
}

function normalizeGameId(value: string): string {
  return value.trim().toLocaleLowerCase('de-DE');
}

/**
 * Read-only Preflight fuer einen Whitelist-Antrag.
 *
 * Remote-only Nitrado-Eintraege werden vom Hintergrund-Reconciler bewusst nicht
 * als lokaler WhitelistEntry materialisiert. Deshalb muss ein User-Antrag vor
 * dem Erstellen eines WhitelistRequest den realen Remote-Zustand pruefen.
 *
 * Der Token/Service-Snapshot wird ueber dieselbe Binding-Fence wie andere
 * produktive Nitrado-Reads bezogen und nach dem Remote-I/O erneut validiert.
 * Diese Funktion mutiert weder Nitrado noch lokalen Whitelist-/Request-State.
 */
export async function isAlreadyOnRemoteWhitelist(
  scope: WhitelistRequestPreflightScope,
  gameId: string,
): Promise<boolean> {
  const binding = await readCurrentAdmBinding({
    id: scope.nitradoConnId,
    guildId: scope.guildId,
  });
  if (!binding) {
    throw new Error('Aktive Nitrado-Bindung fuer Whitelist-Preflight nicht verfuegbar.');
  }

  const token = decrypt(binding.encryptedToken, config.security.encryptionKey);
  const remote = await new NitradoClient(token).getWhitelist(binding.nitradoServerId);
  const wanted = normalizeGameId(gameId);
  const present = remote.some(row => normalizeGameId(row.identifier) === wanted);

  return withFreshAdmBinding(binding, async () => present);
}
