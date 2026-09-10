export type FeedConfigurationAction = 'BACKOFF' | 'AUTO_DISABLE';

/**
 * Nur ein wiederholt nicht erreichbarer Discord-Ziel-Channel gilt hier als
 * selbstheilbarer permanenter Konfigurationsfehler. Twitch-Credentials und
 * Quellenfehler bleiben bewusst im normalen Backoff und werden NICHT
 * automatisch deaktiviert.
 */
export function feedConfigurationAction(error: unknown, consecutiveFailures: number): FeedConfigurationAction {
  const message = error instanceof Error ? error.message : String(error);
  if (consecutiveFailures >= 3 && /Ziel-Channel ist nicht erreichbar/i.test(message)) {
    return 'AUTO_DISABLE';
  }
  return 'BACKOFF';
}
