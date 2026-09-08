-- First-class PvP Killfeed, separated from non-PvP Deathfeed.
-- PostgreSQL enum values must commit before a following migration can use
-- the new value in DML, so this change intentionally lives alone.
ALTER TYPE "GameplayFeedKind" ADD VALUE IF NOT EXISTS 'KILL';
