# DB-4 – Fresh DB, Upgrade DB und Backup/Restore

DB-4 macht den Datenbank-Lebenszyklus zu einem blockierenden Produktions-Gate.

## Was CI prueft

`npm run db:lifecycle` arbeitet ausschliesslich mit isolierten Wegwerf-Datenbanken auf dem CI-PostgreSQL und veraendert die eigentliche Testdatenbank nicht.

1. **Fresh DB**
   - leere Datenbank anlegen
   - alle Prisma-Migrationen mit `prisma migrate deploy` anwenden
   - `prisma migrate status` muss sauber sein
   - DB-3 Orphan-/Konsistenzscanner muss `CLEAN` liefern

2. **Upgrade DB**
   - Release-Zustand unmittelbar vor `20260817135600_db2_composite_scope_fks` aus den echten versionierten Migrationen aufbauen
   - Survival-Sentinel anlegen
   - danach mit dem vollstaendigen aktuellen Migrationssatz ueber `prisma migrate deploy` upgraden
   - Migrationsanzahl muss exakt dem Fresh-DB-Zustand entsprechen
   - Sentinel muss unveraendert vorhanden sein
   - DB-3 Scanner muss erneut sauber sein

3. **Backup/Restore**
   - Upgrade-DB mit `pg_dump --format=custom --no-owner --no-privileges` sichern
   - in eine neue leere Datenbank mit `pg_restore --exit-on-error` restaurieren
   - Prisma-Migrationshistorie, Sentinel und Schema-Signatur muessen dem Quellzustand entsprechen
   - `prisma migrate status` und DB-3 Scanner muessen auch auf dem Restore sauber sein

Jeder Fehler beendet den Lauf fail-closed. Die Wegwerf-Datenbanken werden ueber einen `EXIT`-Trap entfernt.

## Produktions-Backup-Verifier

`deploy/backup-verify.sh` ist ebenfalls fail-closed gehaertet:

- das vom Backup erzeugte SHA-256-Sidecar ist verpflichtend und wird vor dem Entpacken geprueft
- SQL-Restore laeuft mit `ON_ERROR_STOP=1`
- fehlende Kern-Tabellen oder ungueltige Migrationshistorie sind Fehler
- nicht validierte Foreign Keys sind Fehler
- abschliessend laeuft der kanonische DB-3 Konsistenzscanner gegen die restaurierte Wegwerf-Datenbank

Ein Backup gilt damit nicht mehr als gueltig, nur weil sich ein Archiv entpacken laesst. Es muss tatsaechlich restaurierbar, migrationskonsistent und scope-konsistent sein.

## Betrieb

CI fuehrt DB-4 vor Jest aus. Lokal bzw. in einer isolierten Testumgebung kann der Gate mit einer PostgreSQL-URL ausgefuehrt werden:

```bash
DATABASE_URL='postgresql://user:pass@127.0.0.1:5432/testdb' npm run db:lifecycle
```

Der verwendete DB-Benutzer benoetigt fuer diesen Test das Recht, temporaere Datenbanken anzulegen und zu loeschen. Das Skript darf nicht gegen eine Produktions-URL mit eingeschraenktem DB-Benutzer als ad-hoc Wartungsbefehl verwendet werden; fuer Produktion ist `deploy/backup-verify.sh` vorgesehen.
