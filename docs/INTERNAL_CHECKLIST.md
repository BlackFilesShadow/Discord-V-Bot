# V-Bot — Interne Abschluss- und Verifikationscheckliste

> Stand: August 2026. Diese Datei ist keine historische Wunschliste mehr, sondern die aktuelle technische Prüfliste für Änderungen an V-Bot.

## 1. Command-Architektur

- [x] Globale Bot-Admin-Funktionen sind im Bot-Admin-Dashboard integriert.
- [x] Globale DEV-Funktionen sind im DEV-Dashboard integriert.
- [x] Migrierte `adminOnly`-/`devOnly`-Slash-Implementierungen sind aus dem Discord-Loader entfernt.
- [x] `/ping` und `/status` als frühere DEV-Diagnostik sind nicht mehr als normale Discord-Slash-Commands registriert.
- [x] Hersteller-Funktionen bleiben bewusst in Discord.
- [x] `src/commands/developer/` enthält nur die Hersteller-Ausnahme `devManufacturer.ts`.
- [x] `src/commands/inventory.ts` dokumentiert `moved_to_dashboard` und Hersteller-Preserve-Regeln.
- [x] Regressionstest verhindert neue globale Admin-/DEV-Slash-Commands außerhalb der Hersteller-Ausnahme.
- [ ] Nach jeder Command-Änderung `/help`, Command-Diagnostics und Discord-Deployment-Scope gemeinsam prüfen.

## 2. Bot-Informationskonsistenz

- [x] Entwickleridentität wird kanonisch als `Void_Architect` ausgegeben.
- [x] `/help` wird aus der geladenen Command-Registry erzeugt.
- [x] AI-Command-Katalog enthält keine entfernten `/autorole`-/globalen Admin-/DEV-Slash-Funktionen.
- [x] AI-Upload-Information leitet das Größenlimit aus `config.upload.maxFileSizeBytes` ab.
- [x] `/stell-dich-vor` hängt nicht mehr von einer nicht vorhandenen `about.md` ab.
- [x] README/Security/Architecture beschreiben Dashboard-only Bot-Admin/DEV statt alter Slash-Listen.
- [ ] Bei neuen Commands oder Verschiebungen AI-Katalog und nutzersichtbare Info-Texte im selben PR aktualisieren.

## 3. Hersteller / Upload

- [x] Herstellerzugang ist DB-/Status-gebunden.
- [x] `/upload` und `/mypackages` bleiben Discord-Slash-Funktionen.
- [x] Uploads sind GUID-getrennt.
- [x] Maximal 10 Attachments pro `/upload`-Aufruf.
- [x] Standardlimit 25 MiB pro Datei (`MAX_FILE_SIZE_BYTES=26214400`), konfigurierbar.
- [x] Standard-Endungen `.xml,.json`.
- [x] Größen-/Dateityp-/Validierungsprüfungen vor finaler Freigabe.

## 4. DEV Security

- [x] `requireGlobalDeveloperIdentity` prüft kanonische Developer-ID und frische DB-Rolle.
- [x] `requireDev` verlangt eine aktive, nicht widerrufene `DevSession`.
- [x] MFA ist optional über `DEV_REQUIRE_MFA=true` erzwingbar.
- [x] IP-Allowlist ist optional über `DEV_REQUIRE_IP_ALLOWLIST=true` erzwingbar.
- [x] Sensible DEV-Mutationen besitzen zusätzlich echten kryptografischen Step-Up.
- [x] Aktive 2FA => TOTP; kein Passwort-Fallback bei falschem TOTP.
- [x] Ohne aktive 2FA => erneute timing-sichere Prüfung von `DEV_PASSWORD`.
- [x] Step-Up fail-closed bei fehlender serverseitiger Credential-Konfiguration.
- [x] Wiederholte Step-Up-Fehler => temporärer Lockout + Audit.
- [x] `reAuth` wird nicht in URLs/Auditdetails geschrieben.

## 5. DEV Exporte

- [x] Paket-, User-/GDPR- und Audit-Exporte sind POST-only hinter `requireDev` + verifiziertem Step-Up.
- [x] Alte GET-Exportpfade geben keine sensiblen Daten direkt aus.
- [x] Exportantworten sind `no-store, private`.
- [x] Audit-Export: Kategorie-Allowlist, 1–365 Tage, Hard-Cap 50.000 Zeilen.

## 6. Guild-/Gameserver-Scope

- [x] Nitrado-/Economy-/Casino-/Whitelist-/Ban-/ADM-Daten sind an `guildId + nitradoConnId` gebunden.
- [x] Mehrere Gameserver dürfen nicht über Slot-/Guild-Fallbacks vermischt werden.
- [x] Permission-Grants sind Guild-gebunden; nicht delegierbare Scopes bleiben Owner-only.
- [x] Economy-Scope-Migration ordnet nur eindeutige Legacy-Fälle automatisch zu und rät bei Mehrdeutigkeit nicht.

