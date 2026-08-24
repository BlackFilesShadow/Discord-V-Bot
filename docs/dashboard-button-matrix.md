# Dashboard-Button-Matrix (Etappe 24)

Bestandsbasis: `main` nach Etappe 23, Commit `3daf10326dbfd73d1f973c12749d113ad4a533f3`.

Die verbindliche Einzelinventur steht in [`dashboard-button-matrix.json`](./dashboard-button-matrix.json). Sie wird durch `tests/security/dashboardButtonMatrixArchitecture.test.ts` fail-closed gegen den real erreichbaren Importgraphen von `dashboard-ui/src/App.tsx` geprüft.

## Umfang

| Klasse | Button-Quellstellen |
| --- | ---: |
| Schreibende Requests | 170 |
| Lesende Requests / Refresh / Retry | 34 |
| Export / Download | 7 |
| Navigation / Auth | 7 |
| Client-State | 68 |
| Clientseitig oder an geprüften Handler delegiert | 66 |
| **Gesamt** | **352** |

Die 352 Button-Familien liegen in 60 produktiv erreichbaren TSX-Dateien innerhalb eines Importgraphen aus 96 TSX-Modulen. Eine Quellstelle innerhalb einer `map`-Schleife zählt als eine dynamische Button-Familie; ihre Laufzeitinstanzen erben denselben Vertrag.

Nicht doppelt gezählt werden:

- der interne native `<button>` der gemeinsamen `Button`-Komponente;
- `Switch`-Controls, da sie verbindlich erst in Etappe 25 geprüft werden;
- nicht vom realen `App.tsx`-Graphen erreichbare Altmodule.

## Verbindliche Prüffelder

Jede Inventarzeile verweist auf ein Prüfprofil und eine Datei-Evidenz mit genau diesen Feldern:

- Permission
- Request
- Wirkung
- Loading
- Double Click
- Race
- Error
- Mobile

Die Datei-Evidenz ordnet die Quellstelle den realen Oberflächen aus Etappe 23 zu und übernimmt deren Permission-, API-, Test- und Mobile-Verträge. Client-only-Buttons besitzen bewusst keinen erfundenen HTTP-Request. Direkte Read-/Write-Requests müssen dagegen am JSX-Rand eine `disabled`- oder `loading`-Sperre besitzen; delegierte Aktionen sind als solche ausdrücklich klassifiziert.

## Festgestellte Ursachen und Härtung

Die Bestandsaufnahme fand vier wiederkehrende Button-Risiken:

1. Mehrere React-Query-Mutationen in Bot-Admin, Knowledge, Selfroles, Feeds, Factions, Whitelist und Linking waren während des Requests nicht gesperrt.
2. Direkte asynchrone Killfeed-, Übersetzungs-, Upload- und Nitrado-Mirror-Aktionen hatten uneinheitliche Single-Flight-/Loading-Verträge.
3. Icon-only-Aktionen besaßen teilweise keinen stabilen zugänglichen Namen.
4. Die gemeinsame `Button`-Komponente überließ den HTML-Typ dem Browser und konnte dadurch innerhalb eines Formulars unbeabsichtigt submitten.

Umgesetzt wurde deshalb:

- Pending-/Loading-Sperren für alle direkt erkannten `.mutate()`, Refresh-/Retry- und direkten asynchronen Aktionsbuttons;
- explizite Single-Flight-Zustände mit sofortigen Ref-Locks und `finally`-Freigabe für Killfeed, übersetzte Posts, DEV-Uploads und Nitrado-Mirror-Browse/File/Refresh;
- Sequenz-Invalidierung ohne liegenbleibende Loading-Sperren bei Upload-Kind- und Nitrado-Connection-Wechseln;
- sichtbare Fehlerkanäle für die dabei gehärteten direkten Requests;
- zugängliche Namen für sämtliche 352 Button-Familien;
- `type="button"` als sicherer Default der gemeinsamen `Button`-Komponente, während echte Submit-Buttons explizit `type="submit"` setzen;
- Beibehaltung des globalen mobilen 44×44-Pixel-Touch-Vertrags für Shared- und native Buttons.

## Drift-Gate

Der Architekturtest schlägt fehl, wenn:

- eine neue erreichbare Button-Quellstelle nicht inventarisiert wird;
- eine inventarisierte Datei oder Quellstelle verschwindet;
- eine Button-Familie kein Prüfprofil oder keine reale Surface-/Permission-/API-/Test-/Mobile-Evidenz besitzt;
- ein direktes `.mutate()` oder ein direkter Read-/Refresh-Request keinen Pending-Guard hat;
- ein Button keinen semantischen Namen besitzt;
- der sichere Default-Button-Typ oder der mobile 44-Pixel-Vertrag entfernt wird;
- ein `Switch` vorzeitig in Etappe 24 hineingezählt wird.

CRUD-Vollständigkeit, vollständige Action-Kopplung, sämtliche Statuscode-Fehlerfälle, die fünf getrennten Mobile-Breiten und API-Angriffs-/Race-Matrizen bleiben strikt den Etappen 25–38 vorbehalten.
