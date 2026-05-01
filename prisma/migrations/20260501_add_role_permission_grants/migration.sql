-- CreateTable
CREATE TABLE "GuildPermissionRoleGrant" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "roleDiscordId" TEXT NOT NULL,
    "permissions" JSONB NOT NULL,
    "grantedByDiscordId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuildPermissionRoleGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GuildPermissionRoleGrant_guildId_roleDiscordId_key" ON "GuildPermissionRoleGrant"("guildId", "roleDiscordId");

-- CreateIndex
CREATE INDEX "GuildPermissionRoleGrant_guildId_idx" ON "GuildPermissionRoleGrant"("guildId");
