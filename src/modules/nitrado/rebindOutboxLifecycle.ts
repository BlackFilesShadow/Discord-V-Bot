import {
  withNitradoOutboxConnectionLock,
  type NitradoOutboxTxClient,
} from './outboxLock';
import { lockRadarScope } from '../radar/lock';

const REMOTE_MUTATION_OPERATIONS = [
  'WHITELIST_ADD',
  'WHITELIST_REMOVE',
  'SERVER_BAN_ADD',
  'SERVER_BAN_REMOVE',
] as const;

const CANCEL_ON_REBIND_OPERATIONS = [
  'WHITELIST_ADD',
  'WHITELIST_REMOVE',
  'SERVER_BAN_REMOVE',
] as const;

interface RebindLifecycleClient extends NitradoOutboxTxClient {
  nitradoJob: NitradoOutboxTxClient['nitradoJob'] & {
    findFirst(args: unknown): Promise<{ id: string } | null>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
  whitelistEntry: {
    updateMany(args: unknown): Promise<{ count: number }>;
  };
  serverBanEntry: {
    updateMany(args: unknown): Promise<{ count: number }>;
  };
  serverBanRemoteIdentity: {
    deleteMany(args: unknown): Promise<{ count: number }>;
  };
  radarZone: {
    updateMany(args: unknown): Promise<{ count: number }>;
  };
  radarZoneEvent: {
    updateMany(args: unknown): Promise<{ count: number }>;
  };
  radarAutoBanBanFence: {
    findMany(args: unknown): Promise<Array<{ banId: string }>>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
}

export interface NitradoRebindLifecycleResult {
  busy: boolean;
  cancelledJobs: number;
  whitelistReset: number;
  banRemoteStateReset: number;
  radarAutoBanZonesDisabled: number;
  radarAutoBanEventsSkipped: number;
  radarBanFencesInvalidated: number;
  radarBansDeactivated: number;
  radarBanSecretsDeleted: number;
  radarBanAddJobsCancelled: number;
}

function payloadBanId(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const banId = (value as Record<string, unknown>).banId;
  return typeof banId === 'string' && banId.trim() ? banId.trim() : null;
}

/**
 * Nitrado-1U + Radar-Fence: Bereitet lokale Remote-Wahrheit atomar auf einen
 * echten Service-Rebind vor. Der Aufrufer MUSS bereits den kanonischen
 * per-Connection Config-Lock halten und `client` MUSS der TransactionClient
 * derselben Service-/Binding-Aenderung sein.
 *
 * Lock-Reihenfolge gegen produktive Radar-/Ban-Writer:
 * 1. Radar-Scope-xact-Lock; damit kann keine Zone/Auto-Ban-Entscheidung parallel
 *    in die alte Service-Generation committen.
 * 2. lokale Whitelist-/Ban-/Radar-Beobachtungszeilen werden invalidiert.
 * 3. Connection-weite Outbox-xact-Barriere.
 * 4. RUNNING Remote-Jobs machen den Rebind busy; PENDING alte Intents werden
 *    gezielt bereinigt.
 *
 * Manuelle SERVER_BAN_ADD-Intents bleiben wie bisher ein serveruebergreifender
 * Policy-Sollzustand. Nur Bans mit RadarAutoBanBanFence werden an die alte
 * Service-/Binding-Generation gebunden und beim Rebind fail-closed deaktiviert.
 */
export async function prepareNitradoRemoteStateForServiceRebind(
  client: NitradoOutboxTxClient,
  scope: { guildId: string; nitradoConnId: string },
): Promise<NitradoRebindLifecycleResult> {
  const tx = client as unknown as RebindLifecycleClient;
  await lockRadarScope(tx, scope.guildId, scope.nitradoConnId);
  const now = new Date();

  // Ein neuer physischer Gameserver darf niemals unbeabsichtigt eine scharf
  // konfigurierte Auto-Ban-Zone des alten Servers erben. Reaktivierung erfolgt
  // bewusst erst wieder im Dashboard und erzeugt eine neue Arm-Generation.
  const disabledZones = await tx.radarZone.updateMany({
    where: {
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
      autoBanEnabled: true,
    },
    data: {
      autoBanEnabled: false,
      autoBanEnabledAt: null,
      autoBanAuthorizedBy: null,
      version: { increment: 1 },
    },
  });

  // Bereits geclaimte, aber noch nicht unter Radar-Lock validierte Events werden
  // ebenfalls unschaedlich. Gewinnt der Worker den Lock zuerst, committen Ban,
  // Fence und Outbox vollstaendig vor uns und werden unten als alte Generation
  // wieder invalidiert/cancelled.
  const skippedEvents = await tx.radarZoneEvent.updateMany({
    where: {
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
      autoBanStatus: { in: ['PENDING', 'PROCESSING', 'RETRY'] },
    },
    data: {
      autoBanStatus: 'SKIPPED',
      autoBanProcessedAt: now,
      autoBanLeaseUntil: null,
      autoBanLastError: 'AUTOBAN_SERVICE_REBIND',
    },
  });

  const fenceRows = await tx.radarAutoBanBanFence.findMany({
    where: {
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
    },
    select: { banId: true },
  });
  const radarBanIds = [...new Set(fenceRows.map(row => row.banId).filter(Boolean))];

  const invalidatedFences = await tx.radarAutoBanBanFence.updateMany({
    where: {
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
      invalidatedAt: null,
    },
    data: { invalidatedAt: now },
  });

  const radarBans = radarBanIds.length > 0
    ? await tx.serverBanEntry.updateMany({
      where: {
        id: { in: radarBanIds },
        guildId: scope.guildId,
        nitradoConnId: scope.nitradoConnId,
        active: true,
      },
      data: {
        active: false,
        liftedAt: now,
        appliedRemotely: false,
      },
    })
    : { count: 0 };

  const deletedRadarSecrets = radarBanIds.length > 0
    ? await tx.serverBanRemoteIdentity.deleteMany({ where: { banId: { in: radarBanIds } } })
    : { count: 0 };

  // Diese Beobachtungen gehoeren zum alten Service und werden vor der
  // Outbox-Barriere invalidiert. Da der Aufrufer dieselbe DB-Transaktion haelt,
  // werden sie bei einem spaeteren busy/Claim-Race zusammen mit dem Rebind
  // zurueckgerollt.
  const whitelist = await tx.whitelistEntry.updateMany({
    where: {
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
      syncState: { not: 'PENDING_REMOVE' },
    },
    data: {
      syncState: 'LOCAL_ONLY',
      lastSyncedAt: null,
    },
  });

  const bans = await tx.serverBanEntry.updateMany({
    where: {
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
      appliedRemotely: true,
    },
    data: { appliedRemotely: false },
  });

  return withNitradoOutboxConnectionLock(client, scope, async txBase => {
    const lockedTx = txBase as unknown as RebindLifecycleClient;

    const running = await lockedTx.nitradoJob.findFirst({
      where: {
        guildId: scope.guildId,
        nitradoConnId: scope.nitradoConnId,
        status: 'RUNNING',
        operation: { in: [...REMOTE_MUTATION_OPERATIONS] },
      },
      select: { id: true },
    });
    if (running) {
      return {
        busy: true,
        cancelledJobs: 0,
        whitelistReset: whitelist.count,
        banRemoteStateReset: bans.count,
        radarAutoBanZonesDisabled: disabledZones.count,
        radarAutoBanEventsSkipped: skippedEvents.count,
        radarBanFencesInvalidated: invalidatedFences.count,
        radarBansDeactivated: radarBans.count,
        radarBanSecretsDeleted: deletedRadarSecrets.count,
        radarBanAddJobsCancelled: 0,
      };
    }

    const cancelled = await lockedTx.nitradoJob.updateMany({
      where: {
        guildId: scope.guildId,
        nitradoConnId: scope.nitradoConnId,
        status: 'PENDING',
        operation: { in: [...CANCEL_ON_REBIND_OPERATIONS] },
      },
      data: {
        status: 'DONE',
        payload: {},
        lastError: 'Superseded by Nitrado service rebind before remote execution',
        updatedAt: now,
      },
    });

    // SERVER_BAN_ADD bleibt fuer manuelle Bans erhalten. Radar-fenced ADDs sind
    // dagegen Beweise der alten physischen Servergeneration und werden gezielt
    // anhand ihrer banId aus der verschluesselten Outbox entfernt.
    let radarBanAddJobsCancelled = 0;
    if (radarBanIds.length > 0) {
      const pendingAdds = await lockedTx.nitradoJob.findMany({
        where: {
          guildId: scope.guildId,
          nitradoConnId: scope.nitradoConnId,
          status: 'PENDING',
          operation: 'SERVER_BAN_ADD',
        },
        select: { id: true, payload: true },
      }) as unknown as Array<{ id: string; payload: unknown }>;
      const radarBanSet = new Set(radarBanIds);
      const staleAddIds = pendingAdds
        .filter(job => {
          const banId = payloadBanId(job.payload);
          return banId !== null && radarBanSet.has(banId);
        })
        .map(job => job.id);
      if (staleAddIds.length > 0) {
        const staleAdds = await lockedTx.nitradoJob.updateMany({
          where: {
            id: { in: staleAddIds },
            guildId: scope.guildId,
            nitradoConnId: scope.nitradoConnId,
            status: 'PENDING',
            operation: 'SERVER_BAN_ADD',
          },
          data: {
            status: 'DONE',
            payload: {},
            lastError: 'Radar auto-ban superseded by Nitrado service rebind before remote execution',
            updatedAt: now,
          },
        });
        radarBanAddJobsCancelled = staleAdds.count;
      }
    }

    // Claim-Race: gewinnt ein Worker PENDING->RUNNING unmittelbar vor unseren
    // UPDATEs, matcht die Bereinigung diesen Job nicht. Der zweite Check macht
    // den gesamten Rebind daraufhin busy; der Repository-Throw rollt ALLE oben
    // vorgenommenen Radar-/Ban-Invalidierungen atomar zurueck.
    const racedRunning = await lockedTx.nitradoJob.findFirst({
      where: {
        guildId: scope.guildId,
        nitradoConnId: scope.nitradoConnId,
        status: 'RUNNING',
        operation: { in: [...REMOTE_MUTATION_OPERATIONS] },
      },
      select: { id: true },
    });
    if (racedRunning) {
      return {
        busy: true,
        cancelledJobs: cancelled.count + radarBanAddJobsCancelled,
        whitelistReset: whitelist.count,
        banRemoteStateReset: bans.count,
        radarAutoBanZonesDisabled: disabledZones.count,
        radarAutoBanEventsSkipped: skippedEvents.count,
        radarBanFencesInvalidated: invalidatedFences.count,
        radarBansDeactivated: radarBans.count,
        radarBanSecretsDeleted: deletedRadarSecrets.count,
        radarBanAddJobsCancelled,
      };
    }

    return {
      busy: false,
      cancelledJobs: cancelled.count + radarBanAddJobsCancelled,
      whitelistReset: whitelist.count,
      banRemoteStateReset: bans.count,
      radarAutoBanZonesDisabled: disabledZones.count,
      radarAutoBanEventsSkipped: skippedEvents.count,
      radarBanFencesInvalidated: invalidatedFences.count,
      radarBansDeactivated: radarBans.count,
      radarBanSecretsDeleted: deletedRadarSecrets.count,
      radarBanAddJobsCancelled,
    };
  });
}
