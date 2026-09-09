/** Bounded async worker pool for independent, scoped runtime items. */
export async function forEachBounded<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('concurrency must be a positive integer');
  }
  if (items.length === 0) return;

  let cursor = 0;
  const failures: unknown[] = [];
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        await worker(items[index]);
      } catch (error) {
        failures.push(error);
      }
    }
  });

  await Promise.all(runners);
  if (failures.length > 0) {
    throw new AggregateError(failures, `${failures.length} bounded worker task(s) failed`);
  }
}
