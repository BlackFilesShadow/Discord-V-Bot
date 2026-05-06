# Contributing — V-Bot Prime

> Danke, dass du beitragen willst! Diese Anleitung beschreibt die kürzesten Wege
> zu einem PR, der reviewt und gemerged werden kann.

---

## Voraussetzungen

- **Node.js** ≥ 22 LTS
- **PostgreSQL** ≥ 16 mit `pgvector`-Extension
- **Discord-Bot-Token** + OAuth-App für lokales Dashboard-Login

```bash
git clone https://github.com/<owner>/Discord-V-Bot.git
cd Discord-V-Bot
cp .env.example .env   # .env mit eigenen Credentials befüllen
npm ci
npx prisma migrate deploy
npm run dev            # Bot
npm run dev:dashboard  # Dashboard separat (optional)
```

---

## Branch- & Commit-Konventionen

- Feature-Branch: `feature/<kurz-beschreibung>`
- Bugfix-Branch: `fix/<kurz-beschreibung>`
- Commits: **Conventional Commits**, z.B. `feat(xp): adaptive level-up message`
- Eine logische Änderung = ein Commit. Squash beim Merge.

### Erlaubte Typen
`feat` · `fix` · `refactor` · `perf` · `docs` · `test` · `chore` · `security` · `build`

---

## Pflicht-Checks vor jedem PR

```bash
npm run lint          # ESLint inkl. custom rule no-unscoped-prisma-query
npx tsc --noEmit      # TypeScript strict, Zero Errors
npx jest --no-coverage --forceExit   # Alle 343+ Tests grün
```

CI rejectet jeden PR, der einen dieser Checks nicht besteht.

---

## Code-Stil

- **TypeScript strict mode** — kein `any` ohne Begründung im Kommentar
- **Keine ungescoped Prisma-Queries** — `WHERE guildId` ist Pflicht in Multi-Tenant-Tabellen (ESLint-Rule erzwingt das)
- **User-Content in Embeds** → immer durch [`src/utils/embedSanitize.ts`](src/utils/embedSanitize.ts) leiten
- **Logger** statt `console.*` (PII-Redactor läuft nur über logger)
- **Keine Magic Numbers** in Limits — Konstanten in `src/config.ts` oder Modul-Top
- **i18n** wo User-sichtbar: Übersetzungs-Helfer nutzen, kein hardgecodetes Englisch

---

## Tests schreiben

- Unit-Tests: `tests/<bereich>/<dateiname>.test.ts`
- Mocks: prefer `jest.mock(...)` mit Factory-Funktionen
- Prisma-Mocks: alle benötigten Modelle/Methoden ergänzen — fehlende Mocks
  führen zu schwer auffindbaren Cascade-Failures
- Dashboard-Routes: integriertes Setup in `tests/dashboard/api.test.ts` als Vorlage

---

## Datenbank-Änderungen

1. Schema in [`prisma/schema.prisma`](prisma/schema.prisma) anpassen
2. Migration generieren: `npx prisma migrate dev --name <kurz>`
3. Migration im PR mitcommitten (niemals manuelle SQL-Edits an existierenden Migrations)
4. Falls Daten-Migration nötig → SQL-Skript in [`deploy/sql/`](deploy/sql/) anlegen

---

## Security-relevante Änderungen

- Neue User-Eingabe-Pfade → Threat-Modell-Notiz im PR
- Neue API-Endpunkte → Auth-Gate + Rate-Limit verpflichtend dokumentieren
- Schwachstellen → **NICHT als Issue**, sondern via [SECURITY.md](SECURITY.md)

---

## Pull-Request-Template

Im PR-Body bitte angeben:
- **Was** wurde geändert (1-2 Sätze)
- **Warum** (Bezug zu Issue / User-Need)
- **Test-Evidenz** (CI-Output reicht, plus optional manueller Smoke)
- **Risiko-Einschätzung**: low / medium / high + Mitigation

---

## Kontakt

Fragen vor dem PR? Discord-Server (siehe README) oder GitHub-Discussion.
