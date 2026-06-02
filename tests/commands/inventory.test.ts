import {
  classifyCommand,
  buildInventory,
  DASHBOARD_EXTRA,
  SPEC_KEEP_COMMANDS,
} from '../../src/commands/inventory';

describe('command inventory classification (Spec §15)', () => {
  it('classifies developer-dir commands as dev / dev-area', () => {
    const c = classifyCommand({ name: 'dev-eval', source: 'developer/devEval.ts' });
    expect(c.category).toBe('dev');
    expect(c.target).toBe('dev-area');
    expect(c.migrationStatus).toBe('pending_migration');
    expect(c.staysInDiscord).toBe(false);
  });

  it('classifies devOnly /status as dev even though it lives in user/', () => {
    const c = classifyCommand({ name: 'status', source: 'user/status.ts', devOnly: true });
    expect(c.category).toBe('dev');
  });

  it('classifies admin-dir commands as admin / bot-admin', () => {
    const c = classifyCommand({ name: 'admin-stats', source: 'admin/adminStats.ts', adminOnly: true });
    expect(c.category).toBe('admin');
    expect(c.target).toBe('bot-admin');
    expect(c.staysInDiscord).toBe(false);
  });

  it('classifies admin-extra names (feed/selfrole/xp-config) as admin', () => {
    for (const name of ['feed', 'selfrole', 'xp-config', 'translate-post', 'ai-trigger']) {
      expect(classifyCommand({ name, source: `admin/${name}.ts` }).category).toBe('admin');
    }
  });

  it('keeps /admin-pay as a keep command (lives in dashboard/economy.ts)', () => {
    // Sonderfall: admin- Praefix, aber Wirtschafts-Command -> bleibt.
    const c = classifyCommand({ name: 'admin-pay', source: 'dashboard/economy.ts' });
    expect(c.category).toBe('keep');
    expect(c.staysInDiscord).toBe(true);
  });

  it('marks /autorole for removal', () => {
    const c = classifyCommand({ name: 'autorole', source: 'user/autorole.ts' });
    expect(c.category).toBe('remove');
    expect(c.target).toBe('removed');
  });

  it('classifies plain user/dashboard commands as keep', () => {
    expect(classifyCommand({ name: 'ping', source: 'user/ping.ts' }).category).toBe('keep');
    expect(classifyCommand({ name: 'slot', source: 'dashboard/casino.ts' }).category).toBe('keep');
  });

  it('flags dashboard-extra commands as having a dashboard replacement but keeps them in Discord', () => {
    for (const name of DASHBOARD_EXTRA) {
      const c = classifyCommand({ name, source: 'user/x.ts' });
      expect(c.dashboardReplacement).toBe(true);
      // bleibt in Discord, solange nicht moved_to_dashboard
      expect(c.staysInDiscord).toBe(true);
    }
  });

  it('honours movedToDashboard override', () => {
    const c = classifyCommand({ name: 'poll', source: 'user/poll.ts', movedToDashboard: true });
    expect(c.migrationStatus).toBe('moved_to_dashboard');
    expect(c.staysInDiscord).toBe(false);
  });

  it('all spec keep commands classify as keep', () => {
    for (const name of SPEC_KEEP_COMMANDS) {
      const c = classifyCommand({ name, source: 'user/x.ts' });
      expect(c.category).toBe('keep');
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

  it('computes category counts and target Discord count', () => {
    const { summary, entries } = buildInventory(sample);
    expect(summary.total).toBe(6);
    expect(summary.admin).toBe(1);
    expect(summary.dev).toBe(1);
    expect(summary.remove).toBe(1);
    // keep = ping, poll, slot
    expect(summary.keep).toBe(3);
    // targetDiscord = keep commands that stay (none moved) = 3
    expect(summary.targetDiscord).toBe(3);
    expect(summary.dashboardExtra).toBe(1); // poll
    expect(entries).toHaveLength(6);
  });

  it('marks inSpecKeep correctly', () => {
    const { entries } = buildInventory(sample);
    expect(entries.find((e) => e.name === 'ping')?.inSpecKeep).toBe(true);
    expect(entries.find((e) => e.name === 'autorole')?.inSpecKeep).toBe(false);
  });
});
