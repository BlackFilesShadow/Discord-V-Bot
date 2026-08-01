-- CreateTable
CREATE TABLE "NitradoAdmCursor" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "nitradoConnId" TEXT NOT NULL,
    "lastModifiedAt" INTEGER NOT NULL,
    "lastFileName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NitradoAdmCursor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NitradoAdmCursor_guildId_nitradoConnId_key" ON "NitradoAdmCursor"("guildId", "nitradoConnId");

-- CreateIndex
CREATE INDEX "NitradoAdmCursor_guildId_idx" ON "NitradoAdmCursor"("guildId");

-- CreateIndex
CREATE INDEX "NitradoAdmCursor_nitradoConnId_idx" ON "NitradoAdmCursor"("nitradoConnId");
