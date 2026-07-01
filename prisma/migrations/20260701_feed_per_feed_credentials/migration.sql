-- Pro-Feed API-Keys (verschluesselt, AES-256-GCM). YouTube-Key ODER Twitch-ID+Secret
-- als JSON im Ciphertext. NULL = globale ENV-Keys nutzen.
ALTER TABLE "Feed" ADD COLUMN IF NOT EXISTS "credentialsEnc" TEXT;
