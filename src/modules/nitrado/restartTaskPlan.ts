import type { NitradoTask, NitradoTaskCreate } from './nitradoClient';

export const RESTART_ACTION_METHOD = 'game_server_restart';
export const ALLOWED_INTERVAL_HOURS = [1, 2, 3, 4, 6, 8, 12, 24] as const;
export const MAX_RESTART_TASKS = 24;

export type RestartPlanMode = 'INTERVAL' | 'FIXED';

export type RestartPlanInput =
  | { mode: 'INTERVAL'; intervalHours: number; startTime: string }
  | { mode: 'FIXED'; times: string[] };

export interface CanonicalRestartPlan {
  mode: RestartPlanMode;
  intervalHours: number | null;
  startTime: string | null;
  times: string[];
}

export interface RestartTaskApi {
  listTasks(serviceId: string): Promise<NitradoTask[]>;
  getTaskActionCatalog(serviceId: string): Promise<unknown>;
  createTask(serviceId: string, task: NitradoTaskCreate): Promise<void>;
  deleteTask(serviceId: string, taskId: number): Promise<void>;
}

export class RestartPlanValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RestartPlanValidationError';
  }
}

export class RestartTaskActionUnsupportedError extends Error {
  constructor() {
    super('Nitrado meldet game_server_restart fuer diesen Service nicht als verfuegbare Task-Aktion.');
    this.name = 'RestartTaskActionUnsupportedError';
  }
}

export class RestartTaskVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RestartTaskVerificationError';
  }
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

export function normalizeClock(raw: string): string {
  const value = String(raw ?? '').trim();
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(value);
  if (!match) throw new RestartPlanValidationError('Uhrzeit muss im Format HH:MM angegeben werden.');
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new RestartPlanValidationError('Ungueltige Uhrzeit.');
  }
  return `${pad2(hour)}:${pad2(minute)}`;
}

export function sortUniqueTimes(values: string[]): string[] {
  const normalized = values.map(normalizeClock);
  const unique = Array.from(new Set(normalized)).sort((a, b) => a.localeCompare(b));
  if (unique.length === 0) throw new RestartPlanValidationError('Mindestens eine Neustart-Uhrzeit ist erforderlich.');
  if (unique.length > MAX_RESTART_TASKS) {
    throw new RestartPlanValidationError(`Maximal ${MAX_RESTART_TASKS} Neustart-Uhrzeiten sind erlaubt.`);
  }
  return unique;
}

export function buildIntervalTimes(intervalHours: number, startTime: string): string[] {
  if (!ALLOWED_INTERVAL_HOURS.includes(intervalHours as (typeof ALLOWED_INTERVAL_HOURS)[number])) {
    throw new RestartPlanValidationError('Das Stundenintervall muss 1, 2, 3, 4, 6, 8, 12 oder 24 Stunden betragen.');
  }
  const start = normalizeClock(startTime);
  const [startHourRaw, minuteRaw] = start.split(':');
  const startHour = Number(startHourRaw);
  const minute = Number(minuteRaw);
  const count = 24 / intervalHours;
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(`${pad2((startHour + i * intervalHours) % 24)}:${pad2(minute)}`);
  }
  return Array.from(new Set(out)).sort((a, b) => a.localeCompare(b));
}

export function canonicalizeRestartPlanInput(value: unknown): CanonicalRestartPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RestartPlanValidationError('Ungueltige Neustart-Konfiguration.');
  }
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body).sort();
  if (body.mode === 'INTERVAL') {
    const allowed = new Set(['mode', 'intervalHours', 'startTime']);
    const unknown = keys.filter(key => !allowed.has(key));
    if (unknown.length > 0) {
      throw new RestartPlanValidationError(`Unbekannte Felder: ${unknown.join(', ')}`);
    }
    if (!Number.isInteger(body.intervalHours)) {
      throw new RestartPlanValidationError('intervalHours muss eine ganze Zahl sein.');
    }
    if (typeof body.startTime !== 'string') {
      throw new RestartPlanValidationError('startTime fehlt.');
    }
    const intervalHours = Number(body.intervalHours);
    const startTime = normalizeClock(body.startTime);
    return {
      mode: 'INTERVAL',
      intervalHours,
      startTime,
      times: buildIntervalTimes(intervalHours, startTime),
    };
  }
  if (body.mode === 'FIXED') {
    const allowed = new Set(['mode', 'times']);
    const unknown = keys.filter(key => !allowed.has(key));
    if (unknown.length > 0) {
      throw new RestartPlanValidationError(`Unbekannte Felder: ${unknown.join(', ')}`);
    }
    if (!Array.isArray(body.times) || !body.times.every(item => typeof item === 'string')) {
      throw new RestartPlanValidationError('times muss eine Liste von Uhrzeiten sein.');
    }
    return {
      mode: 'FIXED',
      intervalHours: null,
      startTime: null,
      times: sortUniqueTimes(body.times),
    };
  }
  throw new RestartPlanValidationError('mode muss INTERVAL oder FIXED sein.');
}

