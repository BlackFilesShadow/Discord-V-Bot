import { runKeyedSerial } from '../../src/utils/keyedPromiseQueue';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(res => { resolve = res; });
  return { promise, resolve };
}

describe('runKeyedSerial', () => {
  it('serialisiert auch drei gleichzeitig gestartete Arbeiten desselben Keys strikt', async () => {
    const locks = new Map<string, Promise<unknown>>();
    const gates = [deferred(), deferred(), deferred()];
    const started: number[] = [];
    const finished: number[] = [];
    let active = 0;
    let maxActive = 0;

    const runs = gates.map((gate, index) => runKeyedSerial(locks, 'faction-a', async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      started.push(index + 1);
      await gate.promise;
      finished.push(index + 1);
      active--;
      return index + 1;
    }));

    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual([1]);

    gates[0].resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual([1, 2]);

    gates[1].resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual([1, 2, 3]);

    gates[2].resolve();
    await expect(Promise.all(runs)).resolves.toEqual([1, 2, 3]);
    expect(finished).toEqual([1, 2, 3]);
    expect(maxActive).toBe(1);
    expect(locks.size).toBe(0);
  });

  it('laesst den naechsten Lauf nach einem Fehler des Vorgaengers weiterlaufen', async () => {
    const locks = new Map<string, Promise<unknown>>();
    const first = runKeyedSerial(locks, 'same', async () => {
      throw new Error('boom');
    });
    const second = runKeyedSerial(locks, 'same', async () => 'ok');

    await expect(first).rejects.toThrow('boom');
    await expect(second).resolves.toBe('ok');
    expect(locks.size).toBe(0);
  });

  it('blockiert unterschiedliche Keys nicht gegenseitig', async () => {
    const locks = new Map<string, Promise<unknown>>();
    const gateA = deferred();
    const gateB = deferred();
    const started: string[] = [];

    const a = runKeyedSerial(locks, 'a', async () => { started.push('a'); await gateA.promise; });
    const b = runKeyedSerial(locks, 'b', async () => { started.push('b'); await gateB.promise; });

    await Promise.resolve();
    await Promise.resolve();
    expect(new Set(started)).toEqual(new Set(['a', 'b']));

    gateA.resolve();
    gateB.resolve();
    await Promise.all([a, b]);
  });
});
