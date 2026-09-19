import {
  buildIntervalTimes,
  canonicalizeRestartPlanInput,
  reconcileRestartTasks,
  RestartPlanValidationError,
  RestartTaskActionUnsupportedError,
  RESTART_ACTION_METHOD,
  taskCatalogSupportsRestart,
} from '../../src/modules/nitrado/restartTaskPlan';
import type { NitradoTask, NitradoTaskCreate } from '../../src/modules/nitrado/nitradoClient';

function task(
  id: number,
  hour: string,
  minute: string,
  action = RESTART_ACTION_METHOD,
  timezone: string | null = 'Europe/Berlin',
): NitradoTask {
  return {
    id,
    hour,
    minute,
    day: '*',
    month: '*',
    weekday: '*',
    action_method: action,
    next_run: null,
    last_run: null,
    timezone,
  };
}

describe('Nitrado restart task planner', () => {
  it('berechnet ein exaktes 4-Stunden-Raster mit normalen Uhrzeiten', () => {
    expect(buildIntervalTimes(4, '00:00')).toEqual([
      '00:00', '04:00', '08:00', '12:00', '16:00', '20:00',
    ]);
    expect(buildIntervalTimes(4, '01:15')).toEqual([
      '01:15', '05:15', '09:15', '13:15', '17:15', '21:15',
    ]);
  });

  it('erlaubt nur Intervalle, die ueber Tagesgrenzen exakt bleiben', () => {
    expect(() => buildIntervalTimes(5, '00:00')).toThrow(RestartPlanValidationError);
    expect(() => buildIntervalTimes(4, '24:00')).toThrow(RestartPlanValidationError);
  });

  it('normalisiert feste Uhrzeiten, entfernt Duplikate und lehnt fremde Felder ab', () => {
    expect(canonicalizeRestartPlanInput({
      mode: 'FIXED',
      times: ['4:5', '04:05', '12:30'],
    })).toEqual({
      mode: 'FIXED',
      intervalHours: null,
      startTime: null,
      times: ['04:05', '12:30'],
    });
    expect(() => canonicalizeRestartPlanInput({
      mode: 'INTERVAL',
      intervalHours: 4,
      startTime: '00:00',
      injected: true,
    })).toThrow(/Unbekannte Felder/);
  });

  it('reconciled nur Restart-Tasks und laesst andere Nitrado-Tasks unangetastet', async () => {
    let rows: NitradoTask[] = [
      task(1, '0', '0'),
      task(2, '2', '0'),
      task(3, '6', '0', 'game_server_stop'),
    ];
    let nextId = 10;
    const created: NitradoTaskCreate[] = [];
    const deleted: number[] = [];
    const api = {
      listTasks: jest.fn(async () => rows.map(row => ({ ...row }))),
      getTaskActionCatalog: jest.fn(async () => [{ action_method: RESTART_ACTION_METHOD }]),
      createTask: jest.fn(async (_serviceId: string, input: NitradoTaskCreate) => {
        created.push(input);
        rows.push(task(nextId++, input.hour, input.minute, input.actionMethod));
      }),
      deleteTask: jest.fn(async (_serviceId: string, taskId: number) => {
        deleted.push(taskId);
        rows = rows.filter(row => row.id !== taskId);
      }),
    };

    const final = await reconcileRestartTasks({
      api,
      serviceId: '123',
      desiredTimes: ['00:00', '04:00'],
    });

    expect(created).toEqual([expect.objectContaining({ hour: '04', minute: '00', actionMethod: RESTART_ACTION_METHOD })]);
    expect(deleted).toContain(2);
    expect(final.some(row => row.action_method === 'game_server_stop' && row.id === 3)).toBe(true);
    expect(final.filter(row => row.action_method === RESTART_ACTION_METHOD).map(row => row.hour + ':' + row.minute).sort())
      .toEqual(['04:00', '0:0']);
  });

  it('bereinigt alle Restart-Tasks inklusive Sonderregeln, ohne Start/Stop zu loeschen', async () => {
    let rows: NitradoTask[] = [
      task(1, '0', '0'),
      { ...task(2, '*/4', '0'), day: '*' },
      task(3, '8', '0', 'game_server_start'),
    ];
    const api = {
      listTasks: jest.fn(async () => rows.map(row => ({ ...row }))),
      getTaskActionCatalog: jest.fn(async () => null),
      createTask: jest.fn(async () => undefined),
      deleteTask: jest.fn(async (_serviceId: string, taskId: number) => {
        rows = rows.filter(row => row.id !== taskId);
      }),
    };

    const final = await reconcileRestartTasks({ api, serviceId: '123', desiredTimes: [] });
    expect(api.getTaskActionCatalog).not.toHaveBeenCalled();
    expect(final.filter(row => row.action_method === RESTART_ACTION_METHOD)).toHaveLength(0);
    expect(final).toEqual([expect.objectContaining({ id: 3, action_method: 'game_server_start' })]);
  });

  it('recognizes the exact restart action whether Nitrado returns it as a value or a keyed catalog entry', () => {
    expect(taskCatalogSupportsRestart([{ action_method: RESTART_ACTION_METHOD }])).toBe(true);
    expect(taskCatalogSupportsRestart({ [RESTART_ACTION_METHOD]: { label: 'Restart' } })).toBe(true);
    expect(taskCatalogSupportsRestart({ game_server_restart_later: true })).toBe(false);
  });

  it('failt geschlossen wenn Nitrado die Restart-Aktion nicht im Task-Katalog bestaetigt', async () => {
    const api = {
      listTasks: jest.fn(async () => [] as NitradoTask[]),
      getTaskActionCatalog: jest.fn(async () => [{ action_method: 'game_server_stop' }]),
      createTask: jest.fn(async () => undefined),
      deleteTask: jest.fn(async () => undefined),
    };
    await expect(reconcileRestartTasks({
      api,
      serviceId: '123',
      desiredTimes: ['00:00'],
    })).rejects.toBeInstanceOf(RestartTaskActionUnsupportedError);
    expect(api.createTask).not.toHaveBeenCalled();
  });

  it('raeumt Duplikate auf, die durch einen unklaren POST-Ausgang entstanden sein koennen', async () => {
    let rows: NitradoTask[] = [];
    let nextId = 1;
    const api = {
      listTasks: jest.fn(async () => rows.map(row => ({ ...row }))),
      getTaskActionCatalog: jest.fn(async () => [RESTART_ACTION_METHOD]),
      createTask: jest.fn(async (_serviceId: string, input: NitradoTaskCreate) => {
        rows.push(task(nextId++, input.hour, input.minute));
        rows.push(task(nextId++, input.hour, input.minute));
      }),
      deleteTask: jest.fn(async (_serviceId: string, taskId: number) => {
        rows = rows.filter(row => row.id !== taskId);
      }),
    };

    await reconcileRestartTasks({ api, serviceId: '123', desiredTimes: ['04:00'] });
    expect(rows.filter(row => row.action_method === RESTART_ACTION_METHOD)).toHaveLength(1);
  });

  // Regression (FIX-8): Nitrado erlaubt keine explizite Zeitzone bei
  // createTask() -- ein Task uebernimmt beim Anlegen stillschweigend den
  // aktuellen Konto-Default. Zwei Restart-Tasks mit identischer HH:MM-Anzeige
  // koennen dadurch real zu unterschiedlichen Zeitpunkten feuern, wenn sich
  // dieser Default zwischen zwei Anlagen verschoben hat. Der Reconciler muss
  // das erkennen statt "synchronisiert" zu melden.
  it('heilt einen bestehenden Zeitzonen-Ausreisser statt ihn als synchronisiert zu akzeptieren', async () => {
    // 04:00 existiert bereits, aber mit einer anderen Zeitzone als 00:00.
    let rows: NitradoTask[] = [
      task(1, '0', '0', RESTART_ACTION_METHOD, 'Europe/Berlin'),
      task(2, '4', '0', RESTART_ACTION_METHOD, 'UTC'),
    ];
    let nextId = 10;
    const deleted: number[] = [];
    const api = {
      listTasks: jest.fn(async () => rows.map(row => ({ ...row }))),
      getTaskActionCatalog: jest.fn(async () => [RESTART_ACTION_METHOD]),
      // Der Konto-Default hat sich inzwischen wieder auf Europe/Berlin
      // "normalisiert" -- die Neuanlage bekommt daher wieder die Referenz-Zeitzone.
      createTask: jest.fn(async (_serviceId: string, input: NitradoTaskCreate) => {
        rows.push(task(nextId++, input.hour, input.minute, input.actionMethod, 'Europe/Berlin'));
      }),
      deleteTask: jest.fn(async (_serviceId: string, taskId: number) => {
        deleted.push(taskId);
        rows = rows.filter(row => row.id !== taskId);
      }),
    };

    const final = await reconcileRestartTasks({
      api,
      serviceId: '123',
      desiredTimes: ['00:00', '04:00'],
    });

    // Der alte 04:00-Ausreisser (id 2, UTC) wird entfernt, nicht behalten.
    expect(deleted).toContain(2);
    const restartTasks = final.filter(row => row.action_method === RESTART_ACTION_METHOD);
    expect(restartTasks).toHaveLength(2);
    expect(new Set(restartTasks.map(row => row.timezone))).toEqual(new Set(['Europe/Berlin']));
  });

  it('failt geschlossen statt eine Zeitzonen-Drift zwischen zwei Neuanlagen als synchronisiert zu melden', async () => {
    let rows: NitradoTask[] = [];
    let nextId = 1;
    let createCount = 0;
    const api = {
      listTasks: jest.fn(async () => rows.map(row => ({ ...row }))),
      getTaskActionCatalog: jest.fn(async () => [RESTART_ACTION_METHOD]),
      // Simuliert eine Konto-Zeitzonen-Aenderung genau zwischen den beiden
      // Neuanlagen (ein enges, aber reales Zeitfenster).
      createTask: jest.fn(async (_serviceId: string, input: NitradoTaskCreate) => {
        createCount += 1;
        const timezone = createCount === 1 ? 'Europe/Berlin' : 'UTC';
        rows.push(task(nextId++, input.hour, input.minute, input.actionMethod, timezone));
      }),
      deleteTask: jest.fn(async (_serviceId: string, taskId: number) => {
        rows = rows.filter(row => row.id !== taskId);
      }),
    };

    await expect(reconcileRestartTasks({
      api,
      serviceId: '123',
      desiredTimes: ['00:00', '04:00'],
    })).rejects.toThrow(/unterschiedliche Zeitzonen|Nitrado bestaetigt/);
  });
});
