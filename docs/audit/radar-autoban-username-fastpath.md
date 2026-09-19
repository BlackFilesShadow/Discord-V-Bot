# Radar Auto-Ban: Remote-Username + Fast-Path

## Scope

Dieser Fix trennt bei Radar-Auto-Bans die eindeutige interne DayZ-/BattlEye-GUID von der sichtbaren Nitrado-Banlisten-Identitaet und entfernt rein interne Poll-Wartezeiten.

## Unveraendert

- ADM-Parsing und Event-Kategorisierung
- Radar-Zonengeometrie und 10-m-Sicherheitsrand
- Allowlist-Pruefung
- Zonen-/Binding-/Generation-Fences
- Ban-HMAC auf der internen Subject-GUID
- Whitelist-Entfernung ueber die Subject-GUID
- Retry-, Lease-, Advisory-Lock- und Dedupe-Logik
- bestehende 30s/15s/15s/10s Scheduler als Fallback

## Neu

- Radar revalidiert neben GUID/Position/Hoehe auch den Spielernamen gegen die kanonische ADM-Evidenz.
- `ServerBanRemoteIdentity.identifierEnc` speichert die verschluesselte tatsaechliche Nitrado-Remote-Identitaet.
- `subjectIdentifierEnc` speichert nur dann zusaetzlich die interne GUID, wenn Remote- und Subject-Identitaet voneinander abweichen.
- Nitrado `settings.general.bans` bekommt bei Radar-Auto-Bans den revalidierten Spielernamen; die Whitelist- und Policy-Pfade bleiben GUID-basiert.
- ADM-Persistenz kickt den Radar-Worker, punitive Radar-Persistenz kickt den Auto-Ban-Worker und ein frisch eingereihter Auto-Ban kickt den Nitrado-Job-Worker. Alle bisherigen Timer bleiben Recovery-/Fallback-Pfade.

## Erwartete Latenz

Nach Verfuegbarkeit eines ADM-Ereignisses entfallen die kuenstlichen Wartefenster der nachgelagerten 15s-/15s-/10s-Poller weitgehend. Die vom DayZ-Server selbst bestimmte Frequenz von `PLAYER_POSITION` wird dadurch bewusst nicht veraendert.
