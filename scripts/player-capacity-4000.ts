import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
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
