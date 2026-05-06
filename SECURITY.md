# Security Policy — V-Bot Prime

> Stand: 2026 · Production-Hardened. Diese Datei beschreibt das Sicherheitsmodell,
> aktive Schutzmaßnahmen und den Meldeweg für Schwachstellen.

---

## Sicherheitsmodell auf einen Blick

| Schicht                | Maßnahme                                                                 |
|------------------------|--------------------------------------------------------------------------|
| Discord-Eingaben       | Slash-Command-Permissions, Per-Guild Owner-Check, Rate-Limits            |
| Bot-Kommandos          | RBAC pro Command (`requirePermission`), Action-Audit-Trail               |
| Embeds (User-Content)  | Markdown-Escaping + Längen-Trunkierung (`src/utils/embedSanitize.ts`)    |
| Datenbank              | Prisma + scoped queries, Migrationen reviewt, kein dynamisches SQL       |
| Web-Dashboard          | Discord OAuth2 + Session (Postgres-Store), CSRF, Helmet, CSP, HSTS       |
| Developer-Bereich      | Defense-in-depth: Auth → MFA (TOTP) → IP-Allowlist → Audit-Log           |
| Webhooks               | HMAC-SHA256 (Constant-Time-Vergleich), Replay-Schutz via Timestamp       |
| Transport              | HTTPS via Caddy/nginx, HSTS preload-fähig, secure-Cookies                |
| Logging                | Sensitive-Field-Redactor, kein Klartext für Tokens/Secrets/PII           |
| Backup                 | Tägliches DB-Backup, Verifizierung via `deploy/backup-verify.sh`         |
| Container              | Non-root User, Read-only-FS dort wo möglich, Healthchecks                |

---

## Aktive Schutzmaßnahmen (Kurzreferenz)

### OWASP Top 10 Coverage
- **A01 Broken Access Control** — RBAC pro Command, Dashboard-Routes guarded, Dev-Bereich 3-Gates
- **A02 Cryptographic Failures** — bcrypt für Passwörter, AES-GCM für 2FA-Secrets, HTTPS forced
- **A03 Injection** — Prisma-ORM (kein Raw-SQL ohne Review), Embed-Sanitization, ESLint-Regel `no-unscoped-prisma-query`
- **A04 Insecure Design** — Threat-Modell pro Modul, Audit-Trail, Role-Permission-Grants
- **A05 Security Misconfiguration** — Helmet+CSP, Permissions-Policy, kein verbose error in Prod
- **A06 Vulnerable Components** — `npm audit` in CI, Dependabot/Renovate
- **A07 Identification & Auth Failures** — OAuth2, Session-Timeout, Brute-Force-Limiter, MFA für Dev
- **A08 Software & Data Integrity** — Lock-Files committet, Webhook-HMAC, Backup-Verify
- **A09 Logging & Monitoring** — strukturiertes Logging, SecurityEvent-Tabelle, Metrics-Endpunkt (Bearer)
- **A10 SSRF** — keine User-controlled URLs in Server-Side-Fetches; AI-Provider sind allowlisted

### Defense-in-depth: Developer-Dashboard
1. **Gate 1** — Discord-OAuth-Session
2. **Gate 2** — Rolle = `DEVELOPER` (DB)
3. **Gate 3** — Aktive Dev-Session (separate Tabelle, Lifetime-limitiert)
4. **Gate 4 (optional, prod-default ON)** — TOTP-MFA (`twoFactorAuth.isEnabled`)
5. **Gate 5 (optional)** — IP-Allowlist (`ipList`)
6. Jeder erfolgreiche/fehlgeschlagene Zugriff → `securityEvent`-Tabelle.

### Embed-Sanitization
Alle User-eingegebenen Inhalte, die in Discord-Embeds landen (Reasons, Notes,
externe Feeds wie Killfeed-Weapon-Names), werden über
[`safeEmbedField`](src/utils/embedSanitize.ts) geleitet:
- Markdown-Zeichen werden via `escapeMarkdown` neutralisiert
- Längen werden auf Discord-API-Limits trunkiert (256 / 1024 / 4096 / 2048)
- `null`/leer wird zu Zero-Width-Space (Discord-API-konform)
- `@everyone`/`@here` strippbar via `stripMassMentions`

---

## Schwachstellen melden

**Bitte KEINE öffentlichen Issues für Sicherheitslücken.**

E-Mail an: `security@<deine-domain>` (PGP optional).

Wir antworten innerhalb von **72 Stunden** mit:
- Bestätigung des Empfangs
- Erste Bewertung (Schweregrad nach CVSS-3.1)
- Zeitplan für Fix + Disclosure

**Coordinated Disclosure**: 90 Tage Standard-Embargo (verkürzbar bei aktiver Ausnutzung).

### Scope
**In-Scope:** Bot-Code (`src/`), Dashboard, Deploy-Skripte, DB-Schema.
**Out-of-Scope:** Discord-Plattform-Bugs, Drittanbieter-AI-APIs, DoS via Discord-Rate-Limits.

---

## Kontakt & Verantwortliche
- Lead Security: Repo-Owner (siehe GitHub)
- Eskalation: Discord-DM an Owner-Account

