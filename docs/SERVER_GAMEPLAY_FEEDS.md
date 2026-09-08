# Server-Gameplay-Feeds (Killfeed + Deathfeed + weitere ADM-Feeds)

## Ziel

Serverinterne Live-Feeds fuehren keine zweite Gameplay-Wahrheit ein. Die normalisierten `AdmEvent`-Datensaetze bleiben die kanonische persistente Datenquelle pro `guildId + nitradoConnId`.

## ADM-Quelle

- `NitradoAdmProfileConfig` speichert das ADM-Verzeichnis **pro Nitrado-Connection**.
- Der Pfad wird automatisch aus bekannten DayZ/Nitrado-Verzeichnissen erkannt. Eine globale `NITRADO_ADM_DIR`-Runtime gibt es nicht mehr.
- Owner koennen Pfad und optionale IANA-Zeitzone ueber `/api/v2/guilds/:guildId/adm-source?slot=N` pruefen bzw. korrigieren.
- Der kanonische ADM-V2-Ingest pollt **alle aktiven, an einen Gameserver gebundenen Connections** alle 30 Sekunden. Dadurch funktionieren Linking, Rewards und PlayerSessions unabhaengig davon, ob ein oeffentlicher Gameplay-Feed konfiguriert ist.
- Der Live-Pfad verwendet Nitrados `file_server/seek` ab `AdmSourceCursor.processedByteOffset`; wachsende ADM-Dateien werden nicht wiederholt vollstaendig heruntergeladen.
- Unvollstaendige Schlusszeilen bewegen den Byte-Cursor nicht und werden beim naechsten Poll vollstaendig gelesen.
- Beim allerersten V2-Start wird der aktuelle Live-Log gebaselined; historischer Backlog wird nicht ungefragt verarbeitet oder gepostet.
- Linking-Challenges werden direkt aus den neu gelesenen vollstaendigen ADM-Zeilen verifiziert.
- Rewards und PlayerSessions werden anschliessend durch den V2-Postprocessor aus der kanonischen `AdmEvent`-Wahrheit verarbeitet.
- Der alte 15-Minuten-Vollfile-Sync und die parallele Legacy-Killfeed-Runtime sind entfernt; es gibt nur noch einen ADM-Datei-Producer und einen Gameplay-Feed-Delivery-Pfad.

## Kanonische Ereignisse und Feed-Grenzen

### Killfeed

Der Killfeed ist eine eigene, anklickbare Dashboard-Funktion und enthaelt ausschliesslich belegte PvP-Kills:

- `PLAYER_KILLED` -> `KILL / PVP`

Ein PvP-Kill wird **nicht** gleichzeitig als Deathfeed-Ereignis behandelt. Der sichtbare V-Kill-Report kann Killer, Opfer, Waffe, Distanz, beide Positionen und - wenn eine korrelierbare `PLAYER_HIT`-Zeile vorliegt - Trefferzone und Schaden anzeigen.

### Deathfeed

Der Deathfeed ist strikt vom PvP-Killfeed getrennt und umfasst alle kanonisch erkannten Nicht-PvP-Tode:

- `PLAYER_SUICIDE` -> `DEATH / SUICIDE`
- `NPC_KILL` -> `DEATH / NPC`
- `VEHICLE_DEATH` -> `DEATH / VEHICLE`
- `PLAYER_DIED` -> `DEATH / OTHER`

`PLAYER_DIED` wird nicht mehr verworfen. Wenn der ADM-Parser eine konkrete Rohursache belegt, bleibt diese erhalten und erscheint im `Death Report`, z.B. `Bled out`, `Drowned`, `Respawn`, `Disconnect while unconscious`, `Land Mine`, `M67 Fragmentation Grenade` oder eine andere nicht weiter klassifizierte Ursache. Wenn die ADM-Zeile keine Ursache nennt, wird im Embed ausdruecklich angezeigt, dass der ADM-Log keine genauere Ursache liefert; es wird nichts erfunden.

DayZ kann fuer denselben finalen Tod mehrere ADM-Zeilen schreiben, beispielsweise einen spezifischen `PLAYER_SUICIDE` und unmittelbar danach einen generischen `PLAYER_DIED`. Beide Datensaetze bleiben in `AdmEvent`. Fuer die Discord-Zustellung korreliert die Runtime generische `PLAYER_DIED`-Ereignisse streng nach Gameserver, stabiler Game-ID und engem Ereigniszeitfenster. Existiert fuer denselben Tod bereits `PLAYER_KILLED`, `PLAYER_SUICIDE`, `NPC_KILL` oder `VEHICLE_DEATH`, wird der generische `OTHER`-Post unterdrueckt. Dadurch bleiben Rohdaten vollstaendig, ohne doppelte sichtbare Todesmeldungen zu erzeugen.

