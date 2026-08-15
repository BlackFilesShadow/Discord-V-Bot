import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';

const apiBase = '/api/v2/dev/secure-export';

type ExportKind = 'packages' | 'user' | 'logs';

function idempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function filenameFromHeader(value: string | null, fallback: string): string {
  if (!value) return fallback;
  const match = value.match(/filename="?([^";]+)"?/i);
  return match?.[1] || fallback;
}

async function downloadJson(path: string, body: Record<string, unknown>, fallbackName: string): Promise<void> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Idempotency-Key': idempotencyKey(),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    let message = `HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch { if (text) message = text; }
    throw new Error(message);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filenameFromHeader(response.headers.get('content-disposition'), fallbackName);
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

export default function SecureDevExport() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const rawKind = params.get('kind');
  const kind: ExportKind | null = rawKind === 'packages' || rawKind === 'user' || rawKind === 'logs' ? rawKind : null;
  const discordId = params.get('discordId') ?? '';
  const category = (params.get('category') ?? 'ALL').toUpperCase();
  const days = Math.max(1, Math.min(365, Number(params.get('days') ?? 30) || 30));
  const [reason, setReason] = useState('Sensibler DEV-Export');
  const [reAuth, setReAuth] = useState('');
  const [busy, setBusy] = useState(false);

  const description = useMemo(() => {
    if (kind === 'packages') return `Paketdaten für Discord-ID ${discordId}`;
    if (kind === 'user') return `GDPR-/Nutzerdaten für Discord-ID ${discordId}`;
    if (kind === 'logs') return `Audit-Logs: ${category}, letzte ${days} Tage`;
    return 'Unbekanntes Exportziel';
  }, [kind, discordId, category, days]);

  const run = async () => {
    if (!kind) { toast.error('Ungültiges Exportziel'); return; }
    if (reason.trim().length < 6) { toast.error('Begründung muss mindestens 6 Zeichen haben'); return; }
    if (reAuth.trim().length < 4) { toast.error('Re-Auth / TOTP fehlt'); return; }
    setBusy(true);
    try {
      if (kind === 'packages') {
        await downloadJson(`${apiBase}/packages/${encodeURIComponent(discordId)}`, { reason, reAuth }, 'pakete.json');
      } else if (kind === 'user') {
        await downloadJson(`${apiBase}/user/${encodeURIComponent(discordId)}`, { reason, reAuth }, 'nutzerdaten.json');
      } else {
        await downloadJson(`${apiBase}/logs`, { category, days, reason, reAuth }, 'audit_logs.json');
      }
      setReAuth('');
      toast.success('Export erfolgreich erstellt');
    } catch (error) {
      toast.error('Export fehlgeschlagen', (error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card glow>
        <h1 className="text-lg font-semibold">Sicherer DEV-Export</h1>
        <p className="text-sm text-muted mt-1">Sensible Daten werden nur nach erneuter serverseitiger Authentisierung ausgegeben.</p>
      </Card>
      <Card glow>
        <div className="space-y-3">
          <div><span className="text-xs text-muted">Export</span><div className="font-medium">{description}</div></div>
          <Input value={reason} onChange={e => setReason(e.target.value)} placeholder="Begründung (mind. 6 Zeichen)" />
          <Input value={reAuth} onChange={e => setReAuth(e.target.value)} type="password" placeholder="TOTP bei aktiver 2FA, sonst DEV-Passwort" autoComplete="one-time-code" />
          <p className="text-xs text-muted">Das Re-Auth-Geheimnis wird ausschließlich im POST-Body übertragen, nie in URL, Downloadname oder Audit-Log.</p>
          <div className="flex gap-2">
            <Button onClick={run} loading={busy} disabled={!kind || !reAuth}>Export freigeben</Button>
            <Button variant="ghost" onClick={() => navigate('/dev/command-center')}>Abbrechen</Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
