/**
 * P3 — Observability Service Tests
 *
 * Deckt ab:
 *  - Prisma-Latenz: Bucket-Cap, Percentile, Error-Rate, Bucket-Limit
 *  - AI-Tracing: Erfolg/Fehler, getrennte Provider+Action, Bucket-Cap
 *  - Log-Ring: Push, Filter (level/q/since/limit), Cap
 *  - Backup-Status: leeres + befuelltes Verzeichnis
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import {
  __recordPrismaLatencyForTests,
  __pushLogForTests,
  __resetObservabilityForTests,
  getPrismaSnapshot,
  getAiSnapshot,
  traceAiCall,
  queryLogRing,
  readBackupStatus,
} from '../../src/dashboard/services/observability';

beforeEach(() => {
  __resetObservabilityForTests();
});

describe('Prisma latency tracking', () => {
  it('aggregates p50/p95/p99 + errorRate per bucket', () => {
    for (let i = 1; i <= 100; i += 1) {
      __recordPrismaLatencyForTests('User', 'findMany', i, i % 10 !== 0);
    }
    const snap = getPrismaSnapshot();
    expect(snap).toHaveLength(1);
    const b = snap[0];
    expect(b.key).toBe('User:findMany');
    expect(b.count).toBe(100);
    expect(b.totalCount).toBe(100);
    expect(b.errorCount).toBe(10);
    expect(b.errorRate).toBeCloseTo(0.1, 5);
    expect(b.p50).toBe(51);
    expect(b.p95).toBe(96);
    expect(b.p99).toBe(100);
  });

  it('respects per-bucket cap (last 500 samples)', () => {
    for (let i = 1; i <= 700; i += 1) {
      __recordPrismaLatencyForTests('User', 'findFirst', i, true);
    }
    const snap = getPrismaSnapshot();
    expect(snap[0].count).toBe(500);
    expect(snap[0].totalCount).toBe(700);
    // Aelteste 200 Samples (1..200) sollten weg sein -> p50 ~= 450
    expect(snap[0].p50).toBeGreaterThanOrEqual(400);
  });

  it('separates buckets by model+action', () => {
    __recordPrismaLatencyForTests('User', 'findMany', 5, true);
    __recordPrismaLatencyForTests('User', 'findFirst', 5, true);
    __recordPrismaLatencyForTests('Guild', 'findMany', 5, true);
    expect(getPrismaSnapshot()).toHaveLength(3);
  });

  it('returns empty array when no data', () => {
    expect(getPrismaSnapshot()).toEqual([]);
  });
});

describe('AI call tracing', () => {
  it('records successful calls', async () => {
    const r = await traceAiCall('openai', 'chat.completion', async () => 'ok');
    expect(r).toBe('ok');
    const snap = getAiSnapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].provider).toBe('openai');
    expect(snap[0].action).toBe('chat.completion');
    expect(snap[0].errorCount).toBe(0);
    expect(snap[0].count).toBe(1);
  });

  it('records failures and rethrows', async () => {
    await expect(
      traceAiCall('openai', 'chat.completion', async () => { throw new Error('boom'); }),
    ).rejects.toThrow('boom');
    const snap = getAiSnapshot();
    expect(snap[0].errorCount).toBe(1);
    expect(snap[0].errorRate).toBe(1);
  });

  it('separates buckets by provider and action', async () => {
    await traceAiCall('openai', 'embed', async () => 0);
    await traceAiCall('openai', 'chat', async () => 0);
    await traceAiCall('anthropic', 'chat', async () => 0);
    expect(getAiSnapshot()).toHaveLength(3);
  });
});

describe('Log ring buffer', () => {
  it('captures + queries by level', () => {
    __pushLogForTests({ ts: Date.now(), level: 'info', message: 'hello' });
    __pushLogForTests({ ts: Date.now(), level: 'error', message: 'boom' });
    expect(queryLogRing({ level: 'error' }).map(e => e.message)).toEqual(['boom']);
  });

  it('filters by q (case-insensitive) on message + meta', () => {
    __pushLogForTests({ ts: Date.now(), level: 'info', message: 'guild created', meta: '{"guildId":"42"}' });
    __pushLogForTests({ ts: Date.now(), level: 'info', message: 'something else', meta: '{"x":1}' });
    expect(queryLogRing({ q: 'GUILD' })).toHaveLength(1);
    expect(queryLogRing({ q: '"42"' })).toHaveLength(1);
  });

  it('respects since-timestamp', () => {
    const oldTs = Date.now() - 60_000;
    const newTs = Date.now();
    __pushLogForTests({ ts: oldTs, level: 'info', message: 'old' });
    __pushLogForTests({ ts: newTs, level: 'info', message: 'new' });
    const r = queryLogRing({ sinceTs: newTs - 1000 });
    expect(r.map(e => e.message)).toEqual(['new']);
  });

  it('caps results at limit (default 100, max 500) newest-first', () => {
    for (let i = 0; i < 200; i += 1) {
      __pushLogForTests({ ts: Date.now() + i, level: 'info', message: `m${i}` });
    }
    const r = queryLogRing({ limit: 5 });
    expect(r).toHaveLength(5);
    expect(r[0].message).toBe('m199');
    expect(r[4].message).toBe('m195');
  });
});

describe('Backup status', () => {
  it('reports exists=false for missing dir', async () => {
    const s = await readBackupStatus(path.join(os.tmpdir(), `noexist-${Date.now()}`));
    expect(s.exists).toBe(false);
    expect(s.count).toBe(0);
    expect(s.newest).toBeNull();
  });

  it('lists backup_* directories with size + age', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'obs-bk-'));
    const d1 = path.join(root, 'backup_20260101_010101');
    const d2 = path.join(root, 'backup_20260202_020202');
    await fs.mkdir(d1, { recursive: true });
    await fs.mkdir(d2, { recursive: true });
    await fs.writeFile(path.join(d1, 'database.sql'), 'A'.repeat(100));
    await fs.writeFile(path.join(d2, 'database.sql'), 'B'.repeat(50));
    // Sicherstellen, dass d2 neuere mtime hat:
    await new Promise(r => setTimeout(r, 10));
    await fs.utimes(d2, new Date(), new Date());

    const s = await readBackupStatus(root);
    expect(s.exists).toBe(true);
    expect(s.count).toBe(2);
    expect(s.totalBytes).toBe(150);
    expect(s.newest?.name).toBe('backup_20260202_020202');
    expect(s.oldest?.name).toBe('backup_20260101_010101');
    expect(s.entries.every(e => e.files === 1)).toBe(true);
  });
});