## 7. Nitrado Whitelist / Server-Bans

- [x] Whitelist-Remoteänderungen laufen über Nitrado-Job/Outbox.
- [x] `/wl-list` liest die echte Remote-Whitelist getrennt pro Server.
- [x] `/server-ban` entfernt den lokalen Whitelist-Desired-State und reiht Remote-Ban ein.
- [x] Zeitliche Server-Bans besitzen persistente Ablauf-Metadaten.
- [x] Ban-Ablauf-Runtime prüft regelmäßig und reiht Remote-Unban ein.
- [x] Ablauf-Embed wird erst nach bestätigter Remote-Entfernung gesendet.
- [x] Re-Ban/manueller Unban verhindern veraltete automatische Ablaufmeldungen.

## 8. ADM V2

- [x] Legacy `admSyncCron`, `admWatcher` und globaler Runtime-Fallback `NITRADO_ADM_DIR` sind entfernt.
- [x] ADM-V2-Live-Sync arbeitet per `NitradoConnection` + Profil + Cursor.
- [x] Kanonische `AdmEvent`s werden unabhängig von öffentlicher Feed-Ausgabe erfasst.
- [x] ADM-V2-Postprocess verarbeitet Sessions/Rewards/Link-Folgeprozesse.
- [ ] Produktiv pro aktivem Gameserver Quelle/Cursor/Rotation beobachten.
- [ ] Multi-Server- und Backlog-Smokechecks nach größeren ADM-Änderungen wiederholen.

## 9. AI / Selbstauskunft

- [x] Multi-Provider-Fallback: Groq, Cerebras, OpenRouter, Gemini, OpenAI.
- [x] Reihenfolge kann aus Provider-Statistiken adaptiv bestimmt werden.
- [x] Outbound-Redaction vor externen Provider-Aufrufen.
- [x] DayZ-Technik besitzt verifiziertes Grounding + Ausgabeprüfung.
- [x] Public AI-Command-Hilfe darf keine Bot-Admin-/DEV-Dashboard-Aktionen als Slash-Commands erfinden.
- [x] `/help` bleibt die Live-Wahrheitsquelle für tatsächlich geladene Discord-Commands.

## 10. Metrics / Logging

- [x] Metrics sind nur aktiv, wenn explizit aktiviert und ein ausreichend langer Token vorhanden ist.
- [x] Deploy kann bei aktivierten Metrics einen fehlenden Token erzeugen, ohne ihn auszugeben.
- [x] Custom RingTransport wird über modernen Writable-Bridge an Winston angebunden.
- [ ] Produktiv Logs auf neue Warnungen/Fehler prüfen.

## 11. Migration / Deployment

- [x] Produktive Schemaänderungen sind versionierte Prisma-Migrationen.
- [x] Deploy verwendet `prisma migrate deploy` + `prisma migrate status`.
- [x] Kein automatischer produktiver `db push` als Reparaturpfad.
- [x] Health/Discord/Post-Start-Checks sind Teil des Deploy-Flows.
- [ ] Vor produktiver Freigabe immer Backup/Preflight und finalen `main`-CI prüfen.

## 12. Vierfach-Prüfung für größere Refactors

Jeder größere Architektur-/Security-Refactor gilt erst als abgeschlossen, wenn alle vier Ebenen erfüllt sind:

1. **Inventar-/Referenzprüfung** — keine verwaisten Loader-, Import-, Command- oder Legacy-Referenzen.
2. **Funktion-/Security-Parität** — Rechte, Scope, Step-Up, Audit und Fehlerpfade gegen den alten Funktionsumfang geprüft.
3. **Automatisierte CI** — Prisma, Jest, Lint, TypeScript/Frontend-Build, Security/SBOM grün.
4. **E2E/Runtime-Plausibilität** — Playwright grün plus gezielte Live-/Smokechecks für Remote-Funktionen.

## 13. Noch bewusst produktiv zu prüfen

- [ ] 1-Minuten-Server-Ban: echte Nitrado-Banliste entfernen + genau ein Ablauf-Embed im Ursprungskanal.
- [ ] Whitelist/Ban Multi-Server-Smokecheck.
- [ ] Economy-Scope für mögliche mehrdeutige Legacy-Konfigurationen bestätigen.
- [ ] ADM-V2 je produktivem Gameserver: Quelle, Cursor, Rotation, Events, Postprocess.
- [ ] Death-/Build-Feed kontrolliert aktivieren und Ereignisklassen prüfen.
- [ ] Retry/Restart/Dedupe/Backlog-Stresstest für Gameplay-Delivery.

Historische PR-/Phasenlisten gehören in historische Rollout-/Cleanup-Dokumente, nicht in diese aktuelle Checkliste.
