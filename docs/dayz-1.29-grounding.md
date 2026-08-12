# DayZ 1.29 Grounding – Chernarus, Livonia, Sakhal

## Zweck

Diese Wissensbasis ersetzt pauschale DayZ-Regeln der V-Bot-AI durch nachvollziehbare, kartenbezogene Fakten.

Primaerbasis:
1. `1.29_chernarus_vanilla_fehler_frei(2).zip`
2. `1.29_livonia_vanilla_files_Fehler_Frei(1).zip`
3. `1.29_sakhal_vanilla_files_fehler_frei.zip`

Gegenpruefung:
- BohemiaInteractive/DayZ-Central-Economy, Branch `DZ_129`
- Bohemia Interactive Community: Central Economy, CE mission files modding, custom terrains, Gameplay Settings, Player Spawning, Weather, Contaminated Areas, Underground Areas und Server Configuration
- Nitrado-Dokumentation nur fuer Nitrado-Webinterface-/Dateibrowser-Prozeduren

## Vierfacher Halluzinationscheck

Jede DayZ-Faktaussage soll vier Stufen bestehen:

1. **Datei-Beleg** – Struktur oder konkreter Wert ist in mindestens einem der drei gelieferten 1.29-Datensaetze vorhanden.
2. **Karten-Vergleich** – Chernarus/Livonia/Sakhal werden gegengeprueft. Unterschiede werden als Varianten behandelt.
3. **Offizielle Semantik** – Bedeutung einer Datei/eines Feldes wird mit Bohemia DZ_129/Dokumentation abgeglichen. Nitrado ist nur fuer Hosting-Bedienwege autoritativ.
4. **Antwort-Check** – Keine fehlende Zahl, kein Feld, kein Pfad und keine Abhaengigkeit wird ergaenzt. Unsicherheit wird explizit benannt.

## Wichtigste Korrekturen der alten Wissensbasis

### Keine pauschale `nominal/min/max <= 25`-Regel

Die drei echten 1.29-Datensaetze enthalten regulaer Werte ueber 25.

`types.xml`:
- Chernarus: max `nominal=120`; 246 `nominal`-Werte >25; max `min=95`
- Livonia: max `nominal=110`; 109 `nominal`-Werte >25; max `min=95`
- Sakhal: max `nominal=150`; 82 `nominal`-Werte >25; max `min=140`

Beispiele:
- Chernarus `WaterBottle`: `nominal=100`, `min=85`
- Sakhal `Matchbox`: `nominal=150`, `min=140`
- Chernarus `Mosin9130`: `nominal=40`, `min=35`

Die alte Runtime-Regel, Werte >25 auf `15/8/20` umzuschreiben, erzeugte daher selbst falsche Daten und wird entfernt.

### `min == nominal` ist moeglich

Positive Gleichheit kommt in allen drei `types.xml`-Datensaetzen vor:
- Chernarus: 8 Faelle
- Livonia: 15 Faelle
- Sakhal: 3 Faelle

Beispiele:
- Chernarus M4A1 `1/1`
- Livonia M4A1 `1/1`
- Sakhal Mich2001Helmet `2/2`

Darum keine universelle Regel `min < nominal`.

### Lange Lifetimes sind real

Maximale beobachtete `lifetime`: 3.888.000 Sekunden.
Maximale beobachtete `restock`: 43.200 Sekunden.

Zelte und persistente Objekte koennen deshalb weit ueber alten pauschalen 28.800-Sekunden-Beispielgrenzen liegen.

### `db/economy.xml` ist eine echte Missionsdatei

Alle drei gelieferten 1.29-Datensaetze enthalten `db/economy.xml`. Die Bohemia-DZ_129-Referenz ebenfalls. Bohemia beschreibt sie als Hauptkonfiguration, mit der CE-Init/Load/Save/Respawn fuer Entity-Gruppen geschaltet werden.

### `messages.xml` ist nicht auf jeder Karte vorhanden

Chernarus und Livonia enthalten `db/messages.xml`; die untersuchte Sakhal-1.29-Mission nicht. Darum darf `messages.xml` weder als erfunden noch als zwingende Datei jeder Map behandelt werden.

## Kartenvergleich

### types.xml

Anzahl `<type>`:
- Chernarus: 1942
- Livonia: 1939
- Sakhal: 1955

1920 Typnamen sind allen drei gemeinsam. 1539 dieser gemeinsamen Typen unterscheiden sich in mindestens einem ausgewerteten CE-Feld.

