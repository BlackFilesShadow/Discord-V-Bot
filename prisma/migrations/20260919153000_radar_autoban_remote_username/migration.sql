-- Radar-Auto-Bans muessen zwei Identitaeten sauber trennen koennen:
-- 1) interne, eindeutige DayZ-/BattlEye-GUID fuer Evidenz, Allowlist und Policy;
-- 2) sichtbarer Spielername, der in Nitrados settings.general.bans geschrieben wird.
--
-- Bestehende Zeilen bleiben unveraendert kompatibel: NULL bedeutet, dass
-- identifierEnc gleichzeitig Subject- und Remote-Identifier ist.
ALTER TABLE "ServerBanRemoteIdentity"
  ADD COLUMN "subjectIdentifierEnc" TEXT;
