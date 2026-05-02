/**
 * Observability Service (P3).
 *
 * Zentrales Sammelbecken fuer Laufzeit-Metriken im DEV-Portal:
 *
 *  1. Prisma-Latenz
 *     - `attachPrismaLatencyMiddleware(prisma)` haengt einen `$use`-Hook an, der
 *       jede Query mit Dauer (ms) und Erfolg/Fehler in einen Ring-Buffer pro
 *       `model:action` schreibt (z. B. `User:findMany`).
 *     - `getPrismaSnapshot()` liefert Count + p50/p95/p99 + Error-Rate je
 *       Bucket. Buckets sind pro Bucket kapaziert (PRISMA_BUCKET_CAP) und
 *       global kapaziert (PRISMA_MAX_BUCKETS), damit der Speicher nicht
 *       waechst.
 *
 *  2. AI-Call-Tracing
 *     - `traceAiCall(provider, action, fn)` wickelt einen async Aufruf ein
 *       und persistiert Dauer + Erfolg in den AI-Ring-Buffer.
 *     - `getAiSnapshot()` liefert je Provider+Action: Count, p50/p95/p99,
 *       Error-Rate, lastTs.
 *
 *  3. Live-Logs Ring-Buffer
 *     - `attachLogRingBuffer(logger)` haengt einen Winston-Stream-Transport an
 *       (idempotent), der die letzten LOG_RING_CAP Eintraege im RAM haelt.
 *     - `queryLogRing({level?, q?, sinceTs?, limit?})` filtert das Buffer
 *       deterministisch (case-insensitive Substring auf message + meta-JSON).
 *     - Als kleiner Speicher-Schutz wird die Meta-Stringification auf
 *       LOG_META_MAX_BYTES begrenzt.
 *
 *  4. Backup-Status
 *     - `readBackupStatus()` liest `backup/`-Verzeichnis (oder den BACKUP_DIR
 *       env), listet `backup_*`-Folder mit Groesse + mtime + Anzahl Dateien.
 *
 * Alle Strukturen sind ohne externe Abhaengigkeiten und vollstaendig
 * deterministisch testbar via `__resetObservabilityForTests()`.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'winston';

// ============================================================
// 1) Prisma-Latenz
// ============================================================

const PRISMA_BUCKET_CAP = 500; // letzte N Samples pro model:action
const PRISMA_MAX_BUCKETS = 256; // hard cap, gegen unbegrenzte Action-Namen

interface LatencySample {
  ms: number;
  ok: boolean;
  ts: number;
}

interface LatencyBucket {
  samples: LatencySample[];
  totalCount: number;
  errorCount: number;
}

const prismaBuckets = new Map<string, LatencyBucket>();

function ensureBucket(key: string): LatencyBucket | null {
  let b = prismaBuckets.get(key);
  if (b) return b;
  if (prismaBuckets.size >= PRISMA_MAX_BUCKETS) return null;
  b = { samples: [], totalCount: 0, errorCount: 0 };
  prismaBuckets.set(key, b);
  return b;
}

function pushLatency(key: string, ms: number, ok: boolean): void {
  const b = ensureBucket(key);
  if (!b) return;
  if (b.samples.length >= PRISMA_BUCKET_CAP) b.samples.shift();
  b.samples.push({ ms, ok, ts: Date.now() });
  b.totalCount += 1;
  if (!ok) b.errorCount += 1;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

export interface PrismaBucketSnapshot {
  key: string;
  count: number;
  totalCount: number;
  errorCount: number;
  errorRate: number;
  p50: number;
  p95: number;
  p99: number;
  lastTs: number | null;
}

export function getPrismaSnapshot(): PrismaBucketSnapshot[] {
  const out: PrismaBucketSnapshot[] = [];
  for (const [key, b] of prismaBuckets) {
    const dur = b.samples.map(s => s.ms).sort((a, b) => a - b);
    out.push({
      key,
      count: b.samples.length,
      totalCount: b.totalCount,
      errorCount: b.errorCount,
      errorRate: b.totalCount > 0 ? b.errorCount / b.totalCount : 0,
      p50: percentile(dur, 50),
      p95: percentile(dur, 95),
      p99: percentile(dur, 99),
      lastTs: b.samples.length > 0 ? b.samples[b.samples.length - 1].ts : null,
    });
  }
  out.sort((a, b) => b.totalCount - a.totalCount);
  return out;
}

// Minimal-Interface, damit wir nicht den vollen PrismaClient importieren muessen.
interface PrismaWithUse {
  $use: (mw: (params: { model?: string; action: string }, next: (p: unknown) => Promise<unknown>) => Promise<unknown>) => void;
}

let prismaMiddlewareAttached = false;

export function attachPrismaLatencyMiddleware(prisma: PrismaWithUse): void {
  if (prismaMiddlewareAttached) return;
  prismaMiddlewareAttached = true;
  prisma.$use(async (params, next) => {
    const start = process.hrtime.bigint();
    const key = `${params.model ?? 'raw'}:${params.action}`;
    try {
      const res = await next(params);
      const ms = Number((process.hrtime.bigint() - start) / 1_000_000n);
      pushLatency(key, ms, true);
      return res;
    } catch (err) {
      const ms = Number((process.hrtime.bigint() - start) / 1_000_000n);
      pushLatency(key, ms, false);
      throw err;
    }
  });
}

// Test-Helper: erlaubt direktes Einspeisen von Samples ohne Prisma.
export function __recordPrismaLatencyForTests(model: string, action: string, ms: number, ok: boolean): void {
  pushLatency(`${model}:${action}`, ms, ok);
}

// ============================================================
// 2) AI-Call-Tracing
// ============================================================

const AI_BUCKET_CAP = 500;
const AI_MAX_BUCKETS = 128;

const aiBuckets = new Map<string, LatencyBucket>();

function pushAi(key: string, ms: number, ok: boolean): void {
  let b = aiBuckets.get(key);
  if (!b) {
    if (aiBuckets.size >= AI_MAX_BUCKETS) return;
    b = { samples: [], totalCount: 0, errorCount: 0 };
    aiBuckets.set(key, b);
  }
  if (b.samples.length >= AI_BUCKET_CAP) b.samples.shift();
  b.samples.push({ ms, ok, ts: Date.now() });
  b.totalCount += 1;
  if (!ok) b.errorCount += 1;
}

export interface AiBucketSnapshot {
  provider: string;
  action: string;
  count: number;
  totalCount: number;
  errorCount: number;
  errorRate: number;
  p50: number;
  p95: number;
  p99: number;
  lastTs: number | null;
}

export function getAiSnapshot(): AiBucketSnapshot[] {
  const out: AiBucketSnapshot[] = [];
  for (const [key, b] of aiBuckets) {
    const [provider, action] = key.split('::');
    const dur = b.samples.map(s => s.ms).sort((a, b) => a - b);
    out.push({
      provider,
      action,
      count: b.samples.length,
      totalCount: b.totalCount,
      errorCount: b.errorCount,
      errorRate: b.totalCount > 0 ? b.errorCount / b.totalCount : 0,
      p50: percentile(dur, 50),
      p95: percentile(dur, 95),
      p99: percentile(dur, 99),
      lastTs: b.samples.length > 0 ? b.samples[b.samples.length - 1].ts : null,
    });
  }
  out.sort((a, b) => b.totalCount - a.totalCount);
  return out;
}

export async function traceAiCall<T>(provider: string, action: string, fn: () => Promise<T>): Promise<T> {
  const start = process.hrtime.bigint();
  const key = `${provider}::${action}`;
  try {
    const res = await fn();
    const ms = Number((process.hrtime.bigint() - start) / 1_000_000n);
    pushAi(key, ms, true);
    return res;
  } catch (err) {
    const ms = Number((process.hrtime.bigint() - start) / 1_000_000n);
    pushAi(key, ms, false);
    throw err;
  }
}

// ============================================================
// 3) Live-Logs Ring-Buffer
// ============================================================

const LOG_RING_CAP = 1000;
const LOG_META_MAX_BYTES = 4096;

export interface LogEntry {
  ts: number;
  level: string;
  message: string;
  meta?: string; // serialisiert (gekuerzt)
}

const logRing: LogEntry[] = [];

function pushLog(entry: LogEntry): void {
  // Defensive: Winston/Drittquellen koennen Eintraege ohne `level` oder
  // `message` durchreichen. Sanitize hier zentral, damit downstream
  // (queryLogRing) niemals undefined.toLowerCase() crashed.
  const safe: LogEntry = {
    ts: typeof entry.ts === 'number' ? entry.ts : Date.now(),
    level: typeof entry.level === 'string' && entry.level ? entry.level : 'info',
    message: typeof entry.message === 'string' ? entry.message : safeString(entry.message),
    meta: typeof entry.meta === 'string' ? entry.meta : undefined,
  };
  if (logRing.length >= LOG_RING_CAP) logRing.shift();
  logRing.push(safe);
}

let logTransportAttached = false;

interface LogInfo {
  level: string;
  message?: unknown;
  [key: string]: unknown;
}

// Eigener Transport, der Logs in den Ring-Buffer pushed. Kein Import von
// 'winston-transport', um die Abhaengigkeit nicht zu verbreitern.
//
// HINWEIS: Winston wrapped Nicht-Transport-Objekte automatisch als
// LegacyTransportStream. Dabei kann `.log(info, callback)` mit callback=undefined
// aufgerufen werden (wenn der Stream-Adapter den Callback nicht weiterreicht).
// Deshalb MUSS callback optional sein und defensive geprueft werden, sonst
// crashed der Boot mit "callback is not a function".
class RingTransport {
  level?: string;
  silent?: boolean;
  log(info: LogInfo, callback?: () => void): void {
    try {
      const { level, message, ...rest } = info;
      const metaStr = Object.keys(rest).length > 0
        ? JSON.stringify(rest, jsonReplacer).slice(0, LOG_META_MAX_BYTES)
        : undefined;
      pushLog({
        ts: Date.now(),
        level,
        message: typeof message === 'string' ? message : safeString(message),
        meta: metaStr,
      });
    } catch { /* swallow — logging muss verlustfrei weiterlaufen */ }
    if (typeof callback === 'function') callback();
  }
  // Stream-API-Stubs, falls Winston den Transport als Stream behandelt.
  write(info: LogInfo, _enc?: unknown, cb?: () => void): boolean {
    this.log(info, cb);
    return true;
  }
  end(cb?: () => void): void { if (typeof cb === 'function') cb(); }
  on(): this { return this; }
  once(): this { return this; }
  emit(): boolean { return true; }
  removeListener(): this { return this; }
  removeAllListeners(): this { return this; }
}

