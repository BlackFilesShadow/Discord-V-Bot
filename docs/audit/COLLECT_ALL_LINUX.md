# V-Bot Collect-All Audit (Linux)

Der Collect-All-Audit ist ein rein lokaler/isolierter Verifikationspfad fuer einen Linux-/Docker-Host. Er ersetzt nicht die kanonischen GitHub-Gates, sondern ergaenzt sie um einen fortsetzenden Voll-Lauf, bei dem ein einzelner roter Block spaetere unabhaengige Checks nicht verdeckt.

## Start

Vom Repository-Root:

```bash
bash scripts/audit-collect-all-docker.sh
```

Optional kann ein bereits lokal vorhandener exakter Commit geprueft werden:

```bash
AUDIT_SHA=<40-stelliger-commit-sha> bash scripts/audit-collect-all-docker.sh
```

Die Ausgabe landet standardmaessig unter `/root/vbot-audit-output/<UTC-Zeit>-<SHA>/`. Ein anderer Zielordner kann mit `AUDIT_HOST_OUTPUT_ROOT` gesetzt werden.

## Sicherheitsmodell

- Der Wrapper arbeitet auf einer separaten detached Repo-Kopie des exakten Audit-SHA.
- PostgreSQL und Redis laufen als Einweg-Container in einem eigenen Docker-Netz.
- Die Datenservices besitzen keine auf den Host veroeffentlichten Ports.
- Der Test-Runner erhaelt keinen Docker-Socket und kann deshalb keine Produktionscontainer stoppen oder neu starten.
- Der innere Runner verweigert den Start, wenn `DATABASE_URL` nicht exakt auf `audit-postgres:5432/discord_v_bot_audit` oder `REDIS_URL` nicht auf `audit-redis:6379` zeigt.
- Realer Stage-59-Prozess-Kill bleibt ausschliesslich Aufgabe des kanonischen GitHub-Stage-59-Gates.

## Ergebnisdateien

Der Lauf erzeugt insbesondere:

- `VBot-FULL-REPO-AUDIT.md` – upload-/lesefreundlicher Gesamtbericht inklusive Konsolenausgabe.
- `full-console.log` – rohe vollstaendige Konsolenausgabe.
- `summary.tsv` – Blockergebnisse als einfaches Tabellenformat.
- `summary.json` – maschinenlesbare Zusammenfassung.
- `failures.txt` – fehlgeschlagene und abhaengig uebersprungene Bloecke mit Kontext.
- `warnings.txt` – warnungsartige Texttreffer. Diese sind Kandidaten und nicht automatisch echte Fehler.
- Einzelne Logs je Auditblock unter `logs/`.

## Klassifikation

Der Runner unterscheidet strukturell zwischen:

- `ECHTER FEHLER` – ein ausgefuehrter Repo-/Funktionscheck ist rot.
- `TEST-/UMGEBUNGSFEHLER` – Voraussetzung oder Testumgebung ist nicht verwendbar.
- `FOLGEFEHLER` – ein Block wird nicht ausgefuehrt, weil eine benoetigte Voraussetzung vorher rot war.
- Warnungsartige Zeilen werden separat gesammelt und machen einen ansonsten gruenen Block nicht rot.

Die automatische Klassifikation ersetzt keine Kontextpruefung. Beispielsweise kann ein externer Registry-/Netzwerkausfall einen Security-Befehl mit non-zero beenden; fuer die abschliessende Bewertung muss dann der zugehoerige Block-Log gelesen werden.

## Nicht lokal reproduzierte GitHub-Gates

Der no-Docker-socket Runner fuehrt bewusst keinen echten PostgreSQL-/Redis-Prozess-Kill aus. Gitleaks und Trivy bleiben ebenfalls kanonische GitHub-CI-Evidenz. Ihr Status darf deshalb nicht aus dem lokalen Collect-All-Lauf abgeleitet werden.
