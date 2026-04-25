# V-Bot Prime

> **Der adaptive All-in-One Discord-Bot für Communities, die mehr wollen als „nur einen Bot“.**
> Server-Awareness, KI-Konversation in Deutsch, Multi-Sprach-Posts, Auto-Moderation, XP-System, Hersteller-Uploads bis 2 GB — auf einem dedizierten Server, DSGVO-konform, mit eigener Persona.

---

## Warum V-Bot Prime?

Die meisten Discord-Bots sind Werkzeuge. **V-Bot Prime ist ein Operator.**

Er kennt deinen Server, deine Mitglieder, deine Kanäle, deine Rollen — und antwortet so, als wäre er Teil deines Teams. Gelassen, präzise, mit subtilem Charakter. Kein generischer Chatbot-Ton, kein Werbe-Sprech, keine Romane.

**Drei Prinzipien:**
1. **Server-aware** — Der Bot weiß *wo* er spricht und *mit wem*. Antworten sind kontextuell, nicht generisch.
2. **Sicher by Design** — GUID-getrennte Bereiche, sensible Kanäle/Rollen werden automatisch aus dem AI-Kontext gefiltert, Multi-Provider-Fallback, Audit-Log.
3. **Adaptiv** — Antwortlänge passt sich der Frage an: Smalltalk → 1 Satz. Tutorial → mehrere Absätze.

---

## Hauptfunktionen im Überblick

### 🤖 KI-Konversation (Multi-Provider)
- **5 Provider** im Hot-Failover: Cerebras → OpenRouter → Groq → Gemini → OpenAI
- **Live-Web-Recherche** bei Faktfragen — kein veraltetes Trainingswissen bei Politik, Sport, Releases
- **Konversations-Gedächtnis** pro Channel + User (24 h) — Pronomen-Auflösung, „wie eben besprochen"
- **Adaptive Antwortlänge**: kurz / mittel / lang — automatisch passend zur Frage
- **Anti-Wiederholung**: keine wortgleichen Antworten bei Folgefragen
- **Eigene Persona pro Server** überschreibbar (Owner-Override)
- **RAG**: pgvector-basierte semantische Suche in kuratierten Server-Fakten

### 🌍 Multi-Sprach-Translate-Posts
- **10 Sprachen** automatisch übersetzen und posten (DE, EN, FR, ES, IT, NL, PL, PT, RU, TR)
- **Sofort posten**, **terminieren** (Datum + Uhrzeit) oder **wiederkehrend** (stündlich/täglich/wöchentlich/monatlich)
- DST-korrekt (Europe/Berlin), runde Edge-Cases (29.02., DST-Wechsel) sauber behandelt
- Pflicht-Titel, eigener Embed-Stil mit Server-Branding, Rollen-Pings
- Bis zu 4000 Zeichen Originaltext

### 📦 Hersteller-Upload-System
- **Bis zu 2 GB pro Datei**, beliebig viele Dateien pro Paket
- **GUID-getrennte Bereiche** — keine Namenskollisionen, keine Querzugriffe
- **Validierung** für XML, JSON inkl. Schema-Check, Strukturanalyse, Vorschläge
- **Virenscanner-Integration** mit Quarantäne
- **Soft-Delete + Restore**, Audit-Log, Rate-Limiting
- **Multi-File-Upload** in einem Slash-Command, alles landet im selben Paket
- **Klare Fehlermeldung** bei doppelten Paketnamen — keine versehentlichen Vermischungen

### 🛡️ Auto-Moderation & Sicherheit
- Anti-Spam, Anti-Raid, Toxicity-Detection
- Auto-Mod mit Eskalationsstufen, Case-Management, Appeal-System
- **Sensible Kanäle/Rollen** (Admin/Mod/Log/Audit/Ticket) werden aus AI-Kontext **automatisch gefiltert** — keine Leaks
- **Pen-Test-Suite** (im Repo enthalten): SQL-Injection, XSS, Path-Traversal-Tests
- Rate-Limiter pro User + global
- DSGVO-konforme Datenverarbeitung, Audit-Logging, Export-Funktion

