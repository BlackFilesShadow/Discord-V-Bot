# Live-E2E Harness (opt-in)

Diese Tests sind **bewusst nicht im normalen Jest-Run** und **nicht im CI** —
sie benötigen einen echten Discord-Test-Bot, einen Test-Guild sowie Live-DB
und sind langsam.

## Aktivierung

Setze ALLE folgenden Variablen:

```bash
export ENABLE_LIVE_E2E=1
export DISCORD_TEST_BOT_TOKEN=...           # eigener Test-Bot, NICHT der Prod-Bot
export TEST_GUILD_ID=...                    # Test-Guild, in dem der Bot Member ist
export TEST_KILLFEED_CHANNEL_ID=...         # Channel, in den Killfeed gepostet wird
export TEST_RAG_QUERY_CHANNEL_ID=...        # Channel, in dem der Bot RAG-Antworten gibt
export DATABASE_URL=postgresql://...        # Test-Datenbank (NICHT Prod)
```

## Ausführung

```bash
npx jest --config jest.config.js --runInBand --testPathPattern=tests/e2e-live
```

`--runInBand` ist Pflicht — Discord-Rate-Limits vertragen keinen Parallelismus.

## Was wird getestet

| Suite | Fluss |
|---|---|
| `killfeed.live.test.ts` | Synthetisches ADM-Log → `parseAdmFile` → DB-Insert → Discord-Embed im Channel verifiziert |
| `rag.live.test.ts` | DB-seeded Knowledge-Eintrag → Frage im Test-Channel → Bot-Antwort enthält Knowledge-Snippet |

## Cleanup

Jede Suite räumt ihre Test-Daten in `afterAll` selbst auf (`Killfeed`-Rows mit
`source='__live_e2e__'`, RAG-Einträge mit Tag `__live_e2e__`).

## Sicherheit

- **Niemals** Production-Credentials einsetzen
- Test-Bot-Token regelmäßig rotieren
- Test-Guild sollte privat sein (Invite-Only)
