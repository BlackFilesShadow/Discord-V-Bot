import fs from 'node:fs';
import path from 'node:path';

const read = (relative: string): string => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');

describe('PAGE 2 Nitrado restart planner production architecture', () => {
  const model = read('prisma/nitrado-restart-plan.prisma');
  const migration = read('prisma/migrations/20260918043000_nitrado_restart_plan/migration.sql');
  const routes = read('src/dashboard/routes/v2/nitradoTasks.ts');
  const v2 = read('src/dashboard/routes/v2.ts');
  const worker = read('src/modules/nitrado/jobWorker.ts');
  const planner = read('src/modules/nitrado/restartTaskPlan.ts');
  const store = read('src/modules/nitrado/restartTaskPlanStore.ts');
  const ui = read('dashboard-ui/src/components/nitrado/NitradoRestartPlanner.tsx');

  it('keeps restart plans strictly Guild + NitradoConnection scoped with a physical composite FK', () => {
    expect(model).toContain('@@id([guildId, nitradoConnId])');
    expect(model).toContain('nitradoServerId     String');
    expect(migration).toContain('FOREIGN KEY ("nitradoConnId", "guildId")');
    expect(migration).toContain('REFERENCES "NitradoConnection"("id", "guildId")');
    expect(migration).toContain('ON DELETE CASCADE');
    expect(migration).toContain('"intervalHours" IN (1, 2, 3, 4, 6, 8, 12, 24)');
    expect(migration).toContain("jsonb_typeof(\"times\") = 'array'");
    expect(migration).toContain('jsonb_array_length("times") <= 24');
  });

  it('mounts a dedicated dashboard-only API with separate read/write permissions', () => {
    expect(v2).toContain("v2Router.use('/guilds/:guildId/nitrado-tasks', nitradoTasksRouter)");
    expect(routes).toContain("nitradoTasksRouter.get('/restart-plan', requireGuildPermission('nitrado.view')");
    expect(routes).toContain("nitradoTasksRouter.put('/restart-plan', requireGuildPermission('nitrado.write')");
    expect(routes).toContain("nitradoTasksRouter.delete('/restart-tasks', requireGuildPermission('nitrado.write')");
    expect(routes).toContain("status: 'ACTIVE'");
    expect(routes).toContain('nitradoServerId: { not: null }');
  });

  it('persists desired state and executes remote writes only through the durable Nitrado worker', () => {
    expect(store).toContain("export const RESTART_PLAN_SYNC_OPERATION = 'RESTART_PLAN_SYNC'");
    expect(store).toContain("operation: RESTART_PLAN_SYNC_OPERATION");
    expect(worker).toContain('RESTART_PLAN_SYNC_OPERATION');
    expect(worker).toContain('claimNitradoJob');
    expect(worker).toContain('heartbeatNitradoJobClaim');
    expect(worker).toContain('tryAcquireNitradoConfigMutationLock(conn.id)');
    expect(worker).toContain('reconcileRestartTasks({');
    expect(worker).toContain('markRestartPlanSynced({');
    expect(routes).not.toContain('.createTask(');
    expect(routes).not.toContain('.deleteTask(');
  });

  it('fences stale plan revisions and service rebinds before each remote mutation', () => {
    expect(store).toContain('await assertExactActiveBinding(tx, scope);');
    expect(store).toContain('RestartPlanBindingConflictError');
    expect(worker).toContain('revision: Number(revision)');
    expect(worker).toContain('nitradoServerId: freshConn.nitradoServerId!');
    expect(worker).toContain('if (!freshPlan) throw new SupersededRestartPlanError();');
    expect(worker).toContain('beforeMutation: assertCurrentRevision');
  });

  it('uses concrete clock times instead of exposing raw cron/minute fields', () => {
    expect(planner).toContain('buildIntervalTimes');
    expect(planner).toContain('ALLOWED_INTERVAL_HOURS = [1, 2, 3, 4, 6, 8, 12, 24]');
    expect(ui).toContain('type="time"');
    expect(ui).toContain('Live-Vorschau');
    expect(ui).toContain('Alle X Stunden');
    expect(ui).not.toContain('Cron');
    expect(ui).not.toContain('Minutenvariable');
  });

  it('clears every restart task but preserves non-restart task types', () => {
    expect(planner).toContain("export const RESTART_ACTION_METHOD = 'game_server_restart'");
    expect(planner).toContain('const extras: NitradoTask[] = [];');
    expect(planner).toContain('for (const task of afterCreates.filter(isRestartTask))');
    expect(ui).toContain('Alle Restart-Aufgaben löschen');
    expect(ui).toContain('Andere automatische Aufgaben bleiben erhalten.');
  });

  it('never renders a remote-empty claim after a failed Nitrado read', () => {
    expect(ui).toContain('Der aktuelle Nitrado-Task-Zustand ist nicht verfügbar.');
    expect(ui).toContain('Es wird ausdrücklich nicht angenommen, dass keine Aufgaben existieren.');
    expect(routes).toContain("code: 'NITRADO_TASK_REMOTE_UNAVAILABLE'");
  });
});
