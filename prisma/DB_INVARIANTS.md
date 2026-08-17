# Database Scope Invariants

## DB-2 composite foreign-key contract

`20260817135600_db2_composite_scope_fks` is the database-level tenant boundary for critical relational graphs.

The migration intentionally strengthens the physical PostgreSQL constraints beyond a plain ID-only relation:

- direct Nitrado children reference `(NitradoConnection.id, NitradoConnection.guildId)`;
- virtual-account, lottery and casino child rows bind parent ID + Guild + Gameserver;
- casino legacy rows with nullable Gameserver scope still bind `gameId + guildId`;
- dashboard ticket instances bind `templateId + guildId`.

Before any existing ID-only foreign key is replaced, the migration scans current rows and raises an exception on an orphan or scope mismatch. It never repairs, reassigns or deletes inconsistent production data automatically.

The Prisma models retain their existing logical object relations so runtime APIs stay backwards compatible. The physical composite constraints are therefore guarded by `tests/security/dbCompositeScopeFkArchitecture.test.ts`; future migrations must preserve or deliberately supersede these named constraints. Removing them without an equivalent scoped invariant is a production-blocking regression.
