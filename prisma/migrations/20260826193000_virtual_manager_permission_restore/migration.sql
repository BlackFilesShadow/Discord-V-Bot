-- Stores only the permission bits V-Bot owns so existing/manual channel
-- overwrites can be restored exactly when a manager is removed or the panel
-- is moved/disabled.

ALTER TABLE "EconomyVirtualManagerPanel"
  ADD COLUMN "previousEveryoneView" SMALLINT NOT NULL DEFAULT 0;

ALTER TABLE "EconomyVirtualManagerPanel"
  ADD CONSTRAINT "EconomyVirtualManagerPanel_previous_everyone_view_check"
  CHECK ("previousEveryoneView" IN (-1, 0, 1));

ALTER TABLE "EconomyVirtualManagerPanelAccess"
  ADD COLUMN "previousViewChannel" SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN "previousSendMessages" SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN "previousReadHistory" SMALLINT NOT NULL DEFAULT 0;

ALTER TABLE "EconomyVirtualManagerPanelAccess"
  ADD CONSTRAINT "EconomyVirtualManagerPanelAccess_previous_view_check"
    CHECK ("previousViewChannel" IN (-1, 0, 1)),
  ADD CONSTRAINT "EconomyVirtualManagerPanelAccess_previous_send_check"
    CHECK ("previousSendMessages" IN (-1, 0, 1)),
  ADD CONSTRAINT "EconomyVirtualManagerPanelAccess_previous_history_check"
    CHECK ("previousReadHistory" IN (-1, 0, 1));