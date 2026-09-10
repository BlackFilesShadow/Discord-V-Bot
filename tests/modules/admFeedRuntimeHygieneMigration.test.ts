import fs from 'node:fs';
import path from 'node:path';

const migration = fs.readFileSync(
  path.resolve(process.cwd(), 'prisma/migrations/20260910013000_adm_feed_runtime_hygiene/migration.sql'),
  'utf8',
);

describe('ADM/feed runtime hygiene migration', () => {
  it('marks only known DayZ connecting/emote noise as IGNORED while preserving AdmEvent rows', () => {
    expect(migration).toContain('vbot_normalize_known_adm_noise');
    expect(migration).toContain("NEW.\"eventType\" = 'UNKNOWN'");
    expect(migration).toContain("NEW.\"rawLine\" LIKE '%) is connecting'");
    expect(migration).toContain("NEW.\"rawLine\" LIKE '%) performed Emote%'");
    expect(migration).toContain("NEW.\"parseStatus\" := 'IGNORED'");
    expect(migration).not.toMatch(/DELETE\s+FROM\s+\"AdmEvent\"/i);
  });

  it('deactivates gameplay feeds on inactive Nitrado connections and drains open deliveries to SKIPPED', () => {
    expect(migration).toContain('vbot_disable_gameplay_feeds_for_inactive_nitrado');
    expect(migration).toContain("NEW.\"status\" <> 'ACTIVE'");
    expect(migration).toContain('"isActive" = FALSE');
    expect(migration).toContain('"status" = \'SKIPPED\'');
    expect(migration).toContain("AND \"status\" IN ('PENDING', 'RETRY', 'SENDING')");
    expect(migration).toContain('NitradoConnection_disable_gameplay_feeds_trg');
  });
});