Beispiel M4A1:
- Chernarus: nominal 1, min 1, lifetime 7200, restock 3600, Usage `ContaminatedArea`
- Livonia: nominal 1, min 1, lifetime 7200, restock 3600, Usage `ContaminatedArea`
- Sakhal: nominal 2, min 1, lifetime 7200, restock 7200, Usage `Special`

Beispiel SVD:
- Chernarus: 1/1, Usage `ContaminatedArea`
- Livonia: 2/1, Usage `Military`
- Sakhal: 0/0, Usage `Underground`

Beispiel Mosin9130:
- Chernarus: 40/35
- Livonia: 16/10
- Sakhal: 10/7

Folgerung: gleiche Klassenbezeichnung bedeutet nicht gleiche Economy-Einstellung.

### events.xml

Eventanzahl:
- Chernarus: 59
- Livonia: 53
- Sakhal: 62

Event-`max` reicht in den Datensaetzen bis 250. Damit ist auch fuer `events.xml` eine pauschale 10–20/25-Regel falsch. Event-Felder muessen anhand des konkreten Event-/Limit-/Child-Kontexts erklaert werden.

### cfgGameplay.json

Die grundlegende Key-Struktur ist sehr aehnlich, aber mapbezogene Werte unterscheiden sich.

Beispiele:
- `WorldsData.lightingConfig`: Sakhal 2, Livonia 0, Chernarus 0
- Sakhal `WorldsData.playerRestrictedAreaFiles`: `pra/warheadstorage.json`
- Livonia/Chernarus: dort im gelieferten Datensatz leer
- Environment-Min-/Max-Temperature-Arrays sind mapbezogen.

### cfgEffectArea.json

- Chernarus: 9 Areas + 55 SafePositions
- Livonia: 8 Areas + 27 SafePositions
- Sakhal: 50 Areas; stark andere Effect-/Geysir-/Vulkan-Struktur

Bohemia dokumentiert, dass sich das Static-Contaminated-Area-Format ab 1.28 geaendert hat. Darum darf eine Strukturvariante nicht automatisch als Fehler markiert werden.

### cfgUndergroundTriggers.json

- Chernarus: 0 Triggers
- Livonia: 8 Triggers, 21 Breadcrumbs
- Sakhal: 30 Triggers, 21 Breadcrumbs

Bohemia unterscheidet `Triggers` und `Breadcrumbs` und beschreibt die Eye-Accommodation-/Underground-Logik.

### cfgWeather.xml

Alle drei nutzen dieselbe Grundidee (Overcast/Fog/Rain/Wind/Snowfall/Storm), aber die Werte sind mapbezogen. Sakhal begrenzt Rain in der gelieferten Datei auf 0 und konfiguriert Snowfall; Chernarus/Livonia erlauben Rain bis 1.0.

### cfgEventSpawns.xml

- Chernarus: 33 Eventdefinitionen, 1435 Positionen, 9 Zonen
- Livonia: 31 Eventdefinitionen, 693 Positionen, 8 Zonen
- Sakhal: 47 Eventdefinitionen, 753 Positionen, 5 Zonen

### cfgEventGroups.xml

- Chernarus: 83 Gruppen / 874 Children
- Livonia: 61 Gruppen / 709 Children
- Sakhal: 1 Gruppe / 2 Children

Das zeigt eine echte Variation der Missionskonstruktion. Die kleinere Sakhal-Datei ist nicht automatisch unvollstaendig.

### cfgSpawnableTypes.xml / cfgRandomPresets.xml

`cfgspawnabletypes.xml`:
- Chernarus: 574 Typen
- Livonia: 576
- Sakhal: 582
- 573 Typnamen gemeinsam

`cfgrandompresets.xml`:
- Chernarus: 78 Presets
- Livonia: 71
- Sakhal: 78
- 71 Presets gemeinsam

Bohemia: `cfgspawnabletypes.xml` steuert zufaellige Cargo-/Attachment-Inhalte; `cfgrandompresets.xml` liefert wiederverwendbare Presets.

### cfgPlayerSpawnPoints.xml

Chernarus:
- fresh: 11 Gruppen / 49 Positionen
- hop: 10 / 50
- travel: 10 / 50

Livonia:
- fresh: 12 / 63
- hop: 6 / 44
- travel: 6 / 44

Sakhal:
- fresh: 1 / 39
- hop: 1 / 39
- travel: 1 / 39

