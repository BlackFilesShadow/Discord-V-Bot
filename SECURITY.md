# Security Policy — V-Bot Prime

> Stand: August 2026. Dieses Dokument beschreibt den aktuellen Schutzpfad des Bots und des Web-Dashboards.

## Sicherheitsmodell auf einen Blick

| Schicht | Aktuelle Schutzmaßnahmen |
|---|---|
| Discord | Discord-Permissions, Guild-/Gameserver-Scope, Rate-Limits, Audit-Logging |
| Hersteller | `manufacturerOnly`, aktive DB-Freigabe, GUID-getrennter Bereich, Upload-Validierung |
| Guild-Dashboard | Discord OAuth2, serverseitige Session, Owner-/Permission-Scope |
| Bot-Admin | kanonische globale Bot-Admin-Identität + aktive `BotAdminSession` |
| DEV | kanonische Developer-Identität + aktuelle DB-Rolle + aktive `DevSession`; MFA/IP optional konfigurierbar |
| DEV-Step-Up | sensible Mutationen/Exporte: echte TOTP- oder `DEV_PASSWORD`-Re-Authentisierung, Audit + Lockout |
| Datenbank | Prisma, produktive Migrationen, Scope-Guards, reviewed Raw-SQL-Ausnahmen |
| Secrets | AES-256-GCM für gespeicherte Secrets; Tokens/Passwörter nicht in Antwort- oder Auditdaten |
| Web | Helmet/CSP/HSTS, Secure Cookies, OAuth State + PKCE, Idempotency für Mutationen |
| Monitoring | strukturierte Logs, `SecurityEvent`, optionaler Bearer-geschützter `/metrics`-Endpoint |

## Trennung von Discord und privilegierter Verwaltung

Globale Bot-Admin- und DEV-Verwaltung wurde aus Discord-Slash-Commands in das Web-Dashboard verschoben. Dadurch werden globale privilegierte Funktionen nicht mehr über den normalen Slash-Command-Dispatcher exponiert.

Hersteller-Funktionen sind die bewusste Ausnahme: `/upload`, `/mypackages` und die Herstellerverwaltung bleiben als Discord-Commands erhalten und haben eigene Berechtigungsprüfungen.

Serverbezogene Commands wie Whitelist, Nitrado-Server-Bans, Economy oder Permission-Grants sind keine globalen Bot-Admin-/DEV-Funktionen. Sie laufen über Guild-/Gameserver-Scope und die jeweils erforderliche delegierbare Permission bzw. Owner-Prüfung.

## DEV Defense-in-Depth

Der aktuelle DEV-Zugriff besteht aus getrennten Ebenen:

1. **OAuth-Identität** — gültige Dashboard-Session.
2. **Globale Developer-Identität** — kanonische Developer-ID plus frische DB-Rolle; alte Session-Rollen reichen nicht.
3. **DevSession** — separat erzeugte, zeitlich begrenzte und widerrufbare DEV-Session.
4. **Optionale MFA** — wird nur erzwungen, wenn `DEV_REQUIRE_MFA=true` gesetzt ist.
5. **Optionale IP-Allowlist** — wird nur erzwungen, wenn `DEV_REQUIRE_IP_ALLOWLIST=true` gesetzt ist.
6. **Verifizierter Step-Up für sensible Aktionen** — unabhängig davon, ob die optionalen globalen MFA/IP-Gates aktiv sind.

### Verifizierter Step-Up

Für sensible DEV-Mutationen und Exporte reicht ein ausgefülltes Feld nicht. Der Server prüft das Credential kryptografisch:

- Bei aktiver 2FA wird das verschlüsselt gespeicherte TOTP-Secret entschlüsselt und der eingegebene TOTP geprüft.
- Ohne aktive 2FA muss `DEV_PASSWORD` erneut eingegeben werden; der Vergleich erfolgt timing-sicher über gleich lange Hash-Digests.
- Ein aktives TOTP kann nicht durch das DEV-Passwort umgangen werden.
- Fehlt die benötigte serverseitige Credential-Konfiguration, wird fail-closed abgelehnt.
- Wiederholte falsche Step-Up-Versuche werden pro Developer/IP temporär gesperrt und auditiert.
- `reAuth` wird weder in Audit-Details noch in URLs geschrieben.

