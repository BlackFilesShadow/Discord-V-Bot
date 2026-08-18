import {
  withNitradoOutboxConnectionLock,
  type NitradoOutboxClient,
  type NitradoOutboxTxClient,
} from './outboxLock';

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
}

export interface NitradoRebindLifecycleResult {
  busy: boolean;
  cancelledJobs: number;
  whitelistReset: number;
  banRemoteStateReset: number;
}

/**
 * Nitrado-1U: Bereitet lokale Remote-Wahrheit atomar auf einen echten
 * Service-Rebind vor. Der Aufrufer MUSS bereits den kanonischen per-Connection
 * Config-Lock halten und diese Funktion innerhalb derselben DB-Transaktion wie
 * die Service-/Binding-Aenderung aufrufen.
 *
 * Die zusaetzliche Connection-weite Outbox-xact-Barriere serialisiert gegen
 * parallele Whitelist-/Ban-Enqueues. Ein bereits RUNNING Remote-Mutationsjob
 * blockiert den Rebind komplett: wir veraendern niemals die Service-Bindung
 * unter einem bereits geclaimten Worker. PENDING Intents, deren Bedeutung nur
 * aus dem alten Remote-Zustand stammt, werden terminalisiert. SERVER_BAN_ADD
 * bleibt erhalten, weil er einen lokalen aktiven Ban-Sollzustand darstellt und
 * den verschluesselten Identifier fuer eine sichere Anwendung am neuen Service
 * noch besitzt.
 */
export async function prepareNitradoRemoteStateForServiceRebind(
  client: NitradoOutboxClient,
  scope: { guildId: string; nitradoConnId: string },
): Promise<NitradoRebindLifecycleResult> {
  return withNitradoOutboxConnectionLock(client, scope, async txBase => {
    const tx = txBase as RebindLifecycleClient;

    const running = await tx.nitradoJob.findFirst({
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
        whitelistReset: 0,
        banRemoteStateReset: 0,
      };
    }

    const cancelled = await tx.nitradoJob.updateMany({
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
        updatedAt: new Date(),
      },
    });

    // Ein erneuter Blick nach dem PENDING-Update schliesst den Claim-Race:
    // gewinnt ein Worker PENDING->RUNNING unmittelbar vor unserem Update, ist
    // der Rebind weiterhin busy und die gesamte aufrufende Transaktion rollt
    // zurueck. Gewinnt unser UPDATE zuerst, kann der spaetere Claim nicht mehr
    // auf PENDING matchen.
    const racedRunning = await tx.nitradoJob.findFirst({
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
        cancelledJobs: cancelled.count,
        whitelistReset: 0,
        banRemoteStateReset: 0,
      };
    }

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

    // `appliedRemotely` ist eine Beobachtung des alten Nitrado-Service und darf
    // niemals in den neuen Service-Namespace uebernommen werden. Der lokale Ban
    // selbst bleibt erhalten; nur die Remote-Bestaetigung wird invalidiert.
    const bans = await tx.serverBanEntry.updateMany({
      where: {
        guildId: scope.guildId,
        nitradoConnId: scope.nitradoConnId,
        appliedRemotely: true,
      },
      data: { appliedRemotely: false },
    });

    return {
      busy: false,
      cancelledJobs: cancelled.count,
      whitelistReset: whitelist.count,
      banRemoteStateReset: bans.count,
    };
  });
}
