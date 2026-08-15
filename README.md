# V-Bot Prime

V-Bot Prime ist ein Discord-, Community- und DayZ/Nitrado-Bot mit Web-Dashboard. Die laufende Architektur trennt bewusst zwischen **Discord-Funktionen für Nutzer/Serverbetrieb** und **globaler Bot-Admin-/DEV-Verwaltung im Dashboard**.

> **Entwickler:** `Void_Architect`

## Aktueller Funktionsstand

### Discord

- AI-Konversation mit Multi-Provider-Fallback, Serverkontext und Live-Recherche für aktuelle Faktfragen.
- Moderation, XP/Level, Giveaways, Polls, Tickets, Feedback und Erinnerungen.
- Hersteller-Workflow mit Registrierung, OTP-Verifikation, `/upload` und `/mypackages`.
- DayZ/Nitrado: mehrere Gameserver pro Guild, Whitelist, servergescoppte Berechtigungen und echte Nitrado-Server-Bans.
- Zeitlich begrenzte `/server-ban`-Banns werden durch die Ban-Ablauf-Runtime automatisch remote entfernt; die Ablaufmeldung geht in den ursprünglichen Command-Kanal.
- Economy, Bank, Zahlungen, Casino, Fraktionen und Spielidentitäts-Linking sind pro Guild/Gameserver-Slot getrennt.

Der **aktuelle Discord-Command-Stand wird nicht als handgeschriebene Liste in dieser README gepflegt**. `/help` wird direkt aus der geladenen Command-Registry erzeugt und ist deshalb die Laufzeit-Wahrheitsquelle.

### Hersteller-Ausnahme

Hersteller-Funktionen bleiben bewusst als Discord-Slash-Funktionen erhalten. Dazu gehören insbesondere `/upload`, `/mypackages` und die dafür notwendige Herstellerverwaltung. Der Standard für Uploads liegt aktuell bei **25 MiB pro Datei** und maximal **10 Dateien pro `/upload`-Aufruf**; das Größenlimit ist serverseitig über `MAX_FILE_SIZE_BYTES` konfigurierbar.

### Bot-Admin & DEV

Globale Bot-Admin- und DEV-Werkzeuge werden **nicht mehr als normale Discord-Slash-Commands** betrieben. Sie sind gezielt in zwei Dashboard-Bereiche aufgeteilt:

- **Bot-Admin:** Support-/Betriebsverwaltung, Pakete, Validierung, Feedback, Wissensbasis, Broadcast, Nutzer, Tickets, Feeds, Übersetzungen, AI-Provider und Audit-/Statusfunktionen.
- **DEV:** Diagnostik, Datenbankwerkzeuge, Security, Live-Konfiguration, XP-Konfiguration, sichere Exporte, Command-Registry und weitere technische/forensische Werkzeuge.

Die einzige bewusst erhaltene DEV-Slash-Ausnahme ist die Herstellerfunktion `/dev-manufacturer`.

## DEV-Sicherheitsmodell

DEV-Zugriff ist mehrstufig:

1. Discord-OAuth-Session.
2. Kanonische globale Developer-Identität + aktuelle DB-Rolle.
3. Aktive, nicht widerrufene `DevSession`.
4. Optional: TOTP-MFA, wenn `DEV_REQUIRE_MFA=true` gesetzt ist.
5. Optional: DEV-IP-Allowlist, wenn `DEV_REQUIRE_IP_ALLOWLIST=true` gesetzt ist.
6. **Sensible Mutationen und Exporte verlangen zusätzlich eine echte serverseitige Step-Up-Re-Authentisierung.**
   - Ist 2FA aktiv, muss ein gültiges TOTP verwendet werden.
   - Ohne aktive 2FA wird `DEV_PASSWORD` erneut timing-sicher geprüft.
   - Fehlversuche werden auditiert und nach wiederholten Fehlern temporär gesperrt.
   - Das Re-Auth-Geheimnis wird nicht in URLs oder Audit-Details geschrieben.

Sensible DEV-Exporte laufen ausschließlich über POST + Step-Up; alte GET-Exportpfade liefern keine Daten mehr direkt aus.

## DayZ / Nitrado Runtime

### ADM V2

Der alte globale `NITRADO_ADM_DIR`-/Legacy-Watcher ist nicht mehr Bestandteil der Runtime. Die aktuelle Pipeline arbeitet pro Nitrado-Verbindung:

- **ADM-V2-Live-Sync** liest die konfigurierte/erkannte ADM-Quelle je Gameserver.
- Normalisierte Daten werden als kanonische `AdmEvent`s persistiert.
- **ADM-V2-Postprocess** verarbeitet daraus Sessions, Rewards und weitere serverbezogene Folgeprozesse.
- Gameplay-Feed-Ausgabe kann unabhängig von der kanonischen Erfassung geschaltet werden.

### Nitrado Jobs und Schutz

