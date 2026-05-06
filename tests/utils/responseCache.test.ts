/**
 * responseCache: Memory-Backend (Default in CI ohne REDIS_URL).
 */

// REDIS_URL muss VOR dem Import des Moduls weg sein, damit memory-Backend aktiv ist
delete process.env.REDIS_URL;

import { cached, __resetResponseCache, __getBackendForTests } from '../../src/utils/responseCache';

describe('responseCache (memory backend)', () => {
  beforeEach(() => __resetResponseCache());

  it('produziert beim ersten Call und cached danach', async () => {
    const producer = jest.fn(async () => 'wert-1');
    const a = await cached('ns', ['k'], 60, producer);
    const b = await cached('ns', ['k'], 60, producer);
    expect(a).toBe('wert-1');
    expect(b).toBe('wert-1');
    expect(producer).toHaveBeenCalledTimes(1);
  });

  it('separiert per namespace', async () => {
    const p1 = jest.fn(async () => 'A');
    const p2 = jest.fn(async () => 'B');
    await cached('ns1', ['x'], 60, p1);
    await cached('ns2', ['x'], 60, p2);
    expect(p1).toHaveBeenCalledTimes(1);
    expect(p2).toHaveBeenCalledTimes(1);
  });

  it('separiert per keyParts', async () => {
    const producer = jest.fn(async (n: number) => `wert-${n}`);
    let i = 0;
    await cached('ns', ['a'], 60, () => producer(++i));
    await cached('ns', ['b'], 60, () => producer(++i));
    expect(producer).toHaveBeenCalledTimes(2);
  });

  it('TTL-Ablauf invalidiert den Eintrag', async () => {
    jest.useFakeTimers();
    const producer = jest.fn(async () => Math.random().toString());
    const v1 = await cached('ns', ['ttl'], 1, producer);
    jest.setSystemTime(Date.now() + 2000);
    const v2 = await cached('ns', ['ttl'], 1, producer);
    expect(v1).not.toBe(v2);
    expect(producer).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  it('Backend ist memory ohne REDIS_URL', () => {
    expect(__getBackendForTests()).toBe('memory');
  });

  it('keyParts mit identischem Inhalt = identischer Hash', async () => {
    const p = jest.fn(async () => 'x');
    await cached('ns', ['a', 'b'], 60, p);
    await cached('ns', ['a', 'b'], 60, p);
    expect(p).toHaveBeenCalledTimes(1);
  });
});
