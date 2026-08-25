# Server-Gameplay-Feeds (Deathfeed + Baufeed V2)

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

## Kanonische Ereignisse

### Deathfeed

Zustellbare Discord-Kategorien:

- `PLAYER_KILLED` -> `PVP`
- `PLAYER_SUICIDE` -> `SUICIDE`
- `NPC_KILL` -> `NPC`
- `VEHICLE_DEATH` -> `VEHICLE`

`PLAYER_DIED` bleibt als kanonisches ADM-Rohereignis fuer Diagnose/Historie erhalten, wird aber bewusst **nicht** als eigener Discord-Gameplay-Feed zugestellt. Die generische DayZ-Zeile liefert auf Konsole keinen belastbaren einheitlichen Todesgrund. Ein nicht-toedlicher `hit by [vehicle]` bleibt ebenfalls nur Rohdaten (`PLAYER_HIT`) und erscheint nicht im Deathfeed.

DayZ kann fuer denselben finalen Tod mehrere ADM-Zeilen schreiben, beispielsweise einen spezifischen `PLAYER_SUICIDE` und unmittelbar danach einen generischen `PLAYER_DIED`. Beide Datensaetze bleiben in `AdmEvent`; sichtbar zugestellt wird nur das spezifische, unterstuetzte Todesereignis. Dadurch entsteht kein zweiter generischer "Tod"-Post neben Suizid/PvP/NPC/Fahrzeugtod.

### Baufeed

- `PLACEMENT`
- `BUILD`
- `DISMANTLE`
- `DESTROY`

Objekt und Werkzeug werden getrennt normalisiert, z.B. `built Fence with Shovel` -> Objekt `Fence`, Werkzeug `Shovel`.

## Discord-Embed

- Spielernamen werden Markdown-sicher gerendert, aber nicht mehr in einen Inline-Codeblock gepackt. Namen mit Unterstrichen wie `Void__Architect` erscheinen dadurch ohne sichtbare Escape-Zeichen.
- Positionsfelder sind klickbare iZurvive-Location-Links nach dem Format `#location=x;y;zoomlevel`.
- Opfer-, Toeter- und Baupositionen verwenden denselben Link-Renderer.
- Der sichtbare Serverbezug besteht ausschliesslich aus dem konfigurierten **Server-Alias**. Slotnummern und technische Connection-/Event-/Delivery-IDs werden nicht im Embed angezeigt.
- Death-/Kill-Feeds (`PVP`, `SUICIDE`, `NPC`, `VEHICLE`) bleiben ohne zusaetzliche Ereigniszeit im sichtbaren Layout.
- Nicht-Kill-Gameplay-Feeds (`PLACEMENT`, `BUILD`, `DISMANTLE`, `DESTROY`) zeigen **Ereigniszeit** direkt unter dem Feld **Server**.
- Die Online List zeigt **Stand** direkt unter dem Feld **Server**. Ein allgemeiner Discord-Embed-Zeitstempel wird dafuer nicht zusaetzlich verwendet.
- Die technische Idempotenz liegt unsichtbar in Discord `nonce + enforce_nonce`, nicht in sichtbaren Embed-Inhalten.

## Persistenz und Zustellung

- `AdmEvent`: kanonischer normalisierter Server-Gameplay-Store.
- `GameplayFeedConfig`: Subscription/Filter pro Gameserver, Feed-Typ und Discord-Channel.
- `GameplayFeedDelivery`: persistente Zustellung pro `GameplayFeedConfig + AdmEvent`.
- Delivery-Status: `PENDING`, `SENDING`, `SENT`, `SKIPPED`, `RETRY`, `FAILED`.
- `SKIPPED` bedeutet bewusst durch einen nachtraeglich geaenderten Kategorie-Filter verworfen und wird nie als Discord-Post ausgegeben.
- Ein Lease verhindert parallele Doppelzustellung und macht abgestuerzte `SENDING`-Jobs wieder retrybar.
- Exponentieller Retry behandelt temporaere Discord-Fehler.
- Jede ADM-Zustellung verwendet einen stabilen Discord-Nonce. Wird das Crash-Fenster `Discord-Send erfolgreich, DB-Commit danach fehlgeschlagen` erneut ausgefuehrt, verhindert Discord mit `enforce_nonce` einen zweiten sichtbaren Post.
- Der Scan nutzt einen persistenten High-Watermark (`cursorCreatedAt + cursorEventId`) statt immer die aeltesten 200 Events zu lesen. Dadurch bleiben neue Ereignisse auch bei grossem Backlog erreichbar.
- Kategorie-Filter werden vor dem Enqueue und erneut vor dem Send angewendet.

