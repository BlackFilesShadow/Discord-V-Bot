import {
  withNitradoOutboxConnectionLock,
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
 * Config-Lock halten und `client` MUSS der TransactionClient derselben
 * Service-/Binding-Aenderung sein.
 *
 * Lock-Reihenfolge gegen produktive Fachtransaktionen:
 * 1. lokale Whitelist-/Ban-Beobachtungszeilen werden innerhalb der bereits
 *    laufenden Rebind-Transaktion aktualisiert und damit row-gelockt;
 * 2. erst DANACH wird die Connection-weite Outbox-xact-Barriere genommen;
 * 3. dann werden aktive Jobs geprueft und stale PENDING-Intents bereinigt.
 *
 * Diese Reihenfolge verhindert einen Zyklus "Fachzeile -> Outbox-Lock" gegen
 * "Outbox-Lock -> Fachzeile", weil normale Whitelist-/Ban-Writer ihre lokale
 * Fachzeile vor dem Enqueue schreiben. Ein konkurrierender Writer commitet also
 * entweder komplett vor unserer Barriere oder wartet auf unsere Fachzeilen bis
 * nach dem Rebind. Jeder busy-Rueckgabewert fuehrt im Repository zu einem Throw
 * und rollt damit auch die vorgezogenen Beobachtungs-Updates atomar zurueck.
 *
 * SERVER_BAN_ADD bleibt als PENDING-Policy-Intent erhalten, weil er einen lokal
 * aktiven Ban-Sollzustand repraesentiert und noch den verschluesselten Identifier
 * besitzt. Remote-REMOVE-/Whitelist-Intents werden dagegen aus dem alten
 * Service-Namespace nicht blind in einen neuen Service uebernommen.
 */
export async function prepareNitradoRemoteStateForServiceRebind(
  client: NitradoOutboxTxClient,
  scope: { guildId: string; nitradoConnId: string },
): Promise<NitradoRebindLifecycleResult> {
  // Prisma-TransactionClients besitzen die zusaetzlichen Fachmodelle zur
  // Laufzeit. Die bewusst zweistufige Assertion macht diese Adapter-Grenze fuer
  // TypeScript explizit, ohne die generische Outbox-Schnittstelle kuenstlich um
  // Whitelist-/Ban-Modelle zu verbreitern.
  const tx = client as unknown as RebindLifecycleClient;

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
        updatedAt: new Date(),
      },
    });

    // Claim-Race: gewinnt ein Worker PENDING->RUNNING unmittelbar vor unserem
    // UPDATE, matcht das UPDATE diesen Job nicht. Der zweite Check macht den
    // gesamten Rebind daraufhin busy; Repository-Throw rollt alles zurueck.
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
        cancelledJobs: cancelled.count,
        whitelistReset: whitelist.count,
        banRemoteStateReset: bans.count,
      };
    }

    return {
      busy: false,
      cancelledJobs: cancelled.count,
      whitelistReset: whitelist.count,
      banRemoteStateReset: bans.count,
    };
  });
}
