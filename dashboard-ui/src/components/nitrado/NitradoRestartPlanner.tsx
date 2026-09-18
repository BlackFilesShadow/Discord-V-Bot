import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, describeApiError } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Clock3, Plus, RefreshCw, Trash2 } from 'lucide-react';

type PlanMode = 'INTERVAL' | 'FIXED';
type SyncStatus = 'PENDING' | 'SYNCED' | 'ERROR';

interface RestartPlanResponse {
  plan: {
    enabled: boolean;
    mode: PlanMode;
    intervalHours: number | null;
    startTime: string | null;
    times: string[];
    revision: number;
    syncStatus: SyncStatus;
    lastSyncAt: string | null;
    lastSyncError: string | null;
    serviceBindingMatches: boolean;
  } | null;
  remote: {
    actionSupported: boolean | null;
    synchronized: boolean;
    restartTasks: Array<{
      id: number;
      time: string | null;
      hour: string;
      minute: string;
      day: string;
      month: string;
      weekday: string;
      lastRun: string | null;
      nextRun: string | null;
      timezone: string | null;
    }>;
  };
}

interface DashboardMeta {
  isOwner: boolean;
  permissions: string[];
}

const INTERVALS = [1, 2, 3, 4, 6, 8, 12, 24] as const;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function normalizeTime(value: string): string | null {
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  return `${pad2(hour)}:${pad2(minute)}`;
}

function intervalTimes(intervalHours: number, startTime: string): string[] {
  if (!INTERVALS.includes(intervalHours as (typeof INTERVALS)[number])) return [];
  const normalized = normalizeTime(startTime);
  if (!normalized) return [];
  const [hourRaw, minuteRaw] = normalized.split(':');
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const count = 24 / intervalHours;
  return Array.from({ length: count }, (_, index) =>
    `${pad2((hour + index * intervalHours) % 24)}:${pad2(minute)}`,
  ).sort((a, b) => a.localeCompare(b));
}

function fixedTimes(values: string[]): string[] {
  const out = values.map(normalizeTime).filter((value): value is string => value !== null);
  return Array.from(new Set(out)).sort((a, b) => a.localeCompare(b)).slice(0, 24);
}

function formatRemoteDate(value: string | null): string {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString('de-DE');
}

function displayClock(value: string): string {
  const normalized = normalizeTime(value);
  if (!normalized) return value;
  const [hour, minute] = normalized.split(':');
  return `${Number(hour)}:${minute}`;
}

