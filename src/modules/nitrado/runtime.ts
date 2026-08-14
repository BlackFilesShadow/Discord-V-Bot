/**
 * Zentrale Runtime-Grenze fuer Nitrado-nahe Hintergrundarbeit.
 */

import type { Client } from 'discord.js';
import { config } from '../../config';
import { startNitradoJobWorker, drainAndStopJobWorker } from './jobWorker';
import { startTokenValidationCron, stopTokenValidationCron } from './tokenValidationCron';
import { startAdmSyncCron, stopAdmSyncCron } from './admSyncCron';
import { startAdmLiveSyncCron, stopAdmLiveSyncCron } from './adm/admLiveSyncCron';
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
  // Der 15-Minuten-Sync bleibt fuer Linking/Rewards/Session-Aggregation aktiv.
  startAdmSyncCron();
  startPermaOnlyCron();
  startWhitelistSyncCron();

  // Nie Legacy und V2 parallel posten. V2 bekommt zusaetzlich den schnellen,
  // byte-inkrementellen ADM-Producer; beide V2-Komponenten teilen AdmEvent als
  // idempotente Source-of-Truth.
  if (config.nitrado.admEventPipelineV2) {
    startAdmLiveSyncCron();
    startGameplayFeedRuntime();
  } else {
    startKillfeedWatcher();
  }

  startBankInterestCron();

  let stopped = false;
  return {
    async stopAndDrain(): Promise<void> {
      if (stopped) return;
      stopped = true;

      stopBankInterestCron();
      stopGameplayFeedRuntime();
      stopAdmLiveSyncCron();
      stopKillfeedWatcher();
      stopWhitelistSyncCron();
      stopPermaOnlyCron();
      stopAdmSyncCron();
      stopTokenValidationCron();
      await drainAndStopJobWorker();
    },
  };
}
