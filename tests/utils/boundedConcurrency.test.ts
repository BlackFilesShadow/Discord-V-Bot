import { forEachBounded } from '../../src/utils/boundedConcurrency';

describe('forEachBounded', () => {
  it('processes 4000 items exactly once while respecting the concurrency ceiling', async () => {
    let active = 0;
    let peak = 0;
    const seen: number[] = [];
    await forEachBounded(Array.from({ length: 4000 }, (_, index) => index), 4, async item => {
      active += 1;
      peak = Math.max(peak, active);
      if (item % 127 === 0) await new Promise(resolve => setImmediate(resolve));
      seen.push(item);
      active -= 1;
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(seen).toHaveLength(4000);
    expect(new Set(seen).size).toBe(4000);
  });

  it('waits for all work and reports failures without abandoning later items', async () => {
    const seen: number[] = [];
    await expect(forEachBounded([1, 2, 3, 4, 5], 2, async item => {
      seen.push(item);
      if (item === 2 || item === 4) throw new Error(`boom-${item}`);
    })).rejects.toBeInstanceOf(AggregateError);
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
  });
});
