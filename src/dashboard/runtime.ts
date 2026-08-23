import type { Server as HttpServer } from 'http';
import type { Server as IOServer } from 'socket.io';
import type { Pool } from 'pg';

export interface CleanupSchedule {
  stop(): void;
}

/**
 * Plant einen einmaligen Startup-Lauf plus ein periodisches Intervall.
 * Beide Handles sind unref'ed und koennen gemeinsam deterministisch gestoppt
 * werden. Mehrfaches stop() ist idempotent. Rueckgabewerte der Cleanup-Funktion
 * sind reine Diagnostik und werden vom Scheduler bewusst ignoriert.
 */
export function scheduleCleanup(
  task: () => unknown | Promise<unknown>,
  intervalMs: number,
  startupDelayMs: number,
  onError?: (error: unknown) => void,
): CleanupSchedule {
  let stopped = false;

  const run = (): void => {
    if (stopped) return;
    try {
      void Promise.resolve(task()).catch(error => onError?.(error));
    } catch (error) {
      onError?.(error);
    }
  };

  const startup = setTimeout(run, startupDelayMs);
  const interval = setInterval(run, intervalMs);
  startup.unref?.();
  interval.unref?.();

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearTimeout(startup);
      clearInterval(interval);
    },
  };
}

export interface SessionStoreHandle {
  close(): void | Promise<void>;
}

export interface DashboardRuntimeResources {
  httpServer: HttpServer;
  io: IOServer;
  sessionStore: SessionStoreHandle;
  sessionPool: Pool;
  cleanups: CleanupSchedule[];
}

export interface DashboardRuntimeHandle {
  address(): ReturnType<HttpServer['address']>;
  stop(): Promise<void>;
}

function closeIo(io: IOServer): Promise<void> {
  return new Promise(resolve => {
    void io.close(() => resolve());
  });
}

function closeHttpServer(server: HttpServer): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close(error => {
      if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

/**
 * Symmetrische Dashboard-Runtime:
 * 1) keine neuen Cleanup-Jobs mehr erzeugen,
 * 2) Socket-Verbindungen schliessen,
 * 3) HTTP-Listener schliessen,
 * 4) connect-pg-simple-Pruning stoppen,
 * 5) den explizit injizierten PG-Pool beenden.
 *
 * stop() ist single-flight/idempotent, damit SIGINT/SIGTERM-Races keine
 * Ressourcen doppelt schliessen.
 */
export function createDashboardRuntime(resources: DashboardRuntimeResources): DashboardRuntimeHandle {
  let stopPromise: Promise<void> | null = null;

  return {
    address(): ReturnType<HttpServer['address']> {
      return resources.httpServer.address();
    },
    stop(): Promise<void> {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        for (const cleanup of resources.cleanups) cleanup.stop();
        await closeIo(resources.io);
        await closeHttpServer(resources.httpServer);
        await Promise.resolve(resources.sessionStore.close());
        await resources.sessionPool.end();
      })();
      return stopPromise;
    },
  };
}
