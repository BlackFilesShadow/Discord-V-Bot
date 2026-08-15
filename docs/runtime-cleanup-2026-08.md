# Runtime-Korrektur und Legacy-Entfernung (2026-08)

## Korrekturen

- Zeitbegrenzte `/server-ban`-Banns werden nach Ablauf ueber die bestehende sichere `SERVER_BAN_REMOVE`-Outbox von Nitrado entfernt. Die lokale Ban-Wahrheit wird erst nach bestaetigtem Remote-Remove finalisiert.
- Der urspruengliche Command-Kanal wird fuer zeitbegrenzte Banns gespeichert. Nach erfolgreichem Ablauf wird dort genau eine retry-faehige Discord-Bestaetigung gesendet. Manuelle Unbans erzeugen keine Ablaufmeldung.
- Prometheus `/metrics` ist fail-closed. Die Route ist nur aktiv, wenn `METRICS_ENABLED=true` und ein Bearer-Token mit mindestens 32 Zeichen konfiguriert ist.
- Der DEV-Log-Ringbuffer wird als moderner Winston-Stream angebunden; Datei-, Audit- und Security-Transports bleiben bestehen.
- Der Zins-Scheduler arbeitet ausschliesslich auf servergescoppten EconomyConfigs. Eine Legacy-Scope-Migration wird nur bei eindeutiger Zuordnung automatisch repariert; bei mehreren moeglichen Servern bleibt die Owner-Auswahl zwingend.

## Saubere Entfernung

- `src/modules/nitrado/admSyncCron.ts` entfernt.
- `src/modules/killfeed/admWatcher.ts` entfernt.
- Der globale `NITRADO_ADM_DIR` ist keine Runtime-Konfiguration mehr.
- Der ADM-V2-Live-Ingest ist die einzige Nitrado-Dateiquelle und loest das Profilverzeichnis pro `NitradoConnection` auf.
- Linking wird im inkrementellen V2-Ingest verifiziert.
- Rewards und PlayerSessions werden vom ADM-V2-Postprocessor aus der kanonischen `AdmEvent`-Wahrheit verarbeitet.
- `ADM_EVENT_PIPELINE_V2` steuert nur noch die oeffentliche Death-/Baufeed-Auslieferung, nicht mehr die ADM-Datenerfassung.
