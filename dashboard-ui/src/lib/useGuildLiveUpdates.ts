import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getGuildSocket, joinGuildRoom } from './socket';

/**
 * Live-Updates fuer eine Guild. Subscribed sich auf alle relevanten
 * Events des `/guild`-Namespaces und invalidiert die passenden React-Query
 * Caches, sodass die UI bidirektional reagiert.
 */
export function useGuildLiveUpdates(guildId: string | undefined): void {
  const qc = useQueryClient();

  useEffect(() => {
    if (!guildId) return;
    const s = getGuildSocket();
    joinGuildRoom(guildId);

    const invalidate = (keys: readonly string[][]): void => {
      for (const key of keys) void qc.invalidateQueries({ queryKey: key });
    };

    const handlers: Record<string, (...args: unknown[]) => void> = {
      'settings.changed':     () => invalidate([['settings', guildId], ['dashboard', guildId], ['nitrado', guildId]]),
      'faction.changed':      () => invalidate([['factions', guildId]]),
      'whitelist.changed':    () => invalidate([['whitelist', guildId]]),
      'permissions.updated':  () => invalidate([['permissions', guildId]]),
      'nitrado.job.updated':  () => invalidate([['dashboard', guildId], ['nitrado', guildId]]),
      'ticket.created':       () => invalidate([['tickets', guildId]]),
      'ticket.updated':       () => invalidate([['tickets', guildId]]),
      'reconnect':            () => joinGuildRoom(guildId),
    };

    for (const [ev, fn] of Object.entries(handlers)) s.on(ev, fn);
    return () => { for (const [ev, fn] of Object.entries(handlers)) s.off(ev, fn); };
  }, [guildId, qc]);
}
