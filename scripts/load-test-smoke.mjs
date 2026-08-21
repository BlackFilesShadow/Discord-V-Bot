/** Stage 50 — optional local load smoke. */
const base = process.env.LOAD_TEST_BASE_URL;
const concurrency = Number(process.env.LOAD_TEST_CONCURRENCY ?? 10);
const paths = (process.env.LOAD_TEST_PATHS ?? '/health').split(',').map((s) => s.trim());

if (!base) {
  console.log(JSON.stringify({ stage: 50, skipped: true, reason: 'LOAD_TEST_BASE_URL not set' }));
  process.exit(0);
}

const started = Date.now();
const results = await Promise.all(Array.from({ length: concurrency }, async (_, i) => {
  const path = paths[i % paths.length];
  const t0 = Date.now();
  try {
    const res = await fetch(new URL(path, base));
    return { ok: res.ok, status: res.status, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, error: String(e), ms: Date.now() - t0 };
  }
}));

const ok = results.filter((r) => r.ok).length;
console.log(JSON.stringify({
  stage: 50,
  skipped: false,
  concurrency,
  ok,
  fail: results.length - ok,
  totalMs: Date.now() - started,
  sample: results.slice(0, 5),
}, null, 2));
process.exit(ok === results.length ? 0 : 2);
