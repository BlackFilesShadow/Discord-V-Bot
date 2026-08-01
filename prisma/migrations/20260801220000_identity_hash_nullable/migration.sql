-- identityHash bleibt bis zur In-Game-Verifikation leer (code-first Flow).
ALTER TABLE "GameIdentityLink" ALTER COLUMN "identityHash" DROP NOT NULL;
