-- Phase 14: Conversation Memory. Pro (userId, channelId) werden die letzten
-- Turns gespeichert. TTL wird applikationsseitig (24h) gepflegt.
CREATE TABLE IF NOT EXISTS "AiConversationTurn" (
  "id"        TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "channelId" TEXT NOT NULL,
  "guildId"   TEXT,
  "role"      TEXT NOT NULL,
  "content"   TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AiConversationTurn_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AiConversationTurn_userId_channelId_createdAt_idx"
  ON "AiConversationTurn"("userId", "channelId", "createdAt");

CREATE INDEX IF NOT EXISTS "AiConversationTurn_createdAt_idx"
  ON "AiConversationTurn"("createdAt");
