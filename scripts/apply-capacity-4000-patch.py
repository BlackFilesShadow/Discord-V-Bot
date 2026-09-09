from pathlib import Path
import json

# Add the bounded worker pool and its 4,000-item regression.
Path('src/utils/boundedConcurrency.ts').write_text("""/** Bounded async worker pool for independent, scoped runtime items. */
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
""", encoding='utf-8')

p = Path('tests/utils/boundedConcurrency.test.ts')
p.parent.mkdir(parents=True, exist_ok=True)
p.write_text("""import { forEachBounded } from '../../src/utils/boundedConcurrency';

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
""", encoding='utf-8')

replacements = {
  'src/modules/nitrado/adm/admLiveSyncCron.ts': [
    ("import { logger, logAudit } from '../../../utils/logger';", "import { logger, logAudit } from '../../../utils/logger';\nimport { forEachBounded } from '../../../utils/boundedConcurrency';"),
    ("const MAX_FILES_PER_TICK = 8;", "const MAX_FILES_PER_TICK = 8;\n// Independent server scopes may progress concurrently. Three workers stay well\n// below the Prisma pool (10) while avoiding a serial multi-server sweep stall.\nconst CONNECTION_SWEEP_CONCURRENCY = 3;"),
    ("    for (const connection of connections) await processConnection(connection);", "    await forEachBounded(connections, CONNECTION_SWEEP_CONCURRENCY, processConnection);"),
  ],
  'src/modules/nitrado/adm/admPostProcessCron.ts': [
    ("import { logger } from '../../../utils/logger';", "import { logger } from '../../../utils/logger';\nimport { forEachBounded } from '../../../utils/boundedConcurrency';"),
    ("const INTERVAL_MS = 60_000;", "const INTERVAL_MS = 60_000;\nconst CONNECTION_SWEEP_CONCURRENCY = 3;"),
    ("    for (const connection of connections) await processConnection(connection);", "    await forEachBounded(connections, CONNECTION_SWEEP_CONCURRENCY, processConnection);"),
  ],
  'src/modules/gameplayFeeds/runtime.ts': [
    ("import { logger } from '../../utils/logger';", "import { logger } from '../../utils/logger';\nimport { forEachBounded } from '../../utils/boundedConcurrency';"),
    ("const PVP_ENRICHMENT_TIMEOUT_MS = 2_000;", "const PVP_ENRICHMENT_TIMEOUT_MS = 2_000;\nconst CONFIG_SWEEP_CONCURRENCY = 4;"),
    ("    for (const config of configs) await processConfig(config);", "    await forEachBounded(configs, CONFIG_SWEEP_CONCURRENCY, processConfig);"),
  ],
  'src/modules/radar/runtime.ts': [
    ("import { logger } from '../../utils/logger';", "import { logger } from '../../utils/logger';\nimport { forEachBounded } from '../../utils/boundedConcurrency';"),
    ("const MAX_DELIVERY_ATTEMPTS = 8;", "const MAX_DELIVERY_ATTEMPTS = 8;\nconst CONFIG_SWEEP_CONCURRENCY = 3;"),
    ("    for (const config of configs) await processConfig(config);", "    await forEachBounded(configs, CONFIG_SWEEP_CONCURRENCY, processConfig);"),
  ],
}
for filename, edits in replacements.items():
  path = Path(filename)
  text = path.read_text(encoding='utf-8')
  for old, new in edits:
    if new in text:
      continue
    if old not in text:
      raise SystemExit(f'missing patch anchor in {filename}: {old}')
    text = text.replace(old, new, 1)
  path.write_text(text, encoding='utf-8')

