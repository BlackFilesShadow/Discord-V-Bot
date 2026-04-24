-- Phase 9.1: pgvector-Extension aktivieren (Postgres-Image wurde auf
-- pgvector/pgvector:pg16 umgestellt). Idempotent.
CREATE EXTENSION IF NOT EXISTS vector;