### Sichere DEV-Exporte

Paket-, GDPR- und Audit-Exporte sind sensible Daten:

- Exportdaten werden nur per **POST** hinter `requireDev` + verifiziertem Step-Up erzeugt.
- Legacy-GET-Pfade geben keine Daten mehr aus, sondern leiten auf die geschützte Re-Auth-Seite um.
- Antworten erhalten `Cache-Control: no-store, private`.
- Audit-Log-Exporte sind auf gültige Kategorien, 1–365 Tage und maximal 50.000 Datensätze begrenzt.

## Bot-Admin

Bot-Admin und DEV sind getrennte Sicherheitsdomänen. Bot-Admin besitzt eine eigene globale Identitätsprüfung und `BotAdminSession`. DEV-Aktionen dürfen nicht durch eine Bot-Admin-Session freigeschaltet werden und umgekehrt.

## Nitrado / Gameserver

- Mehrere Nitrado-Verbindungen werden strikt über `guildId + nitradoConnId` getrennt.
- Whitelist-, Ban-, Economy-, Faction- und ADM-Daten dürfen nicht zwischen Slots vermischt werden.
- Remote-Mutationen verwenden deduplizierte Job-/Outbox-Pfade.
- Zeitliche Server-Bans speichern den Klartext-Identifier nur verschlüsselt solange er für den automatischen Ablauf benötigt wird; persistente Ban-Wahrheit und Audit verwenden keine unnötigen Klartext-Identifier.
- ADM-V2 verarbeitet pro Gameserver eine eigene Quelle/Cursor-Kette; der alte globale `NITRADO_ADM_DIR`-Runtime-Pfad ist entfernt.

## OAuth2 und Sessions

- Discord OAuth2 mit `state` gegen CSRF und PKCE.
- Access-Tokens werden nicht dauerhaft als Klartext persistiert.
- Refresh-Tokens werden verschlüsselt gespeichert.
- Dashboard-Sessions liegen serverseitig in PostgreSQL.
- Privilegierte Rollen werden an kritischen Gates frisch aus der Datenbank gelesen, damit ein Rollenentzug nicht durch einen alten Sessionwert umgangen wird.

## Eingabe- und Ausgabehärtung

- Discord-Embeds verwenden zentrale Sanitization/Discord-Limits, wo User-/Remote-Inhalte ausgegeben werden.
- Dashboard-Command-Center besitzen zusätzliche Input-Guards.
- Uploads besitzen Größen-/Dateitypgrenzen und Validierung vor persistenter Freigabe.
- AI-Outbound-Daten werden vor Provider-Aufrufen redigiert; technische DayZ-Antworten besitzen zusätzlich Grounding-/Fail-Closed-Prüfungen.

## Monitoring und Secrets

`/metrics` ist standardmäßig nicht automatisch offen. Der Endpoint gilt nur als aktiviert, wenn Metrics angefordert wurden und ein ausreichend langer `METRICS_TOKEN` vorhanden ist. Bei aktivierten Metrics kann der Deploy-Flow einen fehlenden Token lokal erzeugen, ohne das Secret auszugeben.

Logs und Audits dürfen keine API-Keys, Passwörter, TOTP-Secrets oder Re-Auth-Credentials enthalten.

## CI / Supply Chain

Der CI-Pfad prüft unter anderem:

- Prisma Generate/Validate/Migration-Status,
- Jest,
- TypeScript und Frontend-Build,
- Lint,
- Security Audit / SBOM,
- Playwright-E2E.

Produktive Schemaänderungen laufen über versionierte Prisma-Migrationen, nicht über einen automatischen produktiven `db push`.

## Schwachstellen melden

Bitte keine sensiblen Exploit-Details in öffentliche Issues schreiben. Für dieses private Projekt erfolgt die Eskalation an den Repository-Verantwortlichen bzw. den Entwickler **Void_Architect** über den vereinbarten privaten Kanal.

### Scope

**In Scope:** `src/`, Dashboard, Deploy-Skripte, Datenbankschema, Nitrado-/ADM-Runtime.

**Out of Scope:** Fehler der Discord-Plattform und unabhängiger Drittanbieter-Dienste, sofern V-Bot deren Verhalten nicht selbst unsicher verarbeitet.