Ein nicht-toedlicher `hit by [vehicle]` bleibt weiterhin nur Rohdaten (`PLAYER_HIT`) und erscheint in keinem Todesfeed.

### Baufeed

- `BUILD`
- `DISMANTLE`
- `DESTROY`

### Placement-Feed

- `PLACEMENT`

Placement und Baufeed bleiben semantisch getrennte Feed-Typen, auch wenn beide den gleichen ADM-Store verwenden.

## Discord-Embed

- Spielernamen werden Markdown-sicher gerendert, aber nicht in einen Inline-Codeblock gepackt.
- Positionsfelder sind klickbare iZurvive-Location-Links nach dem Format `#location=x;y;zoomlevel`.
- Opfer-, Killer-, Todes-, Flaggen- und Baupositionen verwenden denselben abgesicherten Positionspfad.
- Der sichtbare Serverbezug besteht ausschliesslich aus dem konfigurierten **Server-Alias**. Slotnummern und technische Connection-/Event-/Delivery-IDs werden nicht im Embed angezeigt.
- Nur der eigentliche **V-Kill/PvP-Feed** (`KILL / PVP`) bleibt ohne zusaetzliche Ereigniszeit im sichtbaren Layout.
- Self Kill, Wild Kill, Crash Kill, allgemeine Death Reports sowie Placement-/Bau-/Flaggen-Reports zeigen die belegte Ereigniszeit direkt unter dem Feld **Server**.
- Die Online List zeigt **Stand** direkt unter dem Feld **Server**. Ein allgemeiner Discord-Embed-Zeitstempel wird dafuer nicht zusaetzlich verwendet.
- Die technische Idempotenz liegt unsichtbar in Discord `nonce + enforce_nonce`, nicht in sichtbaren Embed-Inhalten.

## Persistenz und Zustellung

- `AdmEvent`: kanonischer normalisierter Server-Gameplay-Store.
- `GameplayFeedConfig`: Subscription/Filter pro Gameserver, Feed-Typ und Discord-Channel.
- `GameplayFeedDelivery`: persistente Zustellung pro `GameplayFeedConfig + AdmEvent`.
- Feed-Typen: `KILL`, `DEATH`, `BUILD`, `PLACEMENT`, `PLAYER_LIST`, `FLAG`.
- Delivery-Status: `PENDING`, `SENDING`, `SENT`, `SKIPPED`, `RETRY`, `FAILED`.
- `SKIPPED` bedeutet bewusst durch einen nachtraeglich geaenderten Kategorie-Filter verworfen und wird nie als Discord-Post ausgegeben.
- Ein Lease verhindert parallele Doppelzustellung und macht abgestuerzte `SENDING`-Jobs wieder retrybar.
- Exponentieller Retry behandelt temporaere Discord-Fehler.
- Jede ADM-Zustellung verwendet einen stabilen Discord-Nonce. Wird das Crash-Fenster `Discord-Send erfolgreich, DB-Commit danach fehlgeschlagen` erneut ausgefuehrt, verhindert Discord mit `enforce_nonce` einen zweiten sichtbaren Post.
- Der Scan nutzt einen persistenten High-Watermark (`cursorCreatedAt + cursorEventId`) statt immer die aeltesten Events zu lesen.
- Kategorie-Filter werden vor dem Enqueue und erneut vor dem Send angewendet.

## Migration bestehender Konfigurationen

Historisch war `PVP` Bestandteil des Feed-Typs `DEATH`. Die Migration fuehrt deshalb den neuen Enum-Wert `KILL` in einem eigenen PostgreSQL-Migrationsschritt ein und trennt anschliessend bestehende Konfigurationen:

- reine historische PvP-Konfigurationen werden zu `KILL` mit Kategorie `PVP`;
- gemischte historische `DEATH`-Konfigurationen werden in `KILL/PVP` und einen Nicht-PvP-`DEATH`-Feed aufgeteilt;
- bestehende `PLAYER_KILLED`-Delivery-Datensaetze werden auf die neue KILL-Konfiguration uebertragen statt erneut erzeugt;
- vollstaendige historische Nicht-PvP-Deathfeeds erhalten zusaetzlich `OTHER`, damit kanonische `PLAYER_DIED`-Ursachen sichtbar werden;
- bewusst eng konfigurierte Deathfeeds, z.B. nur `SUICIDE`, werden nicht automatisch verbreitert.

Damit bleiben bestehende Zustellhistorie, Retry-Zustand und sichtbare Discord-Idempotenz erhalten.

## Runtime-Gate

Die produktive Gameplay-Feed-Runtime wird immer zusammen mit der Nitrado-Runtime gestartet. Es gibt kein zusaetzliches globales `ADM_EVENT_PIPELINE_V2`-Environment-Gate mehr.

Das eigentliche Opt-in bleibt strikt servergescoppt: Nur eine vorhandene `GameplayFeedConfig` mit `isActive=true`, passender Kategorie und gueltigem Discord-Channel erzeugt eine Nachricht.

