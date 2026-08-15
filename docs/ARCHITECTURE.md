# V-Bot Prime — Architektur

> Stand: August 2026. Dieses Dokument beschreibt die aktuell laufende Architektur, nicht historische Zwischenstände.

## 1. Systemübersicht

V-Bot besteht aus vier eng gekoppelten, aber sicher getrennten Oberflächen:

1. **Discord Runtime** — Nutzer-, Community-, Hersteller- und servergescoppte Gameserver-Funktionen.
2. **Guild Dashboard** — Self-Service-Konfiguration pro Discord-Guild und Nitrado-Slot.
3. **Bot-Admin Dashboard** — globale Betriebs-/Supportverwaltung.
4. **DEV Dashboard** — technische Administration, Diagnose, Forensik und kontrollierte Runtime-Werkzeuge.

PostgreSQL/Prisma ist die kanonische Persistenz. Nitrado-Remoteänderungen laufen über servergescoppte Jobs/Outbox-Pfade. Socket.IO liefert Dashboard-Liveupdates.

## 2. Command-Modell

### Discord

`src/commands/` ist kein reiner „ein File = ein öffentlicher Slash-Command“-Ordner mehr.

- `src/commands/user/` — Nutzer-/Community-/Hersteller-Commands.
- `src/commands/dashboard/` — **Discord**-Commands mit Guild-/Gameserver-Scope, z. B. Economy, Casino, Fraktionen, Permissions, Whitelist und Server-Bans. Der historische Ordnername bedeutet nicht, dass diese Commands nur im Web laufen.
- `src/commands/developer/` — nur bewusst erhaltene Hersteller-Ausnahme (`devManufacturer.ts`).
- `src/commands/inventory.ts` — Klassifizierung, Migrationsstatus und Hersteller-Preserve-Regeln.
- `src/commands/catalog.ts` — Live-Katalog aus den tatsächlich geladenen Discord-Commands; `/help` und Dashboard-Diagnostik nutzen diese Quelle.

### Bot-Admin / DEV

Globale `adminOnly`-/`devOnly`-Slash-Funktionen wurden in Web-Command-Center migriert. Die Migrationsregel lautet:

1. funktionsgleichen Dashboard-Ersatz bauen,
2. Rechte/Security-Parität prüfen,
3. Regressionstests ergänzen,
4. im Inventory als `moved_to_dashboard` markieren,
5. erst danach Slash-Implementierung entfernen.

Herstellerfunktionen sind die einzige bewusst erhaltene Ausnahme.

## 3. HTTP Request Flow

### Guild-Routen

```text
Browser
  -> Discord OAuth Session / requireAuth
  -> Guild Owner oder delegierter Permission-Scope
  -> optional Gameserver-Scope-Guard
  -> Route
  -> Prisma / Outbox / Discord / Nitrado
```

Guild-gebundene Daten dürfen niemals nur über eine globale Rolle autorisiert werden. `guildId` und bei Gameserverdaten `nitradoConnId` bleiben Teil des fachlichen Scopes.

### Bot-Admin

```text
requireAuth
  -> requireGlobalBotAdminIdentity
  -> BotAdminSession
  -> Bot-Admin Router / Command Center
```

### DEV

```text
requireAuth
  -> requireGlobalDeveloperIdentity
  -> requireDev (aktive DevSession)
  -> optional globales MFA/IP-Gate je Konfiguration
  -> bei sensibler Mutation: verified DEV Step-Up
  -> DEV Router / Command Center
```

`DEV_REQUIRE_MFA=true` und `DEV_REQUIRE_IP_ALLOWLIST=true` sind explizite zusätzliche Gates; sie sind nicht pauschal als immer aktiv anzunehmen.

Sensible DEV-Mutationen besitzen unabhängig davon ein eigenes Re-Auth-Gate: aktive 2FA => TOTP; sonst erneute Prüfung von `DEV_PASSWORD`.

## 4. Dashboard-Routen

Zentraler Mount: `/api/v2`.

Wichtige Domänen:

- `/guilds/:guildId/...` — Guild-/Gameserver-Self-Service.
- `/bot-admin/...` — globale Bot-Administration.
- `/bot-admin/command-center/...` — Dashboard-Ersatz ehemaliger globaler Admin-Slash-Funktionen.
- `/dev/...` — DEV Session/Status und technische Routen.
- `/dev/command-center/...` — Dashboard-Ersatz ehemaliger DEV-Slash-Funktionen.
- `/dev/secure-export/...` — sensible Exporte ausschließlich per POST + verifiziertem Step-Up.

## 5. Nitrado Multi-Server-Scope

Ein Discord-Server kann mehrere Nitrado-DayZ-Server binden. Fachliche Wahrheit ist immer:

```text
guildId + nitradoConnId
```

Slotnummern/Aliase sind Bedienoberfläche; persistente Beziehungen verwenden die stabile `NitradoConnection`.

Scope gilt insbesondere für:

- Whitelist,
- Server-Bans,
- Economy/Bank/Casino,
- Spielidentitäts-Linking,
- Fraktionen,
- ADM-Quelle/Cursor,
- Sessions/Rewards/Gameplay-Events.

Cross-Slot-Fallbacks sind bei Mutationen zu vermeiden; unklare Legacy-Scope-Zustände werden fail-closed behandelt.

## 6. Nitrado Job-/Outbox-Modell

Remoteänderungen werden nicht als „DB geschrieben = remote erfolgreich“ behandelt.

