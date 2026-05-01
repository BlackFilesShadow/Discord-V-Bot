import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getGuildSocket, joinGuildRoom } from './socket';

const EVENT_TO_KEYS: Record<string, string[][]> = {
  'whitelist.changed': [['whitelist'], ['whitelist-requests']],
  'permissions.updated': [['permissions']],
  'faction.changed': [['factions']],
  'economy.tx': [['economy-links']],
  'settings.changed': [['settings']],
};

/**
 * Abonniert das `/guild`-Namespace und invalidiert React-Query-Caches
 * passend zu eingehenden Events.
 */
export function useGuildLiveUpdates(guildId: string | undefined): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (!guildId) return;
    const sock = getGuildSocket();
    joinGuildRoom(guildId);

    const handlers: Array<[string, () => void]> = [];
    for (const [eventName, keys] of Object.entries(EVENT_TO_KEYS)) {
      const handler = (): void => {
        for (const k of keys) {
          void qc.invalidateQueries({ queryKey: [...k, guildId] });
        }
      };
      sock.on(eventName, handler);
      handlers.push([eventName, handler]);
    }
    return () => {
      for (const [name, h] of handlers) sock.off(name, h);
    };
  }, [guildId, qc]);
}
