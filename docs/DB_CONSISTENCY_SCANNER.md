# DB-3 – Orphan- und Konsistenzscanner

Der Produktionsscanner ist bewusst **read-only**. Er diagnostiziert Datenbank-Inkonsistenzen, repariert aber niemals automatisch Daten, verschiebt keine Datensaetze und loescht nichts.

## Ausfuehren

```bash
npm run db:consistency
```

Voraussetzung ist eine vollstaendig migrierte PostgreSQL-Datenbank ueber `DATABASE_URL`.

## Exit Codes

- `0` – `CLEAN`: keine Findings
- `1` – `DEGRADED`: nur Warnungen
- `2` – `INVALID`: mindestens ein kritisches Finding
- `3` – Scanner selbst konnte nicht verlaesslich ausgefuehrt werden

## Gepruefte Ebenen

1. Alle realen PostgreSQL-Foreign-Keys werden aus `pg_constraint` entdeckt. Nicht validierte Constraints und echte FK-Orphans blockieren den Scan.
2. Alle Tabellen, die gleichzeitig `guildId` und `nitradoConnId` besitzen, werden automatisch aus `information_schema` entdeckt. Jeder gesetzte Gameserver-Scope muss exakt zu `NitradoConnection(id, guildId)` passen.
3. Zusaetzliche semantische Invarianten pruefen Zustandskombinationen, die ein normaler FK nicht vollstaendig ausdruecken kann:
   - verifizierte GameIdentityLinks ohne Hash/Verifikationszeit
   - PlayerSession Connect-/Disconnect-Events ausserhalb des exakten Guild-/Gameserver-Scopes
   - ungeloeste Economy-Scope-Migrationen
   - NULL-Gameserver-Scope nach bereits aufgeloester Economy-Migration
   - abweichender CasinoRound-/CasinoGame-Scope

## Sicherheitsregel

Ein Finding darf niemals still automatisch korrigiert werden. Bei Produktionsdaten wird zuerst Ursache und Datenherkunft geklaert; erst danach erfolgt eine separate, reviewbare Reparatur/Migration mit Backup und Rollback-Pfad.

Der CI/CD-Testjob fuehrt den Scanner nach `prisma migrate deploy` und `prisma migrate status`, aber vor Jest aus. Dadurch werden auch Scanner-SQL und Migration-Kompatibilitaet auf einer frischen Datenbank bei jedem PR geprueft.
