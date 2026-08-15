/**
 * Process-weite Discord-Client-Referenz, die vom Bot-Boot in den
 * Dashboard-Layer injiziert wird. Wird gebraucht fuer Owner-Checks
 * (Client.guilds.cache.get(id).ownerId) und DEV-Command-Registry-Aktionen.
 */
import { Collection, type Client } from 'discord.js';
import type { Command, ExtendedClient } from '../types';

let injectedClient: ExtendedClient | null = null;

/**
 * Der produktive Bot verwendet einen ExtendedClient. Fuer Dashboard-/Test-
 * Aufrufer, die nur einen discord.js Client liefern, normalisieren wir die
 * Command-Collection einmalig, statt spaeter unsichere Casts in einzelnen
 * Routen zu verteilen.
 */
export function setDashboardClient(client: Client): void {
  const extended = client as ExtendedClient;
  if (!extended.commands) extended.commands = new Collection<string, Command>();
  injectedClient = extended;
}

export function getDashboardClient(): ExtendedClient {
  if (!injectedClient) throw new Error('Discord-Client nicht initialisiert.');
  return injectedClient;
}

export function tryGetDashboardClient(): ExtendedClient | null {
  return injectedClient;
}