Bohemia dokumentiert fresh/hop/travel als getrennte Spawn-Bereiche. Die Gruppierungsstrategie ist mapbezogen.

### Mapgroups / Loot-Space

`mapgrouppos.xml` Gruppen:
- Chernarus 11679
- Livonia 5723
- Sakhal 8332

`mapgroupproto.xml` Prototypen:
- Chernarus 424
- Livonia 444
- Sakhal 523

Bohemia weist bei Custom Terrains darauf hin, dass `nominal`/`min` an die vorhandene Loot-Space-/Gebaeudemenge des Terrains angepasst werden muessen. Das ist ein weiterer Grund, Economy-Werte nicht blind zwischen Karten zu kopieren.

### env Territories

Zombie-Zonen:
- Chernarus 768
- Livonia 328
- Sakhal 417

Sakhal besitzt u. a. `reindeer_territories.xml`; die Tierdatei-Auswahl ist mapbezogen.

## ZIP vs. Bohemia DZ_129

Viele Dateien sind byte-/blob-identisch zur Bohemia-DZ_129-Referenz, andere weichen ab. Beispiele fuer Abweichungen gibt es unter anderem bei `db/types.xml`, `db/events.xml`, `cfgeventspawns.xml`, `cfggameplay.json` und einigen grossen Mapgroup-Dateien.

Diese Abweichung allein ist KEIN Fehlerbeweis. Moegliche Ursachen sind Distribution/Plattform/Hosting-Paketierung, Formatierung oder eine gepflegte Vanilla-Variante.

Regel fuer V-Bot:
- ZIP-Beobachtung und Bohemia-DZ_129-Beobachtung getrennt halten.
- Bei Gleichheit kann die Aussage als stark bestaetigt gelten.
- Bei Unterschied als Variante kennzeichnen, bis die Ursache belegt ist.
- Nie eine Abweichung ohne Beleg zu "reparieren".

## XML-Syntax-Sonderfall

Livonias `cfgspawnabletypes.xml` enthaelt einen Kommentar mit einer `--`-Sequenz, die nach strengem W3C-XML unzulaessig ist. Derselbe Kommentarstil ist in der offiziellen Bohemia-DZ_129-Datei vorhanden.

Folgerung: Strenge XML-Library-Validierung und DayZ-Engine-Akzeptanz sind nicht immer identisch. Ein Validator darf solche offiziellen Engine-Dateien nicht vorschnell als DayZ-fehlerhaft einstufen, ohne die DayZ-Referenz gegenzupruefen.

## Antwortstrategie fuer V-Bot

1. Frage einem Dateityp/Thema zuordnen.
2. Wenn eine Karte genannt wird: nur diese Kartenreferenz verwenden.
3. Wenn keine Karte genannt wird und Werte variieren: Kartenvergleich ausgeben.
4. Exakte Item-/Event-Werte nur nennen, wenn sie in einer eingebetteten Referenz oder echten Serverdatei belegt sind.
5. Fuer nicht eingebettete konkrete Werte erklaeren, wo sie in der Datei stehen, statt einen Wert zu erfinden.
6. "Bei uns" bedeutet: realen Nitrado-Snapshot/Serverdatei lesen; keine Vanilla-Referenz als Serverwert ausgeben.
7. Nitrado-Dokumentation nur fuer Klick-/Bearbeitungswege; Feldsemantik kommt von Bohemia/Dateien.

## Offizielle Referenzen

- https://github.com/BohemiaInteractive/DayZ-Central-Economy/tree/DZ_129
- https://community.bohemia.net/wiki/DayZ:Central_Economy_Configuration
- https://community.bohemia.net/wiki/DayZ:Central_Economy_mission_files_modding
- https://community.bohemia.net/wiki/DayZ:Central_Economy_setup_for_custom_terrains
- https://community.bohemia.net/wiki/DayZ:Gameplay_Settings
- https://community.bohemia.net/wiki/DayZ:Player_Spawning_Configuration
- https://community.bohemia.net/wiki/DayZ:Weather_Configuration
- https://community.bohemia.net/wiki/DayZ:Contaminated_Areas_Configuration
- https://community.bohemia.net/wiki/DayZ:Underground_Areas_Configuration
- https://community.bohemia.net/wiki/DayZ:Server_Configuration
- https://server.nitrado.net/de-DE/guides/konfiguration-eines-dayz-servers/
- https://server.nitrado.net/de-DE/guides/xml-dateien-manuell-bearbeiten-mit-der-dayz-konsole/
