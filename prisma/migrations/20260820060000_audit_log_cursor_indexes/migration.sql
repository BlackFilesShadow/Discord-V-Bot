-- Dashboard-1W: scope AuditLog list/category reads by Guild and by the
-- deterministic (createdAt, id) cursor used by the Owner-only dashboard.
CREATE INDEX "AuditLog_guildId_createdAt_id_idx"
  ON "AuditLog"("guildId", "createdAt", "id");

CREATE INDEX "AuditLog_guildId_category_createdAt_id_idx"
  ON "AuditLog"("guildId", "category", "createdAt", "id");
