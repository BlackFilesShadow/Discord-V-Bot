# Contributing — V-Bot Prime

Diese Anleitung beschreibt den aktuellen Entwicklungs- und PR-Workflow.

## Voraussetzungen

- Node.js >= 22
- PostgreSQL >= 16
- Discord-Bot-/OAuth-Credentials für lokale Integrationsarbeit

```bash
git clone https://github.com/<owner>/Discord-V-Bot.git
cd Discord-V-Bot
cp .env.example .env
npm ci
npx prisma migrate deploy
npm run dev
```

Das Dashboard-Backend wird im normalen Bot-Prozess gestartet. Für Frontend-Entwicklung kann zusätzlich der Vite-Devserver verwendet werden:

```bash
npm run ui:dev
```

`npm run dashboard` startet das Dashboard-Backend separat und ist vor allem für gezielte Backend-Entwicklung gedacht.

## Branch- & Commit-Konventionen

- Feature: `feature/<kurz-beschreibung>`
- Bugfix: `fix/<kurz-beschreibung>`
- Refactor: `refactor/<kurz-beschreibung>`
- Commits sollen eine logisch zusammenhängende Änderung beschreiben.

## Pflicht-Checks vor einem PR

Lokale Entsprechung der wichtigsten CI-Schritte:

```bash
npm ci
npm run lint:all
npm run test:ci
npm run build
npx prisma validate
```

Für offene Handles gibt es bei Bedarf zusätzlich:

```bash
npm run test:handles
```

**Kein `--forceExit` als Normalweg.** Die CI läuft bewusst ohne Force-Exit, damit geleakte Timer/Handles nicht verdeckt werden.

Playwright liegt im Dashboard-Projekt und wird im eigenen E2E-Workflow ausgeführt.

## Command-Architektur

Globale Bot-Admin- und DEV-Verwaltung ist Dashboard-only. Neue globale `adminOnly`-/`devOnly`-Slash-Commands dürfen nicht einfach wieder in den Discord-Loader eingeführt werden.

Bei einer neuen oder verschobenen Funktion gilt:

1. Zielbereich bestimmen: Discord, Guild-Dashboard, Bot-Admin oder DEV.
2. Bei Bot-Admin/DEV zuerst funktionsgleichen Dashboard-Pfad bauen.
3. Auth, Scope, Step-Up und Audit prüfen.
4. Regressionstests ergänzen.
5. Command-Inventar aktualisieren.
6. Erst danach einen ersetzten Slash-Pfad entfernen.

Hersteller-Funktionen sind die ausdrücklich dokumentierte Discord-Ausnahme.

## Bot-Informationen aktuell halten

Nutzer-/Operator-Information ist Teil der Funktion und muss im selben PR aktualisiert werden, wenn Verhalten oder Architektur geändert wird.

Wichtige Wahrheitsquellen:

- `/help` -> tatsächlich geladene Discord-Command-Registry,
- `src/content/botInfo.ts` -> öffentliche V-Bot-Selbstauskunft,
- `src/modules/ai/commandCatalog.ts` -> AI-Hilfe zu Discord-Funktionen,
- `README.md`, `SECURITY.md`, `docs/ARCHITECTURE.md` -> kanonische technische Doku,
- `.env.example` -> aktuelle Environment-Namen und Defaults.

Keine festen Command-Zahlen, Upload-Limits oder Runtime-Werte in Doku schreiben, wenn sie aus Config/Runtime ableitbar sind.

## Code-Stil

- TypeScript strict.
- Keine ungescopten Prisma-Zugriffe auf mandanten-/servergebundene Daten.
- User-/Remote-Inhalte vor Discord-Ausgabe sanitizen, wenn der jeweilige Pfad nicht bereits zentral geschützt ist.
- `logger` statt `console.*` im Backend.
- Secrets, Tokens, TOTP und DEV-ReAuth niemals loggen.
- Limits möglichst aus zentraler Config/Modulkonstanten ableiten.

## Dashboard- und Security-Routen

Neue privilegierte Routen brauchen den passenden Gate-Stack:

- Guild-Routen: Auth + Guild Owner/Permission + ggf. Gameserver-Scope.
- Bot-Admin: globale Bot-Admin-Identität + BotAdminSession.
- DEV: globale Developer-Identität + DevSession.
- Sensible DEV-Mutationen/Exporte zusätzlich über verifizierten Step-Up.

Step-Up bedeutet echte serverseitige Credential-Prüfung, nicht nur ein vorhandenes Eingabefeld.

## Tests

- Unit/Integration: `tests/<bereich>/...test.ts`
- Dashboard-Routen: Auth-/Scope-/Fehlerpfade mitprüfen.
- Command-Migrationen: Loader-/Inventory-/Paritätsregressionen ergänzen.
- Bot-Informationen: Drift-Tests ergänzen, wenn neue öffentliche Funktionsinformationen entstehen.

## Datenbank-Änderungen

1. `prisma/schema.prisma` ändern.
2. Versionierte Migration erzeugen.
3. Migration mit dem PR committen.
4. Datenreparaturen deterministisch/fail-closed gestalten.
5. Produktivpfad bleibt `prisma migrate deploy` + `prisma migrate status`.

Kein automatischer produktiver `prisma db push` als Reparaturweg.

## Security-relevante Änderungen

- neue Eingabe-/Uploadpfade -> Validierung und Abuse-Limits,
- neue API-Endpunkte -> passendes Auth-/Scope-Gate,
- sensible Mutation -> Step-Up, Audit und Idempotency prüfen,
- Secrets/PII -> Redaction und Ausgabewege prüfen,
- Schwachstellen nicht mit sensiblen Exploitdetails in öffentliche Issues schreiben.

## PR-Evidenz

Ein größerer Refactor soll vier Ebenen belegen:

1. Inventar-/Restreferenzscan,
2. Funktions-/Security-Parität,
3. CI: Prisma, Jest, Lint, TypeScript/UI-Build, Security/SBOM,
4. E2E plus passende Runtime-/Remote-Smokechecks.

## Kontakt

Repository-Verantwortung/Entwicklung: **Void_Architect**.
