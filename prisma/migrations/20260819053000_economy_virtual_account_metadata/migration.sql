-- Economy-1J: optionale Dashboard-Metadaten fuer virtuelle Konten.
--
-- Bewusst als raw-SQL Sidecar: Die bestehende EconomyVirtualAccount-API und
-- Systemkonten (Lotterie/Markt) bleiben schema-/client-kompatibel. Dashboard-
-- CUSTOM-Konten erhalten Beschreibung + Discord-Zielchannel atomar ueber die
-- gemeinsame Account-Transaktion.

CREATE TABLE "EconomyVirtualAccountMetadata" (
    "accountId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "nitradoConnId" TEXT NOT NULL,
    "description" VARCHAR(280),
    "channelId" VARCHAR(20),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EconomyVirtualAccountMetadata_pkey" PRIMARY KEY ("accountId"),
    CONSTRAINT "EconomyVirtualAccountMetadata_channel_snowflake" CHECK (
      "channelId" IS NULL OR "channelId" ~ '^[0-9]{17,20}$'
    )
);

CREATE INDEX "EconomyVirtualAccountMetadata_scope_idx"
    ON "EconomyVirtualAccountMetadata"("guildId", "nitradoConnId");
CREATE INDEX "EconomyVirtualAccountMetadata_channel_idx"
    ON "EconomyVirtualAccountMetadata"("guildId", "channelId");

ALTER TABLE "EconomyVirtualAccountMetadata"
    ADD CONSTRAINT "EconomyVirtualAccountMetadata_account_scope_fkey"
    FOREIGN KEY ("accountId", "guildId", "nitradoConnId")
    REFERENCES "EconomyVirtualAccount"("id", "guildId", "nitradoConnId")
    ON DELETE CASCADE ON UPDATE CASCADE;