function jsonReplacer(_k: string, v: unknown): unknown {
  if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack?.slice(0, 1024) };
  return v;
}

function safeString(v: unknown): string {
  try { return typeof v === 'string' ? v : JSON.stringify(v); } catch { return String(v); }
}

export function attachLogRingBuffer(logger: Logger): void {
  if (logTransportAttached) return;
  logTransportAttached = true;
  // winston.add akzeptiert ein Transport-aehnliches Objekt; der Ring-Transport
  // erfuellt das minimale Interface.
  logger.add(new RingTransport() as unknown as Parameters<Logger['add']>[0]);
}

export interface LogQuery {
  level?: string;
  q?: string;
  sinceTs?: number;
  limit?: number;
}

export function queryLogRing(opts: LogQuery): LogEntry[] {
  const limit = Math.min(500, Math.max(1, opts.limit ?? 100));
  const needle = opts.q?.toLowerCase();
  const lvl = opts.level?.toLowerCase();
  const since = opts.sinceTs;
  const out: LogEntry[] = [];
  for (let i = logRing.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const e = logRing[i];
    const eLevel = String(e.level ?? '').toLowerCase();
    if (lvl && eLevel !== lvl) continue;
    if (since && e.ts < since) continue;
    if (needle) {
      const haystack = `${e.message ?? ''} ${e.meta ?? ''}`.toLowerCase();
      if (!haystack.includes(needle)) continue;
    }
    out.push(e);
  }
  return out;
}

