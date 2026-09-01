/**
 * Zentrale Runtime-Grenze fuer Nitrado-nahe Hintergrundarbeit.
 */

import type { Client } from 'discord.js';
import { startNitradoJobWorker, drainAndStopJobWorker } from './jobWorker';
import { startTokenValidationCron, stopTokenValidationCron } from './tokenValidationCron';
import { startAdmLiveSyncCron, stopAdmLiveSyncCron } from './adm/admLiveSyncCron';
import { startAdmPostProcessCron, stopAdmPostProcessCron } from './adm/admPostProcessCron';
import { startPermaOnlyCron, stopPermaOnlyCron } from './permaOnlyCron';
import { startWhitelistSyncCron, stopWhitelistSyncCron } from '../whitelist/whitelistSyncCron';
import { startGameplayFeedRuntime, stopGameplayFeedRuntime } from '../gameplayFeeds/runtime';
import { startBankInterestCron, stopBankInterestCron } from '../economy/interestCron';
import { startBanExpiryRuntime, stopBanExpiryRuntime } from '../bans/expiryRuntime';
import { startBanReconciliationCron, stopBanReconciliationCron } from '../bans/banReconciliation';
import { startMarketOrderReadyRuntime, stopMarketOrderReadyRuntime } from '../economy/marketOrderReadyRuntime';

export interface NitradoRuntimeHandle {
  stopAndDrain(): Promise<void>;
}

export function startNitradoRuntime(client: Client): NitradoRuntimeHandle {
  startNitradoJobWorker();
  startBanExpiryRuntime();
  startBanReconciliationCron();
  startMarketOrderReadyRuntime();
  startTokenValidationCron(client);
  startPermaOnlyCron();
  startWhitelistSyncCron();

  // ADM-V2 ist die einzige Datei-Quelle. Der Live-Ingest und der persistente
  // Gameplay-Feed-Worker laufen immer. Ob tatsaechlich etwas nach Discord
  // gesendet wird, entscheidet ausschliesslich die explizite, servergescoppte
  // GameplayFeedConfig (`isActive` + Kategorien + Channel). Damit kann eine
  // gueltige Feed-Konfiguration nicht mehr durch ein unsichtbares globales
  // Environment-Gate stillgelegt werden.
  startAdmLiveSyncCron();
  startAdmPostProcessCron();
  startGameplayFeedRuntime();

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
      stopBanReconciliationCron();
      stopBanExpiryRuntime();
      stopMarketOrderReadyRuntime();
      await drainAndStopJobWorker();
    },
  };
}
