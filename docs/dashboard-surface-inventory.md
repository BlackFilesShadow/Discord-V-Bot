# Dashboard-Gesamtinventar (Etappe 23)

Stand: `main` nach Etappe 22, Commit `b98e2cf10044860365092b35f5fa1851943825b8`.

Dieses Dokument ist die lesbare Zusammenfassung. Das verbindliche, maschinenlesbare Inventar steht in [`dashboard-surface-inventory.json`](./dashboard-surface-inventory.json). Es erfasst für jede Oberfläche Route, UI-Komponente, API, Backend, Datenhaltung, Berechtigungen, Scope, Aktionen, Tests und Mobile-Nachweis. Der Architekturtest `tests/security/dashboardSurfaceInventoryArchitecture.test.ts` verhindert unbemerkte Drift zwischen Inventar und Quellcode.

## Ergebnis

Der aktuelle Produktstand besitzt **57 geroutete Dashboard-Oberflächen**:

| Bereich | Oberflächen | Testnachweis | Mobile-Nachweis |
| --- | ---: | --- | --- |
| Login | 1 | 1 verifiziert | 1 verifiziert |
| Guild-/Server-Seite | 12 | 11 verifiziert, 1 teilweise | 11 verifiziert, 1 teilweise |
| Gameserver-Slot | 5 | 5 verifiziert | 5 verifiziert |
| Bot-Admin | 3 | 3 verifiziert | 3 verifiziert |
| DEV inkl. Shell | 36 | 8 verifiziert, 28 teilweise | 8 verifiziert, 28 nur über die Shell |
| **Gesamt** | **57** | **28 verifiziert, 29 teilweise** | **28 verifiziert, 1 teilweise, 28 nur Shell** |

„Verifiziert“ bedeutet vorhandenen, oberflächenspezifischen Browsernachweis. „Teilweise“ bedeutet, dass Route/Backend und mindestens ein untergeordneter Test existieren, aber der vollständige Browservertrag noch fehlt. „Nur Shell“ bedeutet, dass die mobile DEV-Navigation auf allen Zielbreiten geprüft ist, die konkrete Werkzeugseite jedoch noch keinen eigenen Mobile-Nachweis besitzt.

## Reale Routenstruktur

```text
/login
/servers
└── /servers/:guildId
    ├── 11 Guild-Tabs
    └── /server/:slot
        └── 5 Slot-Tabs
/bot-admin
└── 3 Ansichten: Verwaltung, AI-Wissensbank, Commands
/dev
├── DEV-Shell
├── 33 Katalog-Werkzeuge
└── 2 reale Sonderrouten: command-center, secure-export
```

Die zuvor nur als mögliche Restflächen genannten Bereiche sind auf `main` tatsächlich vorhanden: Uploads, Analytics, Incident Response, Diagnostics/Stubs, Command Center und Secure Export. Sie sind deshalb inventarisiert; es wurde keine künstliche „Dashboard-2G“-Oberfläche erfunden.

## Backend-Abdeckung

Das Inventar bildet zusätzlich **16 Express-Mounts** des Dashboard-Servers und **43 eindeutige `/api/v2`-Mounts** ab. Dazu gehören auch nicht direkt über eine React-Seite bediente HTTP-Flächen wie Webhooks, Setup-Diagnose, öffentliche UUID-Transkripte, Health/Readiness, Metrics und statische Medien. Diese Flächen sind ausdrücklich klassifiziert und den passenden Prüfungen der Etappen 24–38 zugeordnet.

Der Drift-Test vergleicht automatisch:

- die sechs Top-Level-React-Routen aus `App.tsx`;
- alle 11 Server-Tabs und 5 Slot-Tabs;
- alle 3 Bot-Admin-Ansichten;
- alle 33 Einträge des DEV-Katalogs und beide Sonderrouten;
- sämtliche gerouteten Dateien unter `dashboard-ui/src/pages`;
- alle pfadgebundenen Express-Mounts in `src/dashboard/server.ts`;
- alle eindeutigen Mounts in `src/dashboard/routes/v2.ts`;
- die Existenz aller referenzierten UI-, Backend- und Testdateien.

`dashboard-ui/src/pages/dev/_ToolStub.tsx` ist die einzige bewusst ausgeschlossene Page-Datei: Sie wird von keiner Route und keiner gerouteten Seite importiert.

## Verbindliches Restflächen-Register für Etappen 24–38

| ID | Betroffene Fläche | Festgestellte Lücke | Zuständige Etappen |
| --- | --- | --- | --- |
| DASH-INV-001 | Nitrado-Slotverwaltung | Kein eigener authentifizierter Action-/Mobile-E2E-Vertrag für Slot, Service-ID und Token | 24, 26, 27, 29, 31–38 |
| DASH-INV-002 | DEV Sessions, Incident, Debug, Command Center, Secure Export | Backend-Guards getestet; Browseraktionen, Race/Error und seitenspezifische Mobile-Nachweise unvollständig | 24, 26, 27, 29–38 |
| DASH-INV-003 | DEV Uploads, Validatoren und DayZ-Analysen | Parser unterhalb des Browsers getestet; Upload/Delete/Analyze und Mobile-E2E fehlen | 24, 26–38 |
| DASH-INV-004 | 11 DEV Status-/Diagnoseseiten | Seitenspezifische Loading/Empty/Error/Stale- und Fünf-Breiten-Matrix unvollständig | 28–35 |
| DASH-INV-005 | DEV-Katalog | `ready` bezeichnet derzeit Implementierung/Routing, nicht vollständige Action-/Mobile-Produktionsreife | 24–38 |

Etappe 23 dokumentiert und sperrt die Bestandsgrenze. Sie zieht keine Detailprüfung von Buttons, Toggles, CRUD, Fehlerzuständen, fünf Mobile-Breiten oder API-Angriffsmatrizen vor; diese bleiben strikt den Etappen 24–38 vorbehalten.
