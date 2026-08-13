import { config } from '../../config';

/**
 * Kanonische globale Developer-Identitaet.
 *
 * Rechte entstehen ausschliesslich aus zwei bereits vorhandenen Fakten:
 *  1. Discord-ID entspricht der konfigurierten globalen Bot-Owner-ID.
 *  2. DB-/Session-Rolle ist bereits DEVELOPER.
 *
 * Shared Passwords, DEV-Session-Tokens oder Dashboard-Zustaende duerfen diese
 * Entscheidung niemals selbst erzeugen oder erweitern.
 */
export function isGlobalDeveloperEligible(
  discordId: string,
  role: string,
  ownerId: string = config.discord.ownerId,
): boolean {
  return ownerId.length > 0 && role === 'DEVELOPER' && discordId === ownerId;
}
