export const WHITELIST_REMOVE_SAFETY_INTENT = 'AUTHORIZED_REMOVE_V2' as const;

/**
 * Neue WHITELIST_REMOVE-Jobs tragen diese Markierung ausschliesslich ueber die
 * zentrale Whitelist-Outbox. Legacy-/Fremdjobs ohne Marker duerfen bei fehlender
 * lokaler Source-of-Truth niemals als remote-only Remove ausgefuehrt werden.
 */
export function isAuthorizedWhitelistRemovePayload(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  return (payload as Record<string, unknown>).removeSafetyIntent === WHITELIST_REMOVE_SAFETY_INTENT;
}
