# Server-Gameplay-Feeds (Masterplan Phase 11)

## Ziel

Serverinterne Live-Feeds duerfen weder eine zweite Gameplay-Datenhaltung noch einen neuen, abweichenden Mandanten-Scope einfuehren. Die bereits normalisierten `AdmEvent`-Datensaetze bleiben die kanonische persistente Gameplay-Wahrheit pro `guildId + nitradoConnId`.

## Persistenz und Delivery

- `AdmEvent`: kanonischer normalisierter ServerGameplayEvent-Store.
- `KillfeedConfig`: bestehende Subscription/Filter-Konfiguration fuer Kill-Events eines konkreten Gameservers.
- `KillfeedDelivery`: idempotente persistente Delivery pro `KillfeedConfig + AdmEvent`.
- Es gibt absichtlich keine parallele `ServerGameplayEvent`-Tabelle, weil diese dieselben ADM-Ereignisse duplizieren und Drift erzeugen wuerde.

## Realtime-Transport

Socket.IO `/guild` besitzt zwei getrennte Room-Typen:

- `g:<guildId>` fuer guild-weite Konfigurations-/UI-Aenderungen.
- `gs:<guildId>:<nitradoConnId>` fuer Live-Gameplay eines exakt gebundenen Gameservers.

Ein `join.server` wird nur akzeptiert, wenn:

1. die Session authentifiziert und ggf. 2FA-verifiziert ist,
2. die Guild erreichbar ist,
3. Owner oder `killfeed.view`, `killfeed.manage` bzw. `dashboard.access` vorliegt,
4. die `NitradoConnection` exakt zu dieser Guild gehoert,
5. die Connection `ACTIVE` und an eine Nitrado-Service-ID gebunden ist,
6. der Slot innerhalb der produktiven Grenze 1..4 liegt.

Live-Ereignisse werden ausschliesslich als `server.gameplay.event` an den exakten `gs:`-Room gesendet. Es gibt keinen Fallback auf den Guild-Room.

## Killfeed V2

`deliverPendingKills()` claimt weiterhin zuerst `KillfeedDelivery`. Nur neu geclaimte Ereignisse werden an Discord gepostet und anschliessend best-effort in den servergescoppten Realtime-Feed gespiegelt. Ein Socket-Fehler darf die persistente Delivery niemals zurueckrollen oder einen Retry mit Doppelpost ausloesen.

Der produktive V2-Pfad bleibt bis zur kontrollierten Live-Freigabe durch `ADM_EVENT_PIPELINE_V2=false` standardmaessig deaktiviert. Bei deaktiviertem V2-Pfad laeuft der Legacy-Killfeed weiter; es werden niemals beide Killfeed-Pfade gleichzeitig gestartet.

## Produktionsfreigabe

Nach Merge und Migration erfolgt die Live-Freigabe getrennt vom Code-Deploy:

1. Read-only DB-/Log-/ADM-Check.
2. `ADM_EVENT_PIPELINE_V2` kontrolliert aktivieren.
3. Einen Server beobachten: Ingestion, `AdmEvent`, `KillfeedDelivery`, Discord-Post und `server.gameplay.event` muessen denselben Scope tragen.
4. Keine Doppelposts und keine Cross-Server-Events bestaetigen.
5. Erst danach weitere Server/Reward-Gates freigeben.