// Test-Helper.
export function __pushLogForTests(entry: LogEntry): void { pushLog(entry); }

// ============================================================
// 4) Backup-Status
// ============================================================

export interface BackupEntry {
  name: string;
  bytes: number;
  files: number;
  mtimeMs: number;
  ageMs: number;
}

export interface BackupStatus {
  dir: string;
  exists: boolean;
  count: number;
  newest: BackupEntry | null;
  oldest: BackupEntry | null;
  totalBytes: number;
  entries: BackupEntry[]; // bis MAX_BACKUP_LIST
}

const MAX_BACKUP_LIST = 20;

async function dirSize(dir: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  let entries: string[] = [];
  try { entries = await fs.readdir(dir); } catch { return { bytes, files }; }
  for (const name of entries) {
    const full = path.join(dir, name);
    let st;
    try { st = await fs.stat(full); } catch { continue; }
    if (st.isFile()) { bytes += st.size; files += 1; }
    else if (st.isDirectory()) {
      const sub = await dirSize(full);
      bytes += sub.bytes; files += sub.files;
    }
  }
  return { bytes, files };
}

export async function readBackupStatus(rootArg?: string): Promise<BackupStatus> {
  const dir = rootArg ?? process.env.BACKUP_DIR ?? path.resolve(process.cwd(), 'backup');
  let names: string[] = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return { dir, exists: false, count: 0, newest: null, oldest: null, totalBytes: 0, entries: [] };
  }
  const candidates = names.filter(n => n.startsWith('backup_'));
  const now = Date.now();
  const entries: BackupEntry[] = [];
  for (const n of candidates) {
    const full = path.join(dir, n);
    let st;
    try { st = await fs.stat(full); } catch { continue; }
    if (!st.isDirectory()) continue;
    const sz = await dirSize(full);
    entries.push({
      name: n,
      bytes: sz.bytes,
      files: sz.files,
      mtimeMs: st.mtimeMs,
      ageMs: now - st.mtimeMs,
    });
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const totalBytes = entries.reduce((sum, e) => sum + e.bytes, 0);
  return {
    dir,
    exists: true,
    count: entries.length,
    newest: entries[0] ?? null,
    oldest: entries[entries.length - 1] ?? null,
    totalBytes,
    entries: entries.slice(0, MAX_BACKUP_LIST),
  };
}

// ============================================================
// Test-Reset
// ============================================================

export function __resetObservabilityForTests(): void {
  prismaBuckets.clear();
  aiBuckets.clear();
  logRing.length = 0;
  prismaMiddlewareAttached = false;
  logTransportAttached = false;
}