### 📈 XP- & Level-System
- Pro Guild getrennt, mit Anti-Cheat (Cooldowns, Channel-Filter)
- Level-Up-Belohnungen (Rollen automatisch vergeben)
- Konfigurierbare Level-Up-Nachrichten pro Server
- Bestenlisten mit Pagination

### 🎉 Community-Features
- **Giveaways** mit Auto-Reroll, Anti-Cheat
- **Polls** mit Multi-Choice, Live-Updates
- **Welcome-System** mit AI-generierten Begrüßungen
- **Ticket-System** (kommend)
- **Auto-Roles** für Self-Assignment
- **Reaction-Roles**

### 🌐 Web-Dashboard
- Express-basiertes Backend
- API für Stats, Konfig, Audit-Log
- Auth-Layer mit Session-Management

---

## Was V-Bot Prime besonders macht

### Echte Server-Awareness, kein Copy-Paste-Bot
Standard-Bots beantworten „Wer ist der Owner?" mit „Frag deinen Admin". V-Bot Prime weiß es. Er kennt:
- Servername, Owner, Erstellungsdatum, Boost-Level, Verifizierungs-Stufe
- Channel-Struktur (Text/Voice/Stage/Forum/News, gruppiert nach Kategorie)
- Top-Rollen, Mitgliederzahl, Vanity-URL, AFK-Setup
- Dein Profil: Nickname, Beitrittsdatum, Top-Rollen, Level/XP, Aktivität

**Strikt getrennt:** Server-Daten nur bei Server-Fragen, eigene Profildaten nur bei „mein/ich"-Fragen, Wissensfragen ohne Vermischung.

### Sensible Kanäle? Niemals geleakt.
Zwei Schutzmechanismen kombinieren sich:
- **Permission-Check**: Wenn `@everyone` keinen `View`-Zugriff hat → raus aus AI-Kontext
- **Name-Heuristik**: `admin`, `mod`, `staff`, `intern`, `log`, `audit`, `ticket`, `dev`, `security`, `backup` und 20+ weitere Pattern werden gefiltert
- Ganze Kategorien werden mitgefiltert
- Auch managed Bot-Rollen werden aus Top-Rollen entfernt

Wenn jemand fragt „Welche Admin-Channels gibt es?" → höfliche Verweigerung statt Leak.

### Adaptive Persona
- **Kurz** (1–2 Sätze): Smalltalk, Status, einfache Faktfragen
- **Mittel** (3–8 Sätze): Erklärungen, How-To, Vergleiche
- **Lang** (mehrere Absätze): Tutorials, technische Tiefe, explizit angefragte Details
- Vorgaben wie „in einem Satz" oder „ausführlich" werden strikt befolgt
- Keine Romane, keine künstliche Kürzung

### Multi-Provider AI mit Cooldown-Schutz
- Bei 429 (Rate-Limit) eines Providers → automatischer Failover zum nächsten
- Cooldown wächst exponentiell: 30 s → 60 s → 120 s → max. 300 s
- Provider-Health wird persistent getrackt, Reihenfolge passt sich an Erfolgsrate an
- Statistik via `/admin-aimodels` einsehbar

### DSGVO & Sicherheit
- Datenverarbeitung in der EU (Hetzner DE)
- Privacy-by-Design: nur das Nötigste wird gespeichert
- Conversation-Memory: 24 h TTL, automatischer Cleanup
- Vollständiges Audit-Log aller administrativen Aktionen
- Export-Funktion für eigene Daten (DSGVO-Auskunft)
- Penetration-Test-Suite im Repo (`tests/security/penetration.test.ts`)

---

## Tech-Stack

| Bereich | Stack |
|---|---|
| Sprache | TypeScript (strict) |
| Discord-API | discord.js v14 |
| Datenbank | PostgreSQL + Prisma ORM |
| Vektor-Suche | pgvector |
| AI-Provider | Cerebras, OpenRouter, Groq, Gemini, OpenAI |
| Web-Backend | Express |
| Tests | Jest (Unit + Integration + Pen-Test) |
| Hosting | Docker auf dedicated Hetzner-Server |
| CI/CD | Git → SSH-Deploy mit Health-Check |

---

## Slash-Commands (Auswahl)