# A live-PostgreSQL 4,000-player canonical-ingest/idempotency/roster gate.
Path('scripts/player-capacity-4000.ts').write_text("""import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import crypto from 'node:crypto';
import prisma from '../src/database/prisma';
import { persistAdmEvents, type RawAdmEvent } from '../src/modules/nitrado/adm/serverLogIngestor';
import { resolveOnlinePresence, attachCurrentPositions, type PlayerPresenceEvent, type PlayerPositionEvent } from '../src/modules/gameplayFeeds/playerListRoster';

const PLAYERS = 4000;
const guildId = `capacity-${crypto.randomUUID()}`;
const nitradoConnId = `capacity-${crypto.randomUUID()}`;
const fileIdentity = `capacity-${crypto.randomUUID()}.ADM`;

function capacityEvent(index: number): RawAdmEvent {
  const byteStart = index * 128;
  return {
    byteStart,
    byteEnd: byteStart + 128,
    eventType: 'PLAYER_POSITION',
    occurredAt: new Date(1_800_000_000_000 + index),
    actorGameId: `game-${index}`,
    actorName: `Player ${index}`,
    targetGameId: null,
    targetName: null,
    objectType: null,
    toolOrWeapon: null,
    distanceMeters: null,
    actorPosition: `${1000 + index % 12000}, ${2000 + index % 12000}, 10`,
    targetPosition: null,
    rawLine: `Player Player ${index} pos`,
    parseStatus: 'PARSED',
  } as RawAdmEvent;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  const started = performance.now();
  const events = Array.from({ length: PLAYERS }, (_, index) => capacityEvent(index));
  const result = { players: PLAYERS, inserted: 0, replayInserted: 0, stored: 0, cursor: 0, roster: 0, elapsedMs: 0, eventLoopP99Ms: 0 };
  try {
    const meta = { fileIdentity, fileName: fileIdentity, sourceFile: fileIdentity, lastModifiedAt: 1, fileSize: PLAYERS * 128 };
    const ingest = { events, newOffset: PLAYERS * 128, trailingPartial: '', wasReset: false };
    const fingerprint = crypto.createHash('sha256').update('capacity').digest('hex');
    result.inserted = (await persistAdmEvents(prisma as any, { guildId, nitradoConnId }, meta, ingest, fingerprint)).inserted;
    result.replayInserted = (await persistAdmEvents(prisma as any, { guildId, nitradoConnId }, meta, ingest, fingerprint)).inserted;
    result.stored = await prisma.admEvent.count({ where: { guildId, nitradoConnId } });
    const cursor = await prisma.admSourceCursor.findUnique({ where: { guildId_nitradoConnId_fileIdentity: { guildId, nitradoConnId, fileIdentity } } });
    result.cursor = Number(cursor?.processedByteOffset ?? 0n);

    const presence: PlayerPresenceEvent[] = events.map((item, index) => ({ id: `p-${index}`, eventType: 'PLAYER_CONNECTED', actorGameId: item.actorGameId, actorName: item.actorName, sourceByteStart: BigInt(item.byteStart) }));
    const positions: PlayerPositionEvent[] = events.map((item, index) => ({ id: `x-${index}`, actorGameId: item.actorGameId, actorName: item.actorName, actorPosition: item.actorPosition, sourceByteStart: BigInt(item.byteStart + 1) }));
    result.roster = attachCurrentPositions(resolveOnlinePresence(presence, positions), positions).length;
    result.elapsedMs = Number((performance.now() - started).toFixed(2));
    result.eventLoopP99Ms = Number((loop.percentile(99) / 1_000_000).toFixed(3));
    console.log(JSON.stringify(result, null, 2));

    if (result.inserted !== PLAYERS) throw new Error(`first ingest lost rows: ${result.inserted}/${PLAYERS}`);
    if (result.replayInserted !== 0) throw new Error(`replay was not idempotent: ${result.replayInserted}`);
    if (result.stored !== PLAYERS) throw new Error(`stored rows mismatch: ${result.stored}`);
    if (result.cursor !== PLAYERS * 128) throw new Error(`cursor mismatch: ${result.cursor}`);
    if (result.roster !== PLAYERS) throw new Error(`roster mismatch: ${result.roster}`);
    if (result.elapsedMs > 30_000) throw new Error(`capacity run exceeded 30s: ${result.elapsedMs}`);
    if (result.eventLoopP99Ms > 500) throw new Error(`event loop p99 too high: ${result.eventLoopP99Ms}`);
  } finally {
    loop.disable();
    await prisma.admSourceCursor.deleteMany({ where: { guildId, nitradoConnId } }).catch(() => undefined);
    await prisma.admEvent.deleteMany({ where: { guildId, nitradoConnId } }).catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
""", encoding='utf-8')

pkg = Path('package.json')
data = json.loads(pkg.read_text(encoding='utf-8'))
data['scripts']['perf:players-4000'] = 'ts-node scripts/player-capacity-4000.ts'
pkg.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
