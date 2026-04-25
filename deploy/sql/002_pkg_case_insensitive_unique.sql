-- Case-insensitive Eindeutigkeit von Paketnamen pro User, ignoriert
-- soft-geloeschte Pakete. Verhindert Race-Conditions zwischen
-- gleichzeitigen Uploads (findFirst -> create), die das App-seitige
-- Duplikatscheck umgehen koennten.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pkg_user_lower_name_active
  ON "Package" ("userId", lower("name"))
  WHERE "isDeleted" = false;