export function NitradoRestartPlanner({ guildId, slot }: { guildId: string; slot: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [mode, setMode] = useState<PlanMode>('INTERVAL');
  const [intervalHours, setIntervalHours] = useState(4);
  const [startTime, setStartTime] = useState('00:00');
  const [times, setTimes] = useState<string[]>([]);
  const [newTime, setNewTime] = useState('00:00');
  const [dirty, setDirty] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const endpoint = `/api/v2/guilds/${guildId}/nitrado-tasks/restart-plan?slot=${encodeURIComponent(slot)}`;
  const query = useQuery({
    queryKey: ['nitrado-restart-plan', guildId, slot],
    queryFn: () => api.get<RestartPlanResponse>(endpoint),
    retry: false,
    refetchInterval: q => q.state.data?.plan?.syncStatus === 'PENDING' ? 2000 : false,
  });
  const meta = useQuery({
    queryKey: ['dashboard-slot-meta', guildId, slot],
    queryFn: () => api.get<DashboardMeta>(`/api/v2/guilds/${guildId}/dashboard`),
    retry: false,
  });

  const canWrite = Boolean(
    meta.data?.isOwner
    || meta.data?.permissions.includes('dashboard.access')
    || meta.data?.permissions.includes('nitrado.write'),
  );

  const loadedPlan = query.data?.plan ?? null;

  // Unsaved editor state is scoped to exactly one guild/slot. ServerSlotV3 can
  // reuse this component instance while navigating between slots; carrying a
  // dirty form across that boundary could otherwise submit slot A's schedule
  // to slot B's endpoint.
  useEffect(() => {
    setDirty(false);
    setConfirmClear(false);
    setMode('INTERVAL');
    setIntervalHours(4);
    setStartTime('00:00');
    setTimes([]);
    setNewTime('00:00');
  }, [guildId, slot]);

  useEffect(() => {
    if (dirty || !loadedPlan) return;
    setMode(loadedPlan.mode);
    setIntervalHours(loadedPlan.intervalHours ?? 4);
    setStartTime(loadedPlan.startTime ?? '00:00');
    setTimes(loadedPlan.times);
  }, [dirty, loadedPlan]);

  const preview = useMemo(
    () => mode === 'INTERVAL' ? intervalTimes(intervalHours, startTime) : fixedTimes(times),
    [mode, intervalHours, startTime, times],
  );

  const save = useMutation({
    mutationFn: () => api.put(endpoint, mode === 'INTERVAL'
      ? { mode, intervalHours, startTime }
      : { mode, times: preview }),
    onSuccess: () => {
      setDirty(false);
      setConfirmClear(false);
      void qc.invalidateQueries({ queryKey: ['nitrado-restart-plan', guildId, slot] });
      toast.push({
        variant: 'success',
        title: 'Synchronisierung gestartet',
        desc: 'V-Bot gleicht den Plan jetzt mit den echten Nitrado-Aufgaben ab.',
      });
    },
    onError: error => {
      const d = describeApiError(error);
      toast.push({ variant: 'danger', title: d.title, desc: d.desc });
    },
  });

  const clear = useMutation({
    mutationFn: () => api.del(
      `/api/v2/guilds/${guildId}/nitrado-tasks/restart-tasks?slot=${encodeURIComponent(slot)}`,
    ),
    onSuccess: () => {
      setDirty(false);
      setConfirmClear(false);
      setTimes([]);
      void qc.invalidateQueries({ queryKey: ['nitrado-restart-plan', guildId, slot] });
      toast.push({
        variant: 'success',
        title: 'Bereinigung gestartet',
        desc: 'Alle game_server_restart-Aufgaben werden bei Nitrado entfernt und danach remote verifiziert.',
      });
    },
    onError: error => {
      const d = describeApiError(error);
      toast.push({ variant: 'danger', title: d.title, desc: d.desc });
    },
  });

  const addFixedTime = (): void => {
    const normalized = normalizeTime(newTime);
    if (!normalized) return;
    const next = fixedTimes([...times, normalized]);
    setTimes(next);
    setDirty(true);
  };

  const data = query.data;
  const fullySynced = Boolean(
    data?.plan
    && data.plan.serviceBindingMatches
    && data.plan.syncStatus === 'SYNCED'
    && data.remote.synchronized,
  );
  const timezone = data?.remote.restartTasks.find(task => task.timezone)?.timezone ?? null;

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle><span className="inline-flex items-center gap-2"><Clock3 className="h-4 w-4" />Automatische Nitrado-Neustarts</span></CardTitle>
            <div className="flex flex-wrap gap-2">
              {fullySynced
                ? <Badge variant="ok">Bei Nitrado gespeichert</Badge>
                : data?.plan?.syncStatus === 'PENDING'
                  ? <Badge variant="neutral">Synchronisierung läuft</Badge>
                  : data?.plan?.syncStatus === 'ERROR'
                    ? <Badge variant="danger">Synchronisierung fehlerhaft</Badge>
                    : <Badge variant="neutral">Nicht synchronisiert</Badge>}
              {timezone && <Badge variant="neutral">{timezone}</Badge>}
            </div>
          </div>
        </CardHeader>

        <div className="rounded-lg border border-border/60 bg-bg-elev/35 p-3 text-xs text-muted">
          <strong className="text-white">Wichtig:</strong> V-Bot erstellt echte automatische Aufgaben bei Nitrado.
          Die Neustarts werden danach von Nitrado ausgeführt, auch wenn V-Bot offline ist.
          Beim Speichern verwaltet dieser Plan sämtliche <code>game_server_restart</code>-Aufgaben des ausgewählten Nitrado-Servers.
          Start-, Stop- und andere Task-Typen werden nicht verändert.
        </div>

        {query.isLoading && <p className="mt-4 text-sm text-muted">Lade Nitrado-Aufgaben…</p>}
        {query.isError && (
          <div role="alert" className="mt-4 text-sm text-danger">
            {describeApiError(query.error).desc}
          </div>
        )}

        {data && (
          <div className="mt-5 space-y-5">
            {data.remote.actionSupported === false && (
              <div role="alert" className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
                Nitrado meldet <code>game_server_restart</code> für diesen Service derzeit nicht als verfügbare Task-Aktion.
                Neue Restart-Aufgaben werden deshalb nicht angelegt.
              </div>
            )}
            {data.remote.actionSupported === null && (
              <div role="status" className="rounded-lg border border-border/60 bg-bg-elev/35 p-3 text-sm text-muted">
                Der Nitrado-Aktionskatalog konnte nicht bestätigt werden. Vorhandene Restart-Aufgaben bleiben sichtbar und löschbar;
                neue Aufgaben können erst gespeichert werden, wenn Nitrado die Restart-Aktion wieder bestätigt.
              </div>
            )}
            {data.plan && !data.plan.serviceBindingMatches && (
              <div role="alert" className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
                Die Nitrado-Servicebindung hat sich seit dem Speichern des Plans geändert. Bitte den Plan neu prüfen und speichern.
              </div>
            )}
            {data.plan?.lastSyncError && data.plan.syncStatus === 'ERROR' && (
              <div role="alert" className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
                {data.plan.lastSyncError}
              </div>
            )}

            <div className="grid gap-4 md:grid-cols-2">
              <label className="text-sm">
                <span className="text-muted">Planungsart</span>
                <Select aria-label="Planungsart" value={mode} onChange={event => {
                  setMode(event.target.value as PlanMode);
                  setDirty(true);
                }}>
                  <option value="INTERVAL">Alle X Stunden</option>
                  <option value="FIXED">Feste Uhrzeiten</option>
                </Select>
              </label>

              {mode === 'INTERVAL' && (
                <label className="text-sm">
                  <span className="text-muted">Intervall</span>
                  <Select aria-label="Intervall" value={String(intervalHours)} onChange={event => {
                    setIntervalHours(Number(event.target.value));
                    setDirty(true);
                  }}>
                    {INTERVALS.map(hours => (
                      <option key={hours} value={hours}>
                        {hours === 1 ? 'Jede Stunde' : `Alle ${hours} Stunden`}
                      </option>
                    ))}
                  </Select>
                </label>
              )}

              {mode === 'INTERVAL' && (
                <label className="text-sm">
                  <span className="text-muted">Erste Uhrzeit</span>
                  <Input aria-label="Erste Uhrzeit" type="time" step={60} value={startTime} onChange={event => {
                    setStartTime(event.target.value);
                    setDirty(true);
                  }} />
                </label>
              )}

              {mode === 'FIXED' && (
                <div className="text-sm">
                  <span className="text-muted">Uhrzeit hinzufügen</span>
                  <div className="flex gap-2">
                    <Input aria-label="Uhrzeit hinzufügen" type="time" step={60} value={newTime} onChange={event => setNewTime(event.target.value)} />
                    <Button type="button" variant="secondary" onClick={addFixedTime} disabled={times.length >= 24}>
                      <Plus className="h-4 w-4" /> Hinzufügen
                    </Button>
                  </div>
                </div>
              )}
            </div>

            {mode === 'FIXED' && times.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {fixedTimes(times).map(time => (
                  <span key={time} className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-bg/40 px-2 py-1 text-sm">
                    {displayClock(time)}
                    <button
                      type="button"
                      className="rounded px-1 text-muted hover:text-danger"
                      aria-label={`${time} entfernen`}
                      onClick={() => {
                        setTimes(current => current.filter(value => value !== time));
                        setDirty(true);
                      }}
                    >×</button>
                  </span>
                ))}
              </div>
            )}

            <div className="rounded-lg border border-border/60 bg-bg/30 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-medium text-white">Live-Vorschau</p>
                  <p className="text-xs text-muted">
                    Genau diese {preview.length} Uhrzeit{preview.length === 1 ? '' : 'en'} werden als echte Nitrado-Restart-Tasks angelegt.
                  </p>
                </div>
                <Badge variant="neutral">{preview.length} Tasks</Badge>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
                {preview.map(time => (
                  <div key={time} className="rounded-md border border-border/60 bg-bg-elev/40 px-2 py-2 text-center font-mono text-sm text-white">
                    {displayClock(time)}
                  </div>
                ))}
              </div>
              <p className="mt-3 text-xs text-muted">
                {timezone
                  ? `Nitrado-Zeitzone: ${timezone}. Die Vorschau wird nicht im Browser umgerechnet.`
                  : 'Die Uhrzeiten werden unverändert an Nitrado übergeben. Eine von Nitrado bestätigte Zeitzone wird angezeigt, sobald sie in einem gespeicherten Task vorhanden ist.'}
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => save.mutate()}
                disabled={!canWrite || save.isPending || clear.isPending || preview.length === 0 || data.remote.actionSupported !== true}
              >
                {save.isPending ? 'Speichere…' : 'Bei Nitrado speichern'}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => query.refetch()}
                disabled={query.isFetching}
              >
                <RefreshCw className={`h-4 w-4 ${query.isFetching ? 'animate-spin' : ''}`} /> Aktualisieren
              </Button>
              <Button
                type="button"
                variant="danger"
                onClick={() => setConfirmClear(true)}
                disabled={!canWrite || clear.isPending || data.remote.restartTasks.length === 0}
              >
                <Trash2 className="h-4 w-4" /> Alle Restart-Aufgaben löschen
              </Button>
            </div>

            {!canWrite && (
              <p className="text-xs text-muted">Zum Ändern ist <code>nitrado.write</code> oder entsprechender Vollzugriff erforderlich.</p>
            )}
          </div>
        )}
      </Card>

      {confirmClear && (
        <Card>
          <CardHeader><CardTitle>Restart-Aufgaben wirklich bereinigen?</CardTitle></CardHeader>
          <p className="text-sm text-muted">
            Dadurch werden alle <code>game_server_restart</code>-Aufgaben dieses Nitrado-Servers entfernt,
            auch wenn sie ursprünglich direkt im Nitrado-Webinterface angelegt wurden.
            Andere automatische Aufgaben bleiben erhalten.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="danger" onClick={() => clear.mutate()} disabled={clear.isPending}>
              {clear.isPending ? 'Lösche…' : 'Ja, alle Restart-Aufgaben löschen'}
            </Button>
            <Button variant="ghost" onClick={() => setConfirmClear(false)} disabled={clear.isPending}>Abbrechen</Button>
          </div>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>Aktuell bei Nitrado</CardTitle>
            <Badge variant={data?.remote.synchronized ? 'ok' : 'neutral'}>
              {data?.remote.synchronized ? 'Synchron' : 'Remote-Zustand'}
            </Badge>
          </div>
        </CardHeader>
        {query.isLoading ? (
          <p className="text-sm text-muted">Lade den aktuellen Nitrado-Zustand…</p>
        ) : query.isError ? (
          <div role="alert" className="text-sm text-danger">
            Der aktuelle Nitrado-Task-Zustand ist nicht verfügbar. Es wird ausdrücklich nicht angenommen, dass keine Aufgaben existieren.
          </div>
        ) : !data ? (
          <div role="alert" className="text-sm text-danger">Kein bestätigter Nitrado-Zustand verfügbar.</div>
        ) : data.remote.restartTasks.length === 0 ? (
          <p className="text-sm text-muted">Nitrado bestätigt aktuell keine automatischen Restart-Aufgaben.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="text-xs text-muted">
                <tr>
                  <th className="py-2 text-left">Uhrzeit</th>
                  <th className="py-2 text-left">Letzter Lauf</th>
                  <th className="py-2 text-left">Nächster Lauf</th>
                  <th className="py-2 text-left">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.remote.restartTasks.map(task => (
                  <tr key={task.id} className="border-t border-border/60">
                    <td className="py-2 font-mono text-white">
                      {task.time ? displayClock(task.time) : `${task.hour}:${task.minute}`}
                    </td>
                    <td className="py-2 text-muted">{formatRemoteDate(task.lastRun)}</td>
                    <td className="py-2 text-muted">{formatRemoteDate(task.nextRun)}</td>
                    <td className="py-2">
                      {task.time
                        ? <Badge variant="ok">Konkrete Uhrzeit</Badge>
                        : <Badge variant="danger">Sonderregel / Altbestand</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
