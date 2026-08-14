/**
 * Zentrale Runtime-Grenze fuer Nitrado-nahe Hintergrundarbeit.
 *
 * Start/Stop muessen symmetrisch bleiben: beim Shutdown werden zuerst alle
 * Poller gestoppt, damit keine neuen DB/API-Arbeiten entstehen; erst danach
 * wird der JobWorker gedraint. Discord/Prisma werden vom Aufrufer anschliessend
 * geschlossen.
 */

import type { Client } from 'discord.js';
import { config } from '../../config';
import { startNitradoJobWorker, drainAndStopJobWorker } from './jobWorker';
import { startTokenValidationCron, stopTokenValidationCron } from './tokenValidationCron';
import { startAdmSyncCron, stopAdmSyncCron } from './admSyncCron';
import { startPermaOnlyCron, stopPermaOnlyCron } from './permaOnlyCron';
import { startWhitelistSyncCron, stopWhitelistSyncCron } from '../whitelist/whitelistSyncCron';
import { startKillfeedWatcher, stopKillfeedWatcher } from '../killfeed/admWatcher';
import { startKillfeedV2Cron, stopKillfeedV2Cron } from '../killfeed/killfeedV2Cron';
import { startBankInterestCron, stopBankInterestCron } from '../economy/interestCron';

export interface NitradoRuntimeHandle {
  stopAndDrain(): Promise<void>;
}

export function startNitradoRuntime(client: Client): NitradoRuntimeHandle {
  startNitradoJobWorker();
  startTokenValidationCron(client);
  startAdmSyncCron();
  startPermaOnlyCron();
  startWhitelistSyncCron();

  // Nie beide Killfeed-Pfade gleichzeitig starten.
  if (config.nitrado.admEventPipelineV2) startKillfeedV2Cron();
  else startKillfeedWatcher();

  startBankInterestCron();

  let stopped = false;
  return {
    async stopAndDrain(): Promise<void> {
      if (stopped) return;
      stopped = true;

      // Erst Producer/Poller stoppen, dann die bereits geclaimten Jobs drainen.
      stopBankInterestCron();
      stopKillfeedV2Cron();
      stopKillfeedWatcher();
      stopWhitelistSyncCron();
      stopPermaOnlyCron();
      stopAdmSyncCron();
      stopTokenValidationCron();
      await drainAndStopJobWorker();
    },
  };
}
