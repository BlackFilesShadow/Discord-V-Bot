CREATE TABLE IF NOT EXISTS "SelfRoleOptionBehavior" (
  "optionId" TEXT NOT NULL,
  "assignMode" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SelfRoleOptionBehavior_pkey" PRIMARY KEY ("optionId"),
  CONSTRAINT "SelfRoleOptionBehavior_assignMode_check" CHECK ("assignMode" IN ('GIVE', 'REMOVE', 'TOGGLE')),
  CONSTRAINT "SelfRoleOptionBehavior_optionId_fkey"
    FOREIGN KEY ("optionId") REFERENCES "SelfRoleOption"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