function exactStringExists(value: unknown, expected: string, seen = new Set<object>()): boolean {
  if (value === expected) return true;
  if (value == null || typeof value !== 'object') return false;
  if (seen.has(value as object)) return false;
  seen.add(value as object);
  if (Array.isArray(value)) return value.some(item => exactStringExists(item, expected, seen));
  return Object.entries(value as Record<string, unknown>).some(
    ([key, item]) => key === expected || exactStringExists(item, expected, seen),
  );
}

export function taskCatalogSupportsRestart(catalog: unknown): boolean {
  return exactStringExists(catalog, RESTART_ACTION_METHOD);
}

export function isRestartTask(task: NitradoTask): boolean {
  return task.action_method === RESTART_ACTION_METHOD;
}

function isDailyTask(task: NitradoTask): boolean {
  return (task.day === '*' || task.day === '')
    && (task.month === '*' || task.month === '')
    && (task.weekday === '*' || task.weekday === '');
}

export function taskClock(task: NitradoTask): string | null {
  if (!/^\d{1,2}$/.test(task.hour) || !/^\d{1,2}$/.test(task.minute)) return null;
  try {
    return normalizeClock(`${task.hour}:${task.minute}`);
  } catch {
    return null;
  }
}

export function concreteDailyRestartClock(task: NitradoTask): string | null {
  if (!isRestartTask(task) || !isDailyTask(task)) return null;
  return taskClock(task);
}

function assertExactRestartSet(tasks: NitradoTask[], desiredTimes: string[]): void {
  const restart = tasks.filter(isRestartTask);
  if (restart.length !== desiredTimes.length) {
    throw new RestartTaskVerificationError(
      `Nitrado bestaetigt ${restart.length} Restart-Tasks, erwartet werden ${desiredTimes.length}.`,
    );
  }
  const remoteTimes = restart.map(concreteDailyRestartClock);
  if (remoteTimes.some(time => time === null)) {
    throw new RestartTaskVerificationError('Mindestens ein Restart-Task ist keine konkrete taegliche Uhrzeit.');
  }
  const sorted = (remoteTimes as string[]).slice().sort((a, b) => a.localeCompare(b));
  if (sorted.some((time, index) => time !== desiredTimes[index])) {
    throw new RestartTaskVerificationError('Die bei Nitrado gespeicherten Restart-Uhrzeiten weichen vom Sollzustand ab.');
  }
}

export interface ReconcileRestartTasksOptions {
  api: RestartTaskApi;
  serviceId: string;
  desiredTimes: string[];
  beforeMutation?: () => Promise<void>;
}

export async function reconcileRestartTasks(options: ReconcileRestartTasksOptions): Promise<NitradoTask[]> {
  const desiredTimes = options.desiredTimes.length === 0
    ? []
    : sortUniqueTimes(options.desiredTimes);

  if (desiredTimes.length > 0) {
    const catalog = await options.api.getTaskActionCatalog(options.serviceId);
    if (!taskCatalogSupportsRestart(catalog)) throw new RestartTaskActionUnsupportedError();
  }

  const initial = await options.api.listTasks(options.serviceId);
  const initialRestart = initial.filter(isRestartTask);
  const firstByTime = new Map<string, NitradoTask>();
  for (const task of initialRestart) {
    const time = concreteDailyRestartClock(task);
    if (time && desiredTimes.includes(time) && !firstByTime.has(time)) firstByTime.set(time, task);
  }

  const missing = desiredTimes.filter(time => !firstByTime.has(time));
  for (const time of missing) {
    await options.beforeMutation?.();
    const [hour, minute] = time.split(':');
    await options.api.createTask(options.serviceId, {
      hour,
      minute,
      day: '*',
      month: '*',
      weekday: '*',
      actionMethod: RESTART_ACTION_METHOD,
    });
  }

  // Nach Creates frisch lesen. POST-Retries duerfen bei unklarem Remote-Ausgang
  // Duplikate erzeugen; die zweite Phase reduziert deshalb auf exakt einen Task
  // pro Soll-Uhrzeit.
  const afterCreates = await options.api.listTasks(options.serviceId);
  const keepIds = new Set<number>();
  const seenDesired = new Set<string>();
  const extras: NitradoTask[] = [];
  for (const task of afterCreates.filter(isRestartTask)) {
    const time = concreteDailyRestartClock(task);
    if (time && desiredTimes.includes(time) && !seenDesired.has(time)) {
      seenDesired.add(time);
      keepIds.add(task.id);
    } else {
      extras.push(task);
    }
  }

  for (const task of extras) {
    await options.beforeMutation?.();
    await options.api.deleteTask(options.serviceId, task.id);
  }

  const finalTasks = await options.api.listTasks(options.serviceId);
  assertExactRestartSet(finalTasks, desiredTimes);
  return finalTasks;
}