## Realtime-Transport

Socket.IO `/guild` besitzt zwei getrennte Room-Typen:

- `g:<guildId>` fuer guild-weite Konfigurations-/UI-Aenderungen.
- `gs:<guildId>:<nitradoConnId>` fuer Live-Gameplay eines exakt gebundenen Gameservers.

Live-Ereignisse werden ausschliesslich als `server.gameplay.event` an den exakten `gs:`-Room gesendet. Es gibt keinen Guild-Fallback. Ein Socket-Fehler darf die persistente Discord-Zustellung nicht zurueckrollen.

## Dashboard/API

Der bestehende `/killfeed`-API-Pfad bleibt aus Rueckwaertskompatibilitaet erhalten, der `kind` ist jedoch fachlich getrennt:

- `GET/POST /api/v2/guilds/:guildId/killfeed?slot=N&kind=KILL`
- `GET/POST /api/v2/guilds/:guildId/killfeed?slot=N&kind=DEATH`
- `GET/POST /api/v2/guilds/:guildId/killfeed?slot=N&kind=BUILD`
- `GET/POST /api/v2/guilds/:guildId/killfeed?slot=N&kind=PLACEMENT`
- `GET/POST /api/v2/guilds/:guildId/killfeed?slot=N&kind=PLAYER_LIST`
- `GET/POST /api/v2/guilds/:guildId/killfeed?slot=N&kind=FLAG`
- `PATCH/DELETE /api/v2/guilds/:guildId/killfeed/:id?slot=N&kind=...`
- `GET /api/v2/guilds/:guildId/killfeed/:id/recent?slot=N`
- `GET/PATCH /api/v2/guilds/:guildId/adm-source?slot=N`
- `POST /api/v2/guilds/:guildId/adm-source/rediscover?slot=N`

Im Dashboard sind `💀 Killfeed` und `☠️ Deathfeed` zwei eigenstaendig anklickbare Funktionen. Ein Killfeed kann ausschliesslich `PVP` enthalten; ein Deathfeed ausschliesslich `SUICIDE`, `NPC`, `VEHICLE` und `OTHER`.

Feed-Channels benoetigen nur `ViewChannel`, `SendMessages` und `EmbedLinks`. `ReadMessageHistory` ist fuer den Gameplay-Feed nicht erforderlich, weil die Retry-Deduplizierung ueber den stabilen Discord-Nonce erfolgt.

## Produktionspruefung

Nach Merge und Migration:

1. Produktions-Preflight/Backup und `prisma migrate deploy` + `prisma migrate status`.
2. Bot starten und Health/Login/DB/Migration pruefen.
3. Im DEV-ADM-Status bestaetigen, dass pro aktivem Slot eine Quelle und ein Byte-Cursor erkannt werden; Pfad und Zeitzone bei Bedarf ueber `adm-source` korrigieren.
4. Pruefen, dass fuer den Zielserver getrennte aktive KILL-/DEATH-Konfigurationen mit den gewuenschten Discord-Channels vorhanden sind.
5. Linking-Challenge und PlayerSession/Reward-Postprocessing auf einem Testslot pruefen.
6. DayZ-Servereinstellungen fuer ADM-Logs pruefen.
7. Nach aktivierter Feed-Konfiguration neue Ereignisse erzeugen: PvP-Kill, Suizid, Tier/Infizierten-Tod, Fahrzeugtod, Verbluten/Ertrinken bzw. sonstigen `PLAYER_DIED`, Placement, Build, Dismantle und Destroy.
8. Bestaetigen, dass PvP ausschliesslich im Killfeed erscheint und Nicht-PvP-Tode ausschliesslich im Deathfeed.
9. Einen Tod mit spezifischer und nachfolgender generischer ADM-Zeile pruefen: Beide muessen in `AdmEvent` erhalten bleiben, aber nur ein Discord-Todespost darf entstehen.
10. Fuer ein neues Live-Ereignis bis zu etwa 45 Sekunden einplanen: ADM-Poll maximal 30 Sekunden plus Gameplay-Feed-Poll maximal 15 Sekunden.
11. Nitrado-Dateiwechsel/Serverrestart, Botrestart und Discord-Fehler/Retry testen.
12. Bestaetigen: keine verlorenen oder doppelten Posts, kein Cross-Server-Leak, saubere Embed-Darstellung und korrekte Kartenlinks.

Die Regressionen unter `tests/modules/gameplayFeed*.test.ts`, `tests/modules/admVanillaDeathCoverage.test.ts` sowie `dashboard-ui/e2e/killfeed-authenticated.spec.ts` pruefen die fachliche Trennung, ADM-Kategorieableitung, `PLAYER_DIED`-Abdeckung, Duplicate-Unterdrueckung, Embed-Layouts, Retry-Pfad und die getrennt anklickbaren Dashboard-Funktionen.