Remote-Mutationen laufen über servergescoppte, deduplizierte Jobs/Outbox-Pfade. Whitelist-, Ban- und andere Nitrado-Aktionen bleiben strikt an `guildId + nitradoConnId` gebunden.

## AI

- Provider: Groq, Cerebras, OpenRouter, Gemini und OpenAI.
- Die Reihenfolge ist adaptiv anhand persistenter Provider-Statistiken; bei fehlenden Stats wird auf die konfigurierte Provider-Reihenfolge zurückgefallen.
- Technische DayZ-Fragen werden mit verifiziertem DayZ-1.29-/Nitrado-Grounding abgesichert.
- Server-/User-Kontext wird getrennt behandelt; sensible Kanäle/Rollen werden aus AI-Kontexten gefiltert.
- Bot-Identität und Entwicklerangabe stammen aus einer kanonischen Quelle (`Void_Architect`).

## Dashboard

- Backend: Express + Helmet + Session-Store in PostgreSQL.
- Frontend: React + Vite + TailwindCSS.
- Discord OAuth2, rollen-/scopebasierte Guild-Zugriffe sowie getrennte Bot-Admin-/DEV-Sessions.
- REST `/api/v2`, Socket.IO für Live-Updates und Audit-/Security-Logging.
- Bot-Admin- und DEV-Command-Center bilden die früheren globalen Admin-/DEV-Slash-Funktionen funktional im Web ab.

## Sicherheit & Betrieb

- PostgreSQL + Prisma, guild-/servergescoppte Datenmodelle.
- AES-256-GCM für sensible gespeicherte Secrets.
- OAuth2 State + PKCE, Session-Timeouts, Rate-Limits und SecurityEvents.
- Audit-Logging für administrative und privilegierte Aktionen.
- Private DEV-Logs/Exporte; öffentlich statisch ausgeliefert werden nur explizit freigegebene Medienpfade.
- `/metrics` ist nur aktiv, wenn Metrics explizit aktiviert **und** ein ausreichend langer `METRICS_TOKEN` vorhanden ist. Der Deploy-Pfad kann bei aktivierten Metrics einen fehlenden Token sicher erzeugen, ohne ihn auszugeben.
- Docker Compose, Healthchecks, Prisma `migrate deploy` + `migrate status`, Jest, Lint/TypeScript, Security Audit und Playwright-E2E in CI.

## Tech-Stack

| Bereich | Technik |
|---|---|
| Sprache | TypeScript (strict) |
| Discord | discord.js v14 |
| Datenbank | PostgreSQL + Prisma |
| AI | Groq, Cerebras, OpenRouter, Gemini, OpenAI |
| Dashboard | Express + React/Vite |
| Cache | Redis + DB-/Memory-Fallbacks je Modul |
| Tests | Jest + Playwright |
| Monitoring | Health + optional Prometheus `/metrics` |
| Deployment | Docker Compose + GitHub Actions |

## Verzeichnisübersicht

- `src/commands/user/` — Nutzer-/Community-/Hersteller-Slash-Funktionen.
- `src/commands/dashboard/` — Discord-Commands mit Guild/Gameserver-Scope (z. B. Economy, Whitelist, Server-Bans, Fraktionen); der Ordnername bedeutet **nicht**, dass diese nur im Web laufen.
- `src/commands/developer/` — nur bewusst erhaltene Hersteller-DEV-Ausnahme.
- `src/dashboard/routes/v2/` — Dashboard-APIs einschließlich Bot-Admin-/DEV-Command-Center.
- `src/modules/nitrado/adm/` — aktuelle ADM-V2-Pipeline.
- `src/modules/bans/` — Ban Registry, Outbox und Ablauf-Runtime.
- `prisma/` — Schema und produktive Migrationen.

## Wahrheit über Commands

Bei Änderungen gilt:

1. Discord-Command-Definition ist die Laufzeitquelle.
2. `/help` liest den tatsächlich geladenen Command-Katalog.
3. Bot-Admin-/DEV-Funktionen werden im Dashboard dokumentiert, nicht als Slash-Commands.
4. AI-Selbstauskünfte dürfen nur den aktuellen öffentlichen Command-Katalog verwenden.
5. Hersteller-Funktionen bleiben die explizite Discord-Ausnahme.

## Weitere Dokumentation

- `docs/ARCHITECTURE.md` — aktuelle Architektur und Datenflüsse.
- `SECURITY.md` — aktuelles Sicherheitsmodell.
- `docs/SERVER_GAMEPLAY_FEEDS.md` — Gameplay-/ADM-V2-Konzept.
- `docs/runtime-cleanup-2026-08.md` — dokumentierter Legacy-Runtime-Cleanup.
- `docs/monitoring/README.md` — Monitoring.

## Kontakt

- Repository: `BlackFilesShadow/Discord-V-Bot`
- Entwickler: **Void_Architect**

Privates Projekt. Self-Hosting und Betrieb müssen mit eigenen Secrets, OAuth-Konfiguration, Datenbank und Nitrado-Zugängen eingerichtet werden.
