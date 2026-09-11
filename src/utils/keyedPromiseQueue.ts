/**
 * Serialisiert asynchrone Arbeiten strikt pro Key.
 *
 * Der jeweils neue Lauf haengt sich an den aktuell letzten Promise des Keys.
 * Dadurch bleiben auch 3+ nahezu gleichzeitige Aufrufe wirklich seriell; ein
 * fehlgeschlagener Vorgaenger blockiert die Queue nicht dauerhaft.
 */
export async function runKeyedSerial<T>(
  locks: Map<string, Promise<unknown>>,
  key: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const run = previous
    .catch(() => undefined)
    .then(work);

  locks.set(key, run);
  try {
    return await run;
  } finally {
    if (locks.get(key) === run) locks.delete(key);
  }
}
