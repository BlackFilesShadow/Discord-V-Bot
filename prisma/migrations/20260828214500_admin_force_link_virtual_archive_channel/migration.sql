-- Admin-Link/Virtual-Account completion 2026-08-28
-- Additive sidecar columns only. Existing rows remain valid and require no destructive backfill.

ALTER TABLE "EconomyVirtualAccountMetadata"
  ADD COLUMN IF NOT EXISTS "archiveChannelId" VARCHAR(20);

ALTER TABLE "EconomyVirtualAccountMetadata"
  ADD CONSTRAINT "EconomyVirtualAccountMetadata_archive_channel_snowflake"
  CHECK ("archiveChannelId" IS NULL OR "archiveChannelId" ~ '^[0-9]{17,20}$');

ALTER TABLE "EconomyVirtualAccountMetadata"
  ADD CONSTRAINT "EconomyVirtualAccountMetadata_channels_distinct"
  CHECK ("channelId" IS NULL OR "archiveChannelId" IS NULL OR "channelId" <> "archiveChannelId");

CREATE INDEX "EconomyVirtualAccountMetadata_archive_channel_idx"
  ON "EconomyVirtualAccountMetadata"("guildId", "archiveChannelId");

-- Force-Link darf einen Admin-Link bereits vor dem ersten ADM-/Session-Treffer
-- registrieren. Die echte GUID bleibt weiterhin unbekannt/NULL und wird niemals
-- durch den Spielernamen ersetzt. forcedPlayerName ist nur die sichere Bruecke
-- zur spaeteren eindeutigen GUID-Aufloesung.
ALTER TABLE "GameIdentityLink"
  ADD COLUMN IF NOT EXISTS "forcedPlayerName" VARCHAR(64);

ALTER TABLE "GameIdentityLink"
  ADD CONSTRAINT "GameIdentityLink_forced_player_name_printable"
  CHECK (
    "forcedPlayerName" IS NULL
    OR (
      char_length(btrim("forcedPlayerName")) BETWEEN 1 AND 64
      AND "forcedPlayerName" !~ E'[\\r\\n\\t]'
    )
  );

-- Pro Gameserver darf ein aktiv force-verknuepfter exakter Spielername nur
-- einem Discord-Account gehoeren. Derselbe Spieler darf auf anderen Servern
-- weiterhin separat gescoppt verknuepft werden.
CREATE UNIQUE INDEX "GameIdentityLink_scope_forced_player_name_verified_key"
  ON "GameIdentityLink"("guildId", "nitradoConnId", "forcedPlayerName")
  WHERE "status"='VERIFIED' AND "forcedPlayerName" IS NOT NULL;
