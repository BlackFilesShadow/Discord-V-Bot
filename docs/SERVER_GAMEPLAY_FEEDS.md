# Server-Gameplay-Feeds (Deathfeed + Baufeed V2)

## Ziel

Serverinterne Live-Feeds fuehren keine zweite Gameplay-Wahrheit ein. Die normalisierten `AdmEvent`-Datensaetze bleiben die kanonische persistente Datenquelle pro `guildId + nitradoConnId`.

## ADM-Quelle

- `NitradoAdmProfileConfig` speichert das ADM-Verzeichnis **pro Nitrado-Connection**.
- Der Pfad wird automatisch aus bekannten DayZ/Nitrado-Verzeichnissen erkannt. Eine globale `NITRADO_ADM_DIR`-Runtime gibt es nicht mehr.
- Owner koennen Pfad und optionale IANA-Zeitzone ueber `/api/v2/guilds/:guildId/adm-source?slot=N` pruefen bzw. korrigieren.
- Der kanonische ADM-V2-Ingest pollt **alle aktiven, an einen Gameserver gebundenen Connections** alle 30 Sekunden. Dadurch funktionieren Linking, Rewards und PlayerSessions unabhaengig davon, ob ein oeffentlicher Gameplay-Feed aktiviert ist.
- Der Live-Pfad verwendet Nitrados `file_server/seek` ab `AdmSourceCursor.processedByteOffset`; wachsende ADM-Dateien werden nicht wiederholt vollstaendig heruntergeladen.
- Unvollstaendige Schlusszeilen bewegen den Byte-Cursor nicht und werden beim naechsten Poll vollstaendig gelesen.
- Beim allerersten V2-Start wird der aktuelle Live-Log gebaselined; historischer Backlog wird nicht ungefragt verarbeitet oder gepostet.
- Linking-Challenges werden direkt aus den neu gelesenen vollstaendigen ADM-Zeilen verifiziert.
- Rewards und PlayerSessions werden anschliessend durch den V2-Postprocessor aus der kanonischen `AdmEvent`-Wahrheit verarbeitet.
- Der alte 15-Minuten-Vollfile-Sync und der Legacy-Killfeed-Watcher sind entfernt; es gibt nur noch einen ADM-Datei-Producer.

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
- Delivery-Status: `PENDING`, `SENDING`, `SENT`, `SKIPPED`, `RETRY`, `FAILED`.
- `SKIPPED` bedeutet bewusst durch einen nachtraeglich geaenderten Kategorie-Filter verworfen und wird nie als Discord-Post ausgegeben.
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

`ADM_EVENT_PIPELINE_V2=false` bleibt bis zur kontrollierten Live-Freigabe des **oeffentlichen Death-/Baufeeds** Standard. Der per-Server ADM-V2-Ingest fuer Linking, Rewards und PlayerSessions laeuft bereits unabhaengig von diesem Schalter. Bei `false` wird lediglich keine neue Gameplay-Feed-Nachricht an Discord zugestellt.

Nach Merge und Migration:

1. Produktions-Preflight/Backup und `prisma migrate deploy` + `prisma migrate status`.
2. Bot mit `ADM_EVENT_PIPELINE_V2=false` starten und Health/Login/DB/Migration pruefen.
3. Im DEV-ADM-Status bestaetigen, dass pro aktivem Slot eine Quelle und ein Byte-Cursor erkannt werden; Pfad und Zeitzone bei Bedarf ueber `adm-source` korrigieren.
4. Linking-Challenge und PlayerSession/Reward-Postprocessing auf einem Testslot pruefen.
5. DayZ-Servereinstellungen fuer Death-/Baufeed pruefen: die benoetigten Admin-Logs muessen serverseitig aktiviert sein.
6. `ADM_EVENT_PIPELINE_V2=true` kontrolliert fuer den oeffentlichen Testfeed aktivieren.
7. Auf einem Server PvP, normaler Tod, Suizid, NPC, Fahrzeug sowie Placement/Build/Dismantle/Destroy pruefen.
8. Nitrado-Dateiwechsel/Serverrestart, Botrestart und Discord-Fehler/Retry testen.
9. Bestaetigen: keine Doppelposts, keine verlorenen Posts, kein Cross-Server-Leak und korrekte Zeitstempel.
10. Erst danach weitere Server und Reward-Gates freigeben.
