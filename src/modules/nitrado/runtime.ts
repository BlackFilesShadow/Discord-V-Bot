/**
 * Zentrale Runtime-Grenze fuer Nitrado-nahe Hintergrundarbeit.
 */

import type { Client } from 'discord.js';
import { config } from '../../config';
import { startNitradoJobWorker, drainAndStopJobWorker } from './jobWorker';
import { startTokenValidationCron, stopTokenValidationCron } from './tokenValidationCron';
import { startAdmSyncCron, stopAdmSyncCron } from './admSyncCron';
import { startPermaOnlyCron, stopPermaOnlyCron } from './permaOnlyCron';
import { startWhitelistSyncCron, stopWhitelistSyncCron } from '../whitelist/whitelistSyncCron';
import { startKillfeedWatcher, stopKillfeedWatcher } from '../killfeed/admWatcher';
import { startGameplayFeedRuntime, stopGameplayFeedRuntime } from '../gameplayFeeds/runtime';
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

  // Nie Legacy und V2 parallel posten. V2 vereinigt Deathfeed + Baufeed auf der
  // kanonischen AdmEvent-Pipeline mit persistenter Retry-Zustellung.
  if (config.nitrado.admEventPipelineV2) startGameplayFeedRuntime();
  else startKillfeedWatcher();

  startBankInterestCron();

  let stopped = false;
  return {
    async stopAndDrain(): Promise<void> {
      if (stopped) return;
      stopped = true;

      stopBankInterestCron();
      stopGameplayFeedRuntime();
      stopKillfeedWatcher();
      stopWhitelistSyncCron();
      stopPermaOnlyCron();
      stopAdmSyncCron();
      stopTokenValidationCron();
      await drainAndStopJobWorker();
    },
  };
}
