import { config } from '../../config';
import { isGlobalDeveloperIdentity } from '../../security/privilegedIdentity';

/**
 * Compatibility wrapper for the canonical GlobalDeveloperIdentity helper.
 * Rights derive from authenticated Discord identity + DB role only; passwords
 * and sessions are step-up factors and never create eligibility.
 */
export function isGlobalDeveloperEligible(
  discordId: string,
  role: string,
  ownerId: string = config.discord.ownerId,
): boolean {
  return isGlobalDeveloperIdentity(discordId, role, ownerId);
}