Bestehende `KillfeedConfig`-Datensaetze werden bei der Migration als `DEATH`-Feeds uebernommen. Historische `DEATH`-Kategorie entspricht dabei `PVP`. Alte erfolgreiche Deliveries werden als `SENT` uebernommen; alte Claims ohne `messageId` werden als `RETRY` behandelt, weil sie keinen erfolgreichen Discord-Post beweisen.

## Runtime-Gate

Die produktive Gameplay-Feed-Runtime wird immer zusammen mit der Nitrado-Runtime gestartet. Es gibt kein zusaetzliches globales `ADM_EVENT_PIPELINE_V2`-Environment-Gate mehr.

Das eigentliche Opt-in bleibt strikt servergescoppt: Nur eine vorhandene `GameplayFeedConfig` mit `isActive=true`, passender Kategorie und gueltigem Discord-Channel erzeugt eine Nachricht. Damit kann eine bewusst konfigurierte Feed-Subscription nicht mehr durch einen versteckten globalen Schalter stillgelegt werden, waehrend Server ohne aktive Feed-Config weiterhin nichts posten.

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

Feed-Channels benoetigen nur `ViewChannel`, `SendMessages` und `EmbedLinks`. `ReadMessageHistory` ist fuer den Gameplay-Feed nicht mehr erforderlich, weil die Retry-Deduplizierung ueber den stabilen Discord-Nonce erfolgt.

## Produktionspruefung

Nach Merge und Migration:

1. Produktions-Preflight/Backup und `prisma migrate deploy` + `prisma migrate status`.
2. Bot starten und Health/Login/DB/Migration pruefen.
3. Im DEV-ADM-Status bestaetigen, dass pro aktivem Slot eine Quelle und ein Byte-Cursor erkannt werden; Pfad und Zeitzone bei Bedarf ueber `adm-source` korrigieren.
4. Pruefen, dass fuer den Zielserver eine aktive `GameplayFeedConfig` mit dem gewuenschten Discord-Channel vorhanden ist.
5. Linking-Challenge und PlayerSession/Reward-Postprocessing auf einem Testslot pruefen.
6. DayZ-Servereinstellungen fuer Death-/Baufeed pruefen: die benoetigten Admin-Logs muessen serverseitig aktiviert sein.
7. Auf dem verbundenen Server **nach** aktivierter Feed-Konfiguration einen neuen PvP-Kill, Suizid, NPC-/Tier-Tod, Fahrzeugtod sowie Placement/Build/Dismantle/Destroy erzeugen. Einen generischen `PLAYER_DIED` zusaetzlich als Rohdaten-Kontrolle pruefen; dafuer darf kein eigener Discord-Post entstehen.
8. Fuer ein neues Live-Ereignis bis zu etwa 45 Sekunden einplanen: ADM-Poll maximal 30 Sekunden plus Gameplay-Feed-Poll maximal 15 Sekunden.
9. Nitrado-Dateiwechsel/Serverrestart, Botrestart und Discord-Fehler/Retry testen.
10. Bestaetigen: kein generischer `PLAYER_DIED`-Discord-Post, keine verlorenen oder doppelten Posts, kein Cross-Server-Leak, saubere Embed-Darstellung und korrekte Kartenlinks.

Die Regression `tests/modules/gameplayFeedDeliveryE2E.test.ts` beweist zusaetzlich die produktive Kernkette von einer rohen DayZ-ADM-PvP-Zeile ueber Persistenz und Kategorie-Ableitung bis zum Discord-Embed, den RETRY-Pfad sowie die Nicht-Zustellung generischer `PLAYER_DIED`-Rohereignisse. `tests/modules/gameplayFeedTypes.test.ts` prueft diese Kategoriegrenze explizit. `tests/modules/gameplayFeedEmbed.test.ts` prueft zusaetzlich die saubere Namensdarstellung, Alias-only-Serveranzeige, die unterschiedliche Zeitdarstellung fuer Death- und Nicht-Kill-Feeds sowie die iZurvive-Positionslinks.
