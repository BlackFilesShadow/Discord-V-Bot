# 🤖 V-Bot Prime

**V-Bot Prime** ist ein Discord-, Community- und DayZ/Nitrado-Bot mit Web-Dashboard. Entwickelt wird er von **Void_Architect**.

Die aktuelle Architektur trennt bewusst zwischen normalen Discord-/Gameserver-Funktionen und privilegierter globaler Administration.

## Aktueller Funktionsumfang

### 🤖 KI & Wissen
- Multi-Provider-AI mit Groq, Cerebras, OpenRouter, Gemini und OpenAI.
- Live-Recherche für geeignete aktuelle Faktfragen.
- Server-/Nutzerkontext, Conversation-Memory, RAG/Wissensbank und Server-Persona.
- Schutz sensibler Admin-/Mod-/Log-Kontexte vor ungeeigneter AI-Verwendung.

### 🎮 DayZ & Nitrado
- Mehrere Nitrado-Gameserver pro Discord-Guild mit getrenntem `guildId + nitradoConnId`-Scope.
- Whitelist, Permissions, Spielidentitäts-Linking und Server-Banns.
- Zeitlich begrenzte Server-Banns werden über die Ban-Ablauf-Runtime remote entfernt; die Ablaufmeldung wird erst nach bestätigtem Remote-Unban veröffentlicht.
- ADM-V2-Live-Ingest und Postprocessing als kanonische Grundlage für Sessions, Rewards und Gameplay-/Feed-Verarbeitung.
- Deathfeed-/Baufeed-Konfiguration und ADM-Diagnose im Dashboard.

### 💰 Economy & Community
- Economy/Bank, Transfers, Casino und Fraktionen mit Gameserver-Scope.
- XP/Level, Levelrollen, Giveaways und Polls.
- Moderation, Tickets, Appeals, Feedback, Selfroles, Welcome und Übersetzungen.

### 📦 Hersteller & Dateien
- Hersteller-Antrag und Verifizierung.
- `/upload` und `/mypackages` bleiben bewusst Discord-Slash-Funktionen.
- `/upload` akzeptiert bis zu 10 XML/JSON-Dateien pro Aufruf.
- Das Dateilimit ist serverseitig über `MAX_FILE_SIZE_BYTES` konfigurierbar; der Standard liegt bei **25 MiB pro Datei**.
- Validierung, Integritätsprüfung, Quarantäne, Soft-Delete und Audit-Logging.

## 🌐 Dashboard statt privilegierter Slash-Commands

Globale Bot-Admin- und DEV-Werkzeuge werden nicht mehr als normale Discord-Slash-Commands betrieben.

- **Bot-Admin:** Support-/Betriebsverwaltung, Pakete, Nutzer, Tickets, Feedback, AI-Provider, AI-Trigger, Audit und weitere globale Verwaltungsfunktionen.
- **DEV:** Diagnostik, Datenbank, Security, Live-Konfiguration, XP-Konfiguration, sichere Exporte, Command-Registry und technische/forensische Werkzeuge.
- Sensible DEV-Mutationen und Exporte verlangen zusätzlich eine echte serverseitige Re-Authentisierung: TOTP bei aktiver 2FA, sonst erneute Prüfung von `DEV_PASSWORD`.
- Hersteller-Funktionen sind die ausdrückliche Discord-Ausnahme; `/dev-manufacturer` bleibt als Hersteller-DEV-Funktion erhalten.

## 🛡️ Sicherheit & Betrieb

- Discord OAuth2, PKCE/State, Sessions und Rate-Limits.
- AES-256-GCM für sensible gespeicherte Secrets.
- Audit- und Security-Events für privilegierte Aktionen.
- Nitrado-Remoteänderungen über servergescoppte Jobs/Outbox-Pfade.
- Optionale Prometheus-Metriken nur bei expliziter Aktivierung und gültigem Bearer-Token.
- Prisma-Migrationen, Jest, TypeScript/Lint, Security Audit, Playwright und Docker-Prüfungen in CI.

## Commands

`/help` wird aus der **tatsächlich geladenen Discord-Command-Registry** erzeugt und ist die Laufzeit-Wahrheitsquelle für verfügbare Slash-Commands. Bot-Admin- und DEV-Funktionen werden dort bewusst nicht als Discord-Commands dargestellt.

Weitere technische Details stehen in `README.md`, `docs/ARCHITECTURE.md` und `SECURITY.md`.
