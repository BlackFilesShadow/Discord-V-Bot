/**
 * Process-weite Discord-Client-Referenz, die vom Bot-Boot in den
 * Dashboard-Layer injiziert wird. Wird gebraucht fuer Owner-Checks
 * (Client.guilds.cache.get(id).ownerId).
 */
import type { Client } from 'discord.js';

let injectedClient: Client | null = null;

export function setDashboardClient(client: Client): void {
  injectedClient = client;
}

export function getDashboardClient(): Client {
  if (!injectedClient) throw new Error('Discord-Client nicht initialisiert.');
  return injectedClient;
}

export function tryGetDashboardClient(): Client | null {
  return injectedClient;
}
