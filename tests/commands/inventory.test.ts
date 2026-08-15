import {
  classifyCommand,
  buildInventory,
  DASHBOARD_EXTRA,
  SPEC_KEEP_COMMANDS,
  MOVED_TO_DASHBOARD,
  PRESERVED_MANUFACTURER_COMMANDS,
} from '../../src/commands/inventory';

describe('command inventory classification (Spec §15)', () => {
  it('classifies migrated developer commands as dev-area and moved to dashboard', () => {
    const c = classifyCommand({ name: 'dev-eval', source: 'developer/devEval.ts' });
    expect(c.category).toBe('dev');
    expect(c.target).toBe('dev-area');
    expect(c.migrationStatus).toBe('moved_to_dashboard');
    expect(c.dashboardReplacement).toBe(true);
    expect(c.staysInDiscord).toBe(false);
  });

  it('classifies migrated devOnly /status as dev even though it lived in user/', () => {
    const c = classifyCommand({ name: 'status', source: 'user/status.ts', devOnly: true });
    expect(c.category).toBe('dev');
    expect(c.migrationStatus).toBe('moved_to_dashboard');
    expect(c.staysInDiscord).toBe(false);
  });

  it('classifies migrated admin commands as bot-admin and removes them from Discord', () => {
    const c = classifyCommand({ name: 'admin-stats', source: 'admin/adminStats.ts', adminOnly: true });
    expect(c.category).toBe('admin');
    expect(c.target).toBe('bot-admin');
    expect(c.migrationStatus).toBe('moved_to_dashboard');
    expect(c.staysInDiscord).toBe(false);
  });

  it('classifies admin-extra names according to their migration state', () => {
    for (const name of ['feed', 'selfrole', 'xp-config', 'translate-post', 'ai-trigger']) {
      const c = classifyCommand({ name, source: `admin/${name}.ts` });
      expect(c.category).toBe('admin');
      if (MOVED_TO_DASHBOARD.has(name)) {
        expect(c.migrationStatus).toBe('moved_to_dashboard');
        expect(c.staysInDiscord).toBe(false);
      }
    }
  });

  it('keeps /admin-pay as a keep command (lives in dashboard/economy.ts)', () => {
    const c = classifyCommand({ name: 'admin-pay', source: 'dashboard/economy.ts' });
    expect(c.category).toBe('keep');
    expect(c.staysInDiscord).toBe(true);
  });

  it('marks /autorole for removal', () => {
    const c = classifyCommand({ name: 'autorole', source: 'user/autorole.ts' });
    expect(c.category).toBe('remove');
    expect(c.target).toBe('removed');
  });

  it('keeps ordinary user/dashboard commands but not explicitly migrated user commands', () => {
    const ping = classifyCommand({ name: 'ping', source: 'user/ping.ts' });
    expect(ping.category).toBe('keep');
    expect(ping.migrationStatus).toBe('moved_to_dashboard');
    expect(ping.staysInDiscord).toBe(false);

    const slot = classifyCommand({ name: 'slot', source: 'dashboard/casino.ts' });
    expect(slot.category).toBe('keep');
    expect(slot.migrationStatus).toBe('active');
    expect(slot.staysInDiscord).toBe(true);
  });

  it('flags dashboard-extra commands as having a dashboard replacement but keeps non-migrated ones in Discord', () => {
    for (const name of DASHBOARD_EXTRA) {
      const c = classifyCommand({ name, source: 'user/x.ts' });
      expect(c.dashboardReplacement).toBe(true);
      expect(c.staysInDiscord).toBe(!MOVED_TO_DASHBOARD.has(name));
    }
  });

  it('honours movedToDashboard override', () => {
    const c = classifyCommand({ name: 'poll', source: 'user/poll.ts', movedToDashboard: true });
    expect(c.migrationStatus).toBe('moved_to_dashboard');
    expect(c.staysInDiscord).toBe(false);
  });

  it('keeps every current spec-keep command in the keep category', () => {
    for (const name of SPEC_KEEP_COMMANDS) {
      const c = classifyCommand({ name, source: 'user/x.ts' });
      expect(c.category).toBe('keep');
    }
  });

  it('preserves manufacturer commands explicitly in Discord', () => {
    for (const name of PRESERVED_MANUFACTURER_COMMANDS) {
      const c = classifyCommand({ name, source: 'developer/devManufacturer.ts', devOnly: true });
      expect(c.target).toBe('discord');
      expect(c.migrationStatus).toBe('active');
      expect(c.staysInDiscord).toBe(true);
    }
  });
});

describe('buildInventory summary', () => {
  const sample = [
    { name: 'ping', source: 'user/ping.ts' },
    { name: 'autorole', source: 'user/autorole.ts' },
    { name: 'admin-stats', source: 'admin/adminStats.ts', adminOnly: true },
    { name: 'dev-eval', source: 'developer/devEval.ts' },
    { name: 'poll', source: 'user/poll.ts' },
    { name: 'slot', source: 'dashboard/casino.ts' },
  ];

  it('computes category counts and target Discord count after migration', () => {
    const { summary, entries } = buildInventory(sample);
    expect(summary.total).toBe(6);
    expect(summary.admin).toBe(1);
    expect(summary.dev).toBe(1);
    expect(summary.remove).toBe(1);
    expect(summary.keep).toBe(3);
    // ping/admin-stats/dev-eval are migrated and autorole is removed; poll + slot remain.
    expect(summary.targetDiscord).toBe(2);
    expect(summary.movedToDashboard).toBe(3);
    expect(summary.dashboardExtra).toBe(4);
    expect(entries).toHaveLength(6);
  });

  it('marks inSpecKeep against the current Discord keep contract', () => {
    const { entries } = buildInventory(sample);
    expect(entries.find((e) => e.name === 'ping')?.inSpecKeep).toBe(false);
    expect(entries.find((e) => e.name === 'poll')?.inSpecKeep).toBe(true);
    expect(entries.find((e) => e.name === 'slot')?.inSpecKeep).toBe(true);
    expect(entries.find((e) => e.name === 'autorole')?.inSpecKeep).toBe(false);
  });
});
