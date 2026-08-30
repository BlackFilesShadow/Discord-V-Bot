-- #293: PLACEMENT becomes a first-class gameplay-feed kind.
-- Keep enum addition in its own migration: PostgreSQL requires the transaction
-- that adds a new enum value to commit before that value is used by DML.
ALTER TYPE "GameplayFeedKind" ADD VALUE IF NOT EXISTS 'PLACEMENT';
