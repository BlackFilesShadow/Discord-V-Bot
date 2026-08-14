/**
 * Zentrale Runtime-Grenze fuer Nitrado-nahe Hintergrundarbeit.
 */

import type { Client } from 'discord.js';
import { config } from '../../config';
import { startNitradoJobWorker, drainAndStopJobWorker } from './jobWorker';
import { startTokenValidationCron, stopTokenValidationCron } from './tokenValidationCron';
import { startAdmLiveSyncCron, stopAdmLiveSyncCron } from './adm/admLiveSyncCron';
import { startAdmPostProcessCron, stopAdmPostProcessCron } from './adm/admPostProcessCron';
import { startPermaOnlyCron, stopPermaOnlyCron } from './permaOnlyCron';
import { startWhitelistSyncCron, stopWhitelistSyncCron } from '../whitelist/whitelistSyncCron';
import { startGameplayFeedRuntime, stopGameplayFeedRuntime } from '../gameplayFeeds/runtime';
import { startBankInterestCron, stopBankInterestCron } from '../economy/interestCron';
import { startBanExpiryRuntime, stopBanExpiryRuntime } from '../bans/expiryRuntime';

export interface NitradoRuntimeHandle {
  stopAndDrain(): Promise<void>;
}

export function startNitradoRuntime(client: Client): NitradoRuntimeHandle {
  startNitradoJobWorker();
  startBanExpiryRuntime();
  startTokenValidationCron(client);
  startPermaOnlyCron();
  startWhitelistSyncCron();

  // ADM-V2 ist jetzt die einzige Datei-Quelle. Der Live-Ingest laeuft immer,
  // damit Linking/Rewards/Sessions unabhaengig vom oeffentlichen Feed-Gate
  // funktionieren. ADM_EVENT_PIPELINE_V2 steuert nur noch die Discord-
  // Death/Baufeed-Auslieferung.
  startAdmLiveSyncCron();
  startAdmPostProcessCron();
  if (config.nitrado.admEventPipelineV2) {
    startGameplayFeedRuntime();
  }

  startBankInterestCron();

  let stopped = false;
  return {
    async stopAndDrain(): Promise<void> {
      if (stopped) return;
      stopped = true;

      stopBankInterestCron();
      stopGameplayFeedRuntime();
      stopAdmPostProcessCron();
      stopAdmLiveSyncCron();
      stopWhitelistSyncCron();
      stopPermaOnlyCron();
      stopTokenValidationCron();
      stopBanExpiryRuntime();
      await drainAndStopJobWorker();
    },
  };
}
