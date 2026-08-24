ALTER TABLE "GameplayFeedConfig"
  ADD COLUMN "playerListIntervalMinutes" INTEGER,
  ADD COLUMN "nextPlayerListPostAt" TIMESTAMP(3);

-- Der generische PLAYER_DIED-Feed wird nicht mehr als Discord-Kategorie angeboten.
-- Rohdaten in AdmEvent bleiben unangetastet; nur die alte sichtbare Feed-Auswahl
-- wird aus bestehenden Deathfeed-Configs entfernt.
UPDATE "GameplayFeedConfig"
   SET "categories" = array_remove("categories", 'DEATH')
 WHERE "kind" = 'DEATH'::"GameplayFeedKind"
   AND 'DEATH' = ANY("categories");
