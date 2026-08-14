# Server-Gameplay-Feeds (Deathfeed + Baufeed V2)

## Ziel

Serverinterne Live-Feeds fuehren keine zweite Gameplay-Wahrheit ein. Die normalisierten `AdmEvent`-Datensaetze bleiben die kanonische persistente Datenquelle pro `guildId + nitradoConnId`.

## ADM-Quelle

- `NitradoAdmProfileConfig` speichert das ADM-Verzeichnis **pro Nitrado-Connection**.
- Der Pfad wird automatisch aus bekannten DayZ/Nitrado-Verzeichnissen erkannt; `NITRADO_ADM_DIR` ist nur Legacy-Fallback.
- Owner koennen Pfad und optionale IANA-Zeitzone ueber `/api/v2/guilds/:guildId/adm-source?slot=N` pruefen bzw. korrigieren.
- V2 pollt nur Connections mit aktivem Gameplay-Feed alle 30 Sekunden.
- Der Live-Pfad verwendet Nitrados `file_server/seek` ab `AdmSourceCursor.processedByteOffset`; wachsende ADM-Dateien werden nicht wiederholt vollstaendig heruntergeladen.
- Unvollstaendige Schlusszeilen bewegen den Byte-Cursor nicht und werden beim naechsten Poll vollstaendig gelesen.
- Beim allerersten V2-Start wird der aktuelle Live-Log gebaselined; historischer Backlog wird nicht ungefragt gepostet.
- Der bestehende 15-Minuten-ADM-Sync bleibt vorerst fuer Linking, Rewards und PlayerSessions aktiv. Beide Pfade schreiben idempotent in `AdmEvent`.

## Kanonische Ereignisse

### Deathfeed

- `PLAYER_KILLED` -> `PVP`
- `PLAYER_DIED` -> `DEATH`
- `PLAYER_SUICIDE` -> `SUICIDE`
- `NPC_KILL` -> `NPC`
- `VEHICLE_DEATH` -> `VEHICLE`

Ein normaler `PLAYER_DIED` ist **kein PvP-Kill**. Ein nicht-toedlicher `hit by [vehicle]` bleibt `PLAYER_HIT` und erscheint nicht im Deathfeed.

### Baufeed

- `PLACEMENT`
- `BUILD`
- `DISMANTLE`
- `DESTROY`

Objekt und Werkzeug werden getrennt normalisiert, z.B. `built Fence with Shovel` -> Objekt `Fence`, Werkzeug `Shovel`.

## Persistenz und Zustellung

- `AdmEvent`: kanonischer normalisierter Server-Gameplay-Store.
- `GameplayFeedConfig`: Subscription/Filter pro Gameserver, Feed-Typ und Discord-Channel.
- `GameplayFeedDelivery`: persistente Zustellung pro `GameplayFeedConfig + AdmEvent`.
- Delivery-Status: `PENDING`, `SENDING`, `SENT`, `RETRY`, `FAILED`.
- Ein Lease verhindert parallele Doppelzustellung und macht abgestuerzte `SENDING`-Jobs wieder retrybar.
- Exponentieller Retry behandelt temporaere Discord-Fehler.
- Ein versteckter Footer-Marker `V-Bot event:<AdmEvent.id>` erlaubt die Reconciliation des Crash-Fensters: Discord-Send erfolgreich, DB-Commit danach fehlgeschlagen.
- Der Scan nutzt einen persistenten High-Watermark (`cursorCreatedAt + cursorEventId`) statt immer die aeltesten 200 Events zu lesen. Dadurch bleiben neue Ereignisse auch bei grossem Backlog erreichbar.
- Kategorie-Filter werden vor dem Enqueue und erneut vor dem Send angewendet.

Bestehende `KillfeedConfig`-Datensaetze werden bei der Migration als `DEATH`-Feeds uebernommen. Historische `DEATH`-Kategorie entspricht dabei `PVP`. Alte erfolgreiche Deliveries werden als `SENT` uebernommen; alte Claims ohne `messageId` werden als `RETRY` behandelt, weil sie keinen erfolgreichen Discord-Post beweisen.

## Realtime-Transport

Socket.IO `/guild` besitzt zwei getrennte Room-Typen:

- `g:<guildId>` fuer guild-weite Konfigurations-/UI-Aenderungen.
- `gs:<guildId>:<nitradoConnId>` fuer Live-Gameplay eines exakt gebundenen Gameservers.

Live-Ereignisse werden ausschliesslich als `server.gameplay.event` an den exakten `gs:`-Room gesendet. Es gibt keinen Guild-Fallback. Ein Socket-Fehler darf die persistente Discord-Zustellung nicht zurueckrollen.

## Dashboard/API

Der bestehende Pfad bleibt kompatibel:

- `GET/POST /api/v2/guilds/:guildId/killfeed?slot=N&kind=DEATH`
- `GET/POST /api/v2/guilds/:guildId/killfeed?slot=N&kind=BUILD`
- `PATCH/DELETE /api/v2/guilds/:guildId/killfeed/:id?slot=N&kind=...`
- `GET /api/v2/guilds/:guildId/killfeed/:id/recent?slot=N`
- `GET/PATCH /api/v2/guilds/:guildId/adm-source?slot=N`
- `POST /api/v2/guilds/:guildId/adm-source/rediscover?slot=N`

Feed-Channels benoetigen `ViewChannel`, `SendMessages`, `EmbedLinks` und `ReadMessageHistory` (letzteres fuer Crash-Reconciliation).

## Produktionsfreigabe

`ADM_EVENT_PIPELINE_V2=false` bleibt bis zur kontrollierten Live-Freigabe Standard. Bei `false` laeuft weiterhin nur der Legacy-Killfeed; Legacy und V2 posten niemals gleichzeitig.

Nach Merge und Migration:

1. Produktions-Preflight/Backup und `prisma migrate deploy` + `prisma migrate status`.
2. Bot mit `ADM_EVENT_PIPELINE_V2=false` starten und Health/Login/DB/Migration pruefen.
3. ADM-Quelle eines Testslots per `adm-source` pruefen; Pfad und Zeitzone bei Bedarf manuell setzen.
4. DayZ-Servereinstellungen fuer Death-/Baufeed pruefen: die benoetigten Admin-Logs muessen serverseitig aktiviert sein.
5. `ADM_EVENT_PIPELINE_V2=true` kontrolliert fuer den Testlauf aktivieren.
6. Auf einem Server PvP, normaler Tod, Suizid, NPC, Fahrzeug sowie Placement/Build/Dismantle/Destroy pruefen.
7. Nitrado-Dateiwechsel/Serverrestart, Botrestart und Discord-Fehler/Retry testen.
8. Bestaetigen: keine Doppelposts, keine verlorenen Posts, kein Cross-Server-Leak und korrekte Zeitstempel.
9. Erst danach weitere Server und Reward-Gates freigeben.
