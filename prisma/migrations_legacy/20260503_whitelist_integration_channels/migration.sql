-- Whitelist Channel-Integration: Info-Embed-Tracking + Accept/Deny-Log-Kanaele
ALTER TABLE "ServerSettings"
  ADD COLUMN IF NOT EXISTS "whitelistInfoMessageId" TEXT,
  ADD COLUMN IF NOT EXISTS "whitelistApproveLogChannelId" TEXT,
  ADD COLUMN IF NOT EXISTS "whitelistDenyLogChannelId" TEXT;
