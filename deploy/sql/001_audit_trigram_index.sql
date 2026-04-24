-- Phase A: AuditLog Volltextsuche beschleunigen.
-- Wird von deploy/update.sh nach `prisma db push` idempotent ausgefuehrt.
-- Rein additiv: nur Extension + Indices, keine Schema-Aenderung.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS audit_action_trgm_idx
  ON "AuditLog" USING gin (action gin_trgm_ops);

CREATE INDEX IF NOT EXISTS audit_details_trgm_idx
  ON "AuditLog" USING gin ((details::text) gin_trgm_ops);
