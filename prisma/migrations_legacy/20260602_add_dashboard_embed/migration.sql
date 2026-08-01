-- Embed-Builder (Dashboard-only): eigenständige eingebettete Nachrichten.
-- Fuegt zudem fehlende Audit-Kategorien hinzu. EMBED/KILLFEED/WELCOME wurden
-- bisher still verworfen, da sie nicht im AuditCategory-Enum enthalten waren.

ALTER TYPE "AuditCategory" ADD VALUE IF NOT EXISTS 'EMBED';
ALTER TYPE "AuditCategory" ADD VALUE IF NOT EXISTS 'KILLFEED';
ALTER TYPE "AuditCategory" ADD VALUE IF NOT EXISTS 'WELCOME';

CREATE TABLE "DashboardEmbed" (
  "id"            TEXT PRIMARY KEY,
  "guildId"       TEXT NOT NULL,
  "name"          VARCHAR(120) NOT NULL,
  "channelId"     VARCHAR(32),
  "messageId"     TEXT,
  "content"       VARCHAR(2000),
  "title"         VARCHAR(256),
  "description"   TEXT,
  "url"           VARCHAR(512),
  "color"         VARCHAR(9),
  "authorName"    VARCHAR(256),
  "authorIconUrl" VARCHAR(512),
  "authorUrl"     VARCHAR(512),
  "footerText"    VARCHAR(2048),
  "footerIconUrl" VARCHAR(512),
  "thumbnailUrl"  VARCHAR(512),
  "imageUrl"      VARCHAR(512),
  "showTimestamp" BOOLEAN NOT NULL DEFAULT false,
  "fields"        JSONB,
  "isTemplate"    BOOLEAN NOT NULL DEFAULT false,
  "isDraft"       BOOLEAN NOT NULL DEFAULT false,
  "createdBy"     TEXT NOT NULL,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL
);

CREATE UNIQUE INDEX "DashboardEmbed_messageId_key" ON "DashboardEmbed"("messageId");
CREATE INDEX "DashboardEmbed_guildId_isTemplate_idx" ON "DashboardEmbed"("guildId", "isTemplate");
CREATE INDEX "DashboardEmbed_guildId_isDraft_idx" ON "DashboardEmbed"("guildId", "isDraft");
CREATE INDEX "DashboardEmbed_guildId_name_idx" ON "DashboardEmbed"("guildId", "name");
