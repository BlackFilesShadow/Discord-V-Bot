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

    // WICHTIG: Event-Namen muessen 1:1 mit `src/dashboard/socket/emitter.ts`
    // (GuildEvent-Union) uebereinstimmen.
    const allKeys: readonly string[][] = [
      ['settings', guildId], ['dashboard', guildId], ['nitrado', guildId],
      ['factions', guildId], ['whitelist', guildId], ['permissions', guildId],
      ['tickets', guildId], ['economy', guildId],
    ];

    const handlers: Record<string, (...args: unknown[]) => void> = {
      'settings.changed':     () => invalidate([['settings', guildId], ['dashboard', guildId], ['nitrado', guildId], ['economy', guildId], ['casino-games', guildId], ['casino-stats', guildId]]),
      'faction.changed':      () => invalidate([['factions', guildId]]),
      'whitelist.changed':    () => invalidate([['whitelist', guildId]]),
      'permissions.updated':  () => invalidate([['permissions', guildId]]),
      'nitrado.job.updated':  () => invalidate([['dashboard', guildId], ['nitrado', guildId]]),
      'tickets.changed':      () => invalidate([['tickets', guildId]]),
      'economy.tx':           () => invalidate([['economy', guildId], ['dashboard', guildId]]),
      'embed.changed':        () => invalidate([['embeds', guildId]]),
    };

    // Beim Reconnect: Room re-joinen UND alle Caches invalidieren
    // (verpasste Events koennten Stale-State verursacht haben).
    const onReconnect = (): void => {
      joinGuildRoom(guildId);
      invalidate(allKeys);
    };

    for (const [ev, fn] of Object.entries(handlers)) s.on(ev, fn);
    s.io.on('reconnect', onReconnect);
    return () => {
      for (const [ev, fn] of Object.entries(handlers)) s.off(ev, fn);
      s.io.off('reconnect', onReconnect);
    };
  }, [guildId, qc]);
}
