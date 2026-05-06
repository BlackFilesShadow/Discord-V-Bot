/**
 * Smoke-Tests fuer das Prometheus-Metrics-Modul.
 *
 * Wir wollen sicherstellen, dass alle exportierten Counter/Histogram/Gauge
 * im selben Registry registriert sind und dass `register.metrics()` ein
 * gueltiges Prometheus-Text-Format liefert (Standard 0.0.4).
 */

import {
  metricsRegistry,
  commandCounter,
  commandDurationHistogram,
  errorCounter,
  guildGauge,
  wsLatencyGauge,
  dbQueryHistogram,
  rateLimitedCounter,
  timed,
} from '../../src/utils/metrics';
import { Histogram } from 'prom-client';

describe('metrics', () => {
  it('registriert alle Custom-Metriken in der Registry', async () => {
    const text = await metricsRegistry.metrics();
    expect(text).toMatch(/vbot_commands_total/);
    expect(text).toMatch(/vbot_command_duration_seconds/);
    expect(text).toMatch(/vbot_errors_total/);
    expect(text).toMatch(/vbot_guilds/);
    expect(text).toMatch(/vbot_discord_ws_latency_ms/);
    expect(text).toMatch(/vbot_db_query_duration_seconds/);
    expect(text).toMatch(/vbot_rate_limited_total/);
    // Default-Process-Metriken via collectDefaultMetrics({prefix:'vbot_'})
    expect(text).toMatch(/vbot_process_/);
  });

  it('Counter inkrementieren ohne Fehler', async () => {
    commandCounter.inc({ command: 'test', status: 'success' });
    errorCounter.inc({ source: 'command' });
    rateLimitedCounter.inc({ kind: 'in_memory' });
    const text = await metricsRegistry.metrics();
    expect(text).toMatch(/vbot_commands_total\{command="test",status="success"\} 1/);
    expect(text).toMatch(/vbot_errors_total\{source="command"\} 1/);
  });

  it('Gauges setzen Werte korrekt', async () => {
    guildGauge.set(42);
    wsLatencyGauge.set(123);
    const text = await metricsRegistry.metrics();
    expect(text).toMatch(/vbot_guilds 42/);
    expect(text).toMatch(/vbot_discord_ws_latency_ms 123/);
  });

  it('timed() misst Dauer eines async-Calls', async () => {
    const h = new Histogram({
      name: 'vbot_test_timed',
      help: 'test',
      labelNames: ['op'] as const,
      registers: [],
    });
    const result = await timed(h, { op: 'noop' }, async () => 'ok');
    expect(result).toBe('ok');
    // Histogram-Snapshot pruefen
    const snap = await h.get();
    const noop = snap.values.find((v) => v.metricName === 'vbot_test_timed_count');
    expect(noop?.value).toBe(1);
  });

  it('Histogram beobachtet via observe()', async () => {
    commandDurationHistogram.observe({ command: 'metric_test' }, 0.1);
    dbQueryHistogram.observe({ model: 'User', action: 'findMany' }, 0.05);
    const text = await metricsRegistry.metrics();
    expect(text).toMatch(/vbot_command_duration_seconds_count\{command="metric_test"\} 1/);
    expect(text).toMatch(/vbot_db_query_duration_seconds_bucket/);
  });
});
