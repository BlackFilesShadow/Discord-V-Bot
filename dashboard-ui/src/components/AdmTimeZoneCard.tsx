import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Clock3 } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';

interface AdmSourceResponse {
  slot: number;
  connectionId: string;
  profileDir: string;
  source: string;
  timeZone: string | null;
  fileCount: number;
  latestFile: { name?: string } | null;
}

const COMMON_TIME_ZONES = [
  'Europe/Berlin',
  'UTC',
  'Europe/London',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Australia/Sydney',
  'Asia/Tokyo',
];

export function AdmTimeZoneCard({ guildId, slot }: { guildId: string; slot: number }) {
  const toast = useToast();
  const [timeZone, setTimeZone] = useState('');
  const [saving, setSaving] = useState(false);

  const sourceQuery = useQuery({
    queryKey: ['adm-source', guildId, slot],
    queryFn: () => api.get<AdmSourceResponse>(`/api/v2/guilds/${guildId}/adm-source?slot=${slot}`),
    enabled: !!guildId && slot >= 1,
  });

  useEffect(() => {
    setTimeZone(sourceQuery.data?.timeZone ?? '');
  }, [sourceQuery.data?.timeZone, slot]);

  const normalized = timeZone.trim();
  const stored = sourceQuery.data?.timeZone ?? '';
  const dirty = normalized !== stored;

  const save = async () => {
    setSaving(true);
    try {
      await api.patch(`/api/v2/guilds/${guildId}/adm-source?slot=${slot}`, {
        timeZone: normalized || null,
      });
      await sourceQuery.refetch();
      toast.success('ADM-Zeitzone gespeichert. Neue Ereignisse werden mit der korrigierten Zeitbasis verarbeitet.');
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'ADM-Zeitzone konnte nicht gespeichert werden.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="!p-4">
      <CardHeader className="mb-3 justify-between gap-3">
        <div>
          <CardTitle className="inline-flex items-center gap-2">
            <Clock3 className="h-4 w-4 text-accent" /> ADM-Zeitbasis
          </CardTitle>
          <p className="mt-1 text-xs text-muted">DayZ-ADM enthält Server-Wanduhrzeiten. Die IANA-Zeitzone wird DST-sicher nach UTC normalisiert und gilt zentral für alle ADM-basierten Feeds und Radar.</p>
        </div>
      </CardHeader>

      {sourceQuery.isLoading && <div className="h-16 rounded-lg skeleton" />}
      {sourceQuery.isError && <p className="text-sm text-danger">{(sourceQuery.error as Error).message}</p>}

      {sourceQuery.data && (
        <div className="grid gap-3">
          <div className="grid gap-1 text-xs text-muted sm:grid-cols-2">
            <div>Quelle: <span className="text-white">{sourceQuery.data.source}</span></div>
            <div>ADM-Dateien: <span className="text-white">{sourceQuery.data.fileCount}</span></div>
            <div className="sm:col-span-2 break-all">Pfad: <span className="text-white">{sourceQuery.data.profileDir}</span></div>
            <div className="sm:col-span-2">Aktuell: <span className="text-white">{sourceQuery.data.timeZone ?? 'nicht gesetzt'}</span></div>
          </div>

          {!sourceQuery.data.timeZone && (
            <p className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
              Keine IANA-Zeitzone gesetzt. ADM-Wanduhrzeiten werden sonst wie UTC interpretiert und Discord kann dadurch eine zusätzliche lokale Verschiebung anzeigen.
            </p>
          )}

          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <label className="min-w-0 flex-1 text-sm text-muted">
              IANA-Zeitzone
              <Input
                className="mt-1 w-full"
                list={`adm-time-zones-${slot}`}
                value={timeZone}
                onChange={event => setTimeZone(event.target.value)}
                placeholder="z. B. Europe/Berlin"
                autoComplete="off"
              />
              <datalist id={`adm-time-zones-${slot}`}>
                {COMMON_TIME_ZONES.map(zone => <option key={zone} value={zone} />)}
              </datalist>
            </label>
            <Button onClick={() => void save()} loading={saving} disabled={saving || !dirty}>
              Zeitzone speichern
            </Button>
          </div>

          <p className="text-[11px] text-muted">
            Keine feste Stundenkorrektur: Sommer-/Winterzeit wird über die IANA-Zeitzone berechnet. Beim Wechsel bleibt der ADM-Byte-Cursor bestehen; historische Ereignisse werden nicht erneut ausgespielt.
          </p>
        </div>
      )}
    </Card>
  );
}