### Für alle Mitglieder
- `/ai ask` — Frage an die KI mit allen Kontext-Features
- `/leaderboard` — XP-Bestenliste
- `/level` — Eigenes Level abrufen
- `/poll create` — Umfragen mit Multi-Choice
- `/giveaway create` — Gewinnspiele aufsetzen
- `/autorole add` — Self-Assignment-Rollen
- `/register manufacturer` — Hersteller-Antrag stellen

### Für Hersteller
- `/upload` — Multi-File-Upload in eigenes Paket
- `/list` — Eigene Pakete anzeigen
- `/delete` — Paket löschen (Soft-Delete + Restore)

### Für Admins
- `/translate-post now|schedule|stuendlich|taeglich|woechentlich|monatlich` — Auto-Übersetzungs-Posts
- `/feed` — RSS/Webhook-Feeds einrichten
- `/welcome` — Begrüßungs-System konfigurieren
- `/xp-config` — XP-System pro Server anpassen
- `/admin-stats` — Server-Statistiken
- `/admin-audit` — Audit-Log einsehen

> Developer- und interne Admin-Commands werden gegenüber Nutzern nie erwähnt — auch nicht von der KI.

---

## Vermarktungs-Argumente (Pitch-Material)

**Für Server-Owner:**
> „Ein Bot, der deinen Server wirklich kennt, deine Community-Kanäle nie verwechselt mit Mod-Channels, und in 10 Sprachen automatisch posten kann. DSGVO-konform, Hosting in Deutschland."

**Für Manufacturer-Communities (Modding, Asset-Sharing):**
> „2 GB pro Datei, beliebig viele Dateien pro Paket, GUID-isolierte Hersteller-Bereiche mit Validierung und Virenscanner. Schluss mit fragmentierten Drive-Links."

**Für internationale Communities:**
> „Schreib einmal auf Deutsch — V-Bot postet zeitversetzt in 10 Sprachen. Stündlich, täglich, wöchentlich, monatlich. DST-korrekt."

**Für Tech-affine Server:**
> „Multi-Provider AI mit automatischem Failover, RAG-basierte Wissensbasis, eigene Persona pro Server. Open für Custom-Module."

**Für Community-Manager:**
> „XP-System, Giveaways, Polls, Welcome, Auto-Mod, Audit-Log — in einem Bot. Kein Bot-Soup mehr."

---

## Hosting & Verfügbarkeit

- **Dedizierter Server in Deutschland** (Hetzner)
- **Docker-Setup**, 24/7 Monitoring, Auto-Restart
- **Backup-Strategie**: tägliche DB-Snapshots, Filesystem-Snapshots
- **SLA-Bereitschaft**: > 99,5 % Uptime im laufenden Betrieb
- **Sharding-Ready** für große Server-Verbünde

---

## Einrichtung in 3 Schritten

1. **Bot einladen** über den Invite-Link (mit minimalen Berechtigungen)
2. **Server-Profil syncen** — passiert automatisch beim Join, Re-Sync via `/admin-stats refresh`
3. **Persona/Brief setzen** (optional) — `/admin-config aibrief` und `/admin-config aipersona`

Fertig. Der Bot ist sofort einsatzbereit.

---

## Roadmap (Auszug)

- 🔄 Voice-Awareness (Sprach-Channel-Aktivität in AI-Kontext)
- 🔄 Ticket-System mit Auto-Routing
- 🔄 Owner-Dashboard mit Live-Charts
- 🔄 Webhook-API für externe Trigger
- 🔄 Marketplace für Community-Module

---

## Kontakt & Support

- **Discord-Server**: V-Bot Zentrale (Invite auf Anfrage)
- **Repository**: [github.com/BlackFilesShadow/Discord-V-Bot](https://github.com/BlackFilesShadow/Discord-V-Bot)
- **Maintainer**: VoidArchitect

---

## Lizenz & Nutzung

Privates Projekt. Kommerzielle Nutzung und Custom-Hosting auf Anfrage.
Self-Hosting möglich — Setup-Guide in [docs/INTERNAL_CHECKLIST.md](docs/INTERNAL_CHECKLIST.md).

---

> **V-Bot Prime — kein Werkzeug, ein Operator.**
