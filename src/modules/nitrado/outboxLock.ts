import crypto from 'node:crypto';

/**
 * Minimale DB-Schnittstelle fuer eine atomare Nitrado-Outbox-Deduplizierung.
 *
 * Ein Prisma-Root-Client besitzt `$transaction`; ein bereits laufender
 * TransactionClient nicht. `withNitradoOutboxSubjectLock` funktioniert mit
 * beiden Varianten und stellt sicher, dass der PostgreSQL-xact-Lock bis zum
 * Commit der AUFRUFENDEN Transaktion gehalten wird.
 */
export interface NitradoOutboxTxClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  nitradoJob: {
    findMany(args: unknown): Promise<Array<{ payload: unknown }>>;
    create(args: unknown): Promise<unknown>;
  };
}

export interface NitradoOutboxRootClient extends NitradoOutboxTxClient {
  $transaction<T>(callback: (tx: NitradoOutboxTxClient) => Promise<T>): Promise<T>;
}

export type NitradoOutboxClient = NitradoOutboxTxClient | NitradoOutboxRootClient;

function isRootClient(client: NitradoOutboxClient): client is NitradoOutboxRootClient {
  return '$transaction' in client && typeof client.$transaction === 'function';
}

/**
 * Zwei int32-Lock-Keys aus SHA-256. Der Klartext des Subject-Key (z.B.
 * Spielername) wird dadurch niemals an PostgreSQL uebergeben oder geloggt.
 */
export function nitradoOutboxLockKeys(subjectKey: string): [number, number] {
  const digest = crypto.createHash('sha256').update(subjectKey).digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

async function lockedInTransaction<T>(
  tx: NitradoOutboxTxClient,
  subjectKey: string,
  work: (tx: NitradoOutboxTxClient) => Promise<T>,
): Promise<T> {
  const [key1, key2] = nitradoOutboxLockKeys(subjectKey);
  await tx.$queryRawUnsafe(
    'SELECT pg_advisory_xact_lock($1, $2)',
    key1,
    key2,
  );
  return work(tx);
}

/**
 * Cross-process atomare Grenze fuer "pruefen ob aktiver Job existiert -> ggf.
 * anlegen". Bei Root-Client wird eine eigene Transaktion erzeugt; bei einem
 * bestehenden TransactionClient bleibt der Lock Teil derselben Fachtransaktion
 * wie z.B. WhitelistEntry/BanRegistry-Aenderungen.
 */
export async function withNitradoOutboxSubjectLock<T>(
  client: NitradoOutboxClient,
  subjectKey: string,
  work: (tx: NitradoOutboxTxClient) => Promise<T>,
): Promise<T> {
  if (isRootClient(client)) {
    return client.$transaction(tx => lockedInTransaction(tx, subjectKey, work));
  }
  return lockedInTransaction(client, subjectKey, work);
}
