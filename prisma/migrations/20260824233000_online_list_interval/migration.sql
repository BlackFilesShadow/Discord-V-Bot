ALTER TABLE "GameplayFeedConfig"
  ADD COLUMN "playerListIntervalMinutes" INTEGER,
  ADD COLUMN "nextPlayerListPostAt" TIMESTAMP(3);