```text
Command/Dashboard
  -> lokale fachliche Transaktion
  -> NitradoJob / deduplizierte Outbox
  -> Worker mit Connection-Lock
  -> Nitrado API
  -> Remote-State bestätigen
  -> lokalen Sync-Status aktualisieren
```

Dadurch bleiben Whitelist-/Ban-Operationen retryfähig und servergescoppt.

## 7. Zeitliche Server-Bans

`/server-ban` kann permanent oder zeitlich begrenzt sein.

Für zeitliche Bans:

1. lokale Ban-Wahrheit + Outbox werden atomar geschrieben,
2. Ablauf-Metadaten liegen in `ServerBanExpiryNotice`,
3. die Ablauf-Runtime pollt regelmäßig,
4. Remote-Unban wird über die bestehende Nitrado-Outbox ausgeführt,
5. erst nach bestätigter Remote-Entfernung wird die Ablaufmeldung im ursprünglichen Command-Kanal veröffentlicht,
6. Re-Ban/manueller Unban canceln veraltete Ablaufmeldungen fail-safe.

## 8. ADM V2

Der frühere globale Runtime-Pfad über `NITRADO_ADM_DIR`, `admSyncCron` und `admWatcher` ist entfernt.

Aktueller Datenfluss:

```text
NitradoConnection
  -> per-Server ADM-Profil / auto-discovery
  -> AdmSourceCursor
  -> ADM-V2 Live Sync
  -> kanonisches AdmEvent
  -> ADM-V2 Postprocess
       -> Link-Challenges
       -> Sessions / Playtime
       -> Rewards
       -> Gameplay-/Feed-Verarbeitung
```

Die kanonische Erfassung darf nicht vom öffentlichen Gameplay-Feed-Schalter abhängen. Feed-Ausgabe kann deaktiviert sein, während ADM weiterhin korrekt ingestiert und postprocessed wird.

## 9. AI Architektur

Provider:

- Groq
- Cerebras
- OpenRouter
- Gemini
- OpenAI

Die Reihenfolge ist **adaptiv** aus persistierten Provider-Statistiken. Falls diese nicht verfügbar sind, wird mit dem konfigurierten Primary und dem definierten Fallback-Set weitergearbeitet.

Vor externen AI-Aufrufen werden sensible Daten redigiert. Technische DayZ-Fragen verwenden zusätzlich verifiziertes DayZ-1.29-/Nitrado-Grounding und eine Fail-Closed-Ausgabeprüfung.

### Bot-Informationen

- Entwickleridentität: kanonisch `Void_Architect`.
- `/help`: Laufzeit-Katalog aus tatsächlich geladenen Commands.
- AI-Command-Hilfe: eigener aktueller Public-Katalog; keine globalen Bot-Admin-/DEV-Slash-Commands erfinden.
- `/stell-dich-vor`: statische aktuelle Funktionsübersicht, keine externe/nicht vorhandene Markdown-Datei.

## 10. Uploads

Hersteller-Uploads:

- maximal 10 Attachments pro `/upload`-Aufruf,
- Standardlimit `MAX_FILE_SIZE_BYTES=26214400` = 25 MiB pro Datei,
- erlaubte Endungen standardmäßig `.xml,.json`,
- Größen-/Dateityp-/Validierungsprüfung vor finaler Freigabe,
- GUID-getrennte Paketpfade.

Dokumentation und Bot-Antworten sollen das Limit aus `config.upload.maxFileSizeBytes` ableiten, statt eine feste alte Zahl zu behaupten.

## 11. Security

Siehe `SECURITY.md` für Details. Architektur-Invarianten:

- globale Identität niemals allein aus einer alten Session-Rolle ableiten,
- Guild-Daten nie ohne Guild-Scope,
- Gameserver-Daten nie ohne `nitradoConnId`,
- sensible DEV-Mutationen nur nach echtem serverseitigem Step-Up,
- Secrets nie in URL, Client-Logs oder Audit-Details,
- produktive DB-Änderungen nur über versionierte Migrationen.

## 12. Observability

- strukturierte Winston-Logs,
- Security/Audit-Events in DB,
- optional Prometheus `/metrics`, nur bei explizitem Enable + gültigem Token,
- DEV-Observability/Statusseiten,
- Healthchecks in Deploy/Container.

Der frühere Custom-Ring-Transport wird über einen modernen object-mode Writable-Bridge an Winston angebunden; Legacy-Transport-Warnungen sind kein erwarteter Normalzustand mehr.

## 13. Deployment

Produktiver Standard:

```text
git update/reset auf origin/main
  -> Secret/Environment Guards
  -> Prisma generate
  -> prisma migrate deploy
  -> prisma migrate status
  -> Docker build/start
  -> Health + Discord Login + Post-Start Checks
```

Kein produktiver automatischer `prisma db push` als Schema-Reparaturpfad.

## 14. CI

PR/main werden mit folgenden Ebenen geprüft:

- Dependency/Security Audit,
- Prisma Generate/Validate/Migrationen,
- Jest,
- Lint,
- Backend TypeScript,
- Frontend Build,
- Playwright E2E,
- Docker Build auf dem dafür vorgesehenen Workflow-Pfad.

## 15. Wahrheitsquellen

Bei Widersprüchen gilt in dieser Reihenfolge:

1. aktuelle Runtime-/Command-Definition,
2. Prisma-Schema + produktive Migrationen,
3. zentrale Config,
4. `/help`/Live-Command-Katalog für Discord,
5. diese Dokumentation.

Historische Cleanup-/Rollout-Dokumente dürfen historische Zustände beschreiben, müssen aber als solche gekennzeichnet bleiben.
