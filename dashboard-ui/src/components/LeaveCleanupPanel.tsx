import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DatabaseZap, Save, ShieldAlert } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Card, CardDesc, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Switch } from '@/components/ui/Switch';
import { Badge } from '@/components/ui/Badge';
import { useToast } from '@/components/ui/Toast';

interface DashboardOwnerState {
  isOwner: boolean;
  permissions: string[];
}

interface LeaveCleanupConfigState {
  configured: boolean;
  deletePlayerDataOnLeave: boolean;
}

interface LeaveCleanupPanelProps {
  guildId: string;
  embedded?: boolean;
}

export function LeaveCleanupPanel({ guildId, embedded = false }: LeaveCleanupPanelProps) {
  const qc = useQueryClient();
  const toast = useToast();
  const ownerQ = useQuery({
    queryKey: ['dashboard', guildId],
    queryFn: () => api.get<DashboardOwnerState>(`/api/v2/guilds/${guildId}/dashboard`),
    enabled: !!guildId,
  });
  const isOwner = ownerQ.data?.isOwner === true;
  const hasFullAccess = isOwner || ownerQ.data?.permissions?.includes('dashboard.access') === true;
  const cfgQ = useQuery({
    queryKey: ['leave-cleanup', guildId],
    queryFn: () => api.get<LeaveCleanupConfigState>(`/api/v2/guilds/${guildId}/leave-cleanup/config`),
    enabled: !!guildId && hasFullAccess,
  });

  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (cfgQ.data) setEnabled(cfgQ.data.deletePlayerDataOnLeave);
  }, [cfgQ.data]);

  if (ownerQ.isLoading) {
    return embedded
      ? <div className="h-24 rounded-lg skeleton" data-testid="goodbye-leave-cleanup-loading" />
      : <div className="h-40 rounded-xl skeleton" />;
  }

  if (!hasFullAccess) {
    if (!embedded) return null;
    return (
      <div
        className="rounded-lg border border-border/60 bg-bg-elev/35 p-3 sm:p-4"
        data-testid="goodbye-leave-cleanup-owner-only"
      >
        <div className="flex items-start gap-2.5">
          <ShieldAlert className="h-5 w-5 text-muted shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="text-xs font-medium text-white/90">Spieler-Cleanup</p>
            <p className="text-xs text-muted mt-1 leading-relaxed">
              Diese Austritts-Bereinigung ist weiterhin vorhanden. Ein- oder ausschalten darf sie der Discord-Server-Owner
              oder ein Mitglied mit <code>dashboard.access</code> (Vollzugriff).
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (cfgQ.isLoading) {
    return embedded
      ? <div className="h-24 rounded-lg skeleton" data-testid="goodbye-leave-cleanup-loading" />
      : <div className="h-40 rounded-xl skeleton" />;
  }

  const saved = cfgQ.data?.deletePlayerDataOnLeave ?? false;
  const changed = enabled !== saved;

  async function save() {
    if (!changed) return;
    if (enabled && !saved) {
      const ok = confirm(
        'Cleanup bei Austritt aktivieren? Bei zukünftigen Austritten wird der verifiziert zugeordnete Spieler von der Nitrado-Whitelist entfernt und seine DayZ-Gameplay-Statistik für diese Guild und diese Gameserver-Verbindung zurückgesetzt. Linking, Economy, XP, Level, Balance, Identitäts- und Moderationsdaten bleiben erhalten.',
      );
      if (!ok) return;
    }

    setBusy(true);
    try {
      await api.post(`/api/v2/guilds/${guildId}/leave-cleanup/config`, {
        deletePlayerDataOnLeave: enabled,
      });
      await qc.invalidateQueries({ queryKey: ['leave-cleanup', guildId] });
      toast.success(enabled ? 'Spielerdaten-Cleanup bei Austritt aktiviert.' : 'Neue Leave-Cleanups deaktiviert.');
    } catch (error) {
      setEnabled(saved);
      toast.error(error instanceof ApiError ? error.message : 'Leave-Cleanup-Einstellung konnte nicht gespeichert werden.');
    } finally {
      setBusy(false);
    }
  }

  const saveButton = (
    <Button
      onClick={save}
      disabled={busy || !changed}
      size={embedded ? 'sm' : undefined}
      className={embedded ? 'w-full sm:w-auto shrink-0' : 'w-full sm:w-auto'}
    >
      <Save className="h-4 w-4 mr-1" /> {busy ? 'Speichert…' : embedded ? 'Cleanup speichern' : 'Einstellung speichern'}
    </Button>
  );

  if (embedded) {
    return (
      <div
        className="rounded-lg border border-danger/35 bg-danger/5 p-3 sm:p-4 space-y-3"
        data-testid="goodbye-leave-cleanup"
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs font-medium text-white/90 inline-flex items-center gap-2">
              <DatabaseZap className="h-4 w-4 text-danger" /> Spieler-Cleanup (optional)
            </p>
            <p className="text-[11px] text-muted mt-1 leading-relaxed">
              Entfernt beim Austritt den verifiziert zugeordneten Spieler von der Nitrado-Whitelist und setzt nur die
              guild-/gameservergescoppte DayZ-Gameplay-Statistik zurück. Economy, XP, Level, Balance und Linking bleiben erhalten.
            </p>
          </div>
          <Badge variant={saved ? 'danger' : 'neutral'}>{saved ? 'EIN' : 'AUS'}</Badge>
        </div>

        <Switch
          checked={enabled}
          onChange={setEnabled}
          label="Whitelist und Spielerstatistik bei Austritt bereinigen"
        />

        <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:justify-between">
          <p className="text-[11px] text-muted">
            Owner oder <code>dashboard.access</code> (Vollzugriff). Bereits eingereihte Cleanup-Aufträge werden auch nach dem Ausschalten sicher beendet.
          </p>
          {saveButton}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-white inline-flex items-center gap-2">
          <DatabaseZap className="h-5 w-5 text-danger" /> Spielerdaten bei Austritt
        </h2>
        <p className="text-xs text-muted mt-0.5">
          Vollzugriff-Schalter für Whitelist-Entfernung und guild-/gameservergescoppten Gameplay-Statistik-Reset.
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <CardTitle>Spielerdaten loeschen</CardTitle>
              <CardDesc>Gilt pro Discord-Server und wird beim Guild-Austritt ausgewertet.</CardDesc>
            </div>
            <Badge variant={saved ? 'danger' : 'neutral'}>{saved ? 'EIN' : 'AUS'}</Badge>
          </div>
        </CardHeader>

        <div className="space-y-4 mt-2">
          <Switch
            checked={enabled}
            onChange={setEnabled}
            label="Whitelist und Spielerstatistik bei Austritt bereinigen"
          />

          <div className="rounded-lg border border-danger/35 bg-danger/5 p-3 sm:p-4">
            <div className="flex items-start gap-2.5">
              <ShieldAlert className="h-5 w-5 text-danger shrink-0 mt-0.5" />
              <div className="min-w-0 text-xs text-muted space-y-2">
                <p className="text-white/90 font-medium">Was bei EIN passiert</p>
                <p>
                  Bei AUS passiert kein Cleanup. Bei EIN entfernt der Bot den verifiziert zugeordneten DayZ-Spieler
                  von der Nitrado-Whitelist und setzt nur seine DayZ-Gameplay-Statistik für diese Guild und diese
                  Gameserver-Verbindung zurück. Der Remote-Erfolg wird technisch bestätigt.
                </p>
                <p>
                  Nicht betroffen: Discord-/Game-Linking, Economy, Wallet/Bank/Rewards, XP, Level, Balance,
                  Session-Identität außerhalb des Statistik-Resets, Moderationsdaten und sonstige Guild-Daten.
                </p>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-muted">
            <div className="rounded-lg border border-border/50 p-2.5">
              <span className="text-white/90 block">AUS</span>
              Ein Austritt startet keine Spieler-Datenloeschung.
            </div>
            <div className="rounded-lg border border-border/50 p-2.5">
              <span className="text-white/90 block">EIN</span>
              Durable Saga mit Checkpoints, Retry, Restart-Recovery und Dead-Letter.
            </div>
          </div>

          <p className="text-[11px] text-muted">
            Ausschalten verhindert neue Cleanup-Auftraege. Bereits persistent eingereihte Auftraege werden aus Konsistenzgruenden sicher zu Ende verarbeitet.
          </p>
        </div>
      </Card>

      <div className="flex flex-col sm:flex-row gap-2">
        {saveButton}
      </div>
    </div>
  );
}
