/**
 * Step-Up-Auth-Modal (UI-Skeleton).
 *
 * Geplant fuer Phase P2 (Incident-Response-Console + sensitive Mutationen).
 * Erzwingt vor der Aktion:
 *   1) Re-Confirm via Passwort ODER TOTP (sobald Backend MFA hat),
 *   2) Pflicht-"Reason" (Audit-Trail-Begruendung),
 *   3) Diff-Preview (was passiert, in machine-readable + human-readable Form),
 *   4) Optional: Idempotency-Key (X-Idempotency-Key) wird vom Aufrufer
 *      gesetzt, hier nur sichtbar als read-only Indikator.
 *
 * Aktuell ist die UI komplett, der Confirm-Button leitet das eingegebene
 * Reason + Re-Auth an `onConfirm` weiter — die echte Auth-Pruefung
 * passiert serverseitig (P0/P1/P2 Backend).
 */
import { useEffect, useId, useState } from 'react';
import { ShieldAlert, KeyRound, FileDiff, Hash } from 'lucide-react';
import { Modal } from './Modal';
import { Button } from './Button';
import { Input } from './Input';
import { Badge } from './Badge';
import { Kbd } from './Kbd';

export interface StepUpRequest {
  /** Aktion-Bezeichner (audit kind, z. B. "ai.killSwitch"). */
  action: string;
  /** Menschen-lesbarer Titel ("AI Kill-Switch aktivieren"). */
  title: string;
  /** Lange Beschreibung der Konsequenz. */
  description: string;
  /** Severity der Aktion (steuert Akzentfarbe). */
  severity?: 'warn' | 'danger';
  /** Optional: maschinenlesbarer Diff (zeigbar als JSON). */
  diff?: Record<string, unknown>;
  /** Optional: Auto-Expire-Hinweis ("Wird nach 1h automatisch aufgehoben"). */
  autoExpireNote?: string;
  /** Optional: vorgenerierter Idempotency-Key (read-only). */
  idempotencyKey?: string;
}

interface StepUpModalProps {
  open: boolean;
  onClose: () => void;
  request: StepUpRequest | null;
  /** Wird mit Reason + (Passwort|TOTP) aufgerufen — Caller fuehrt API-Call aus. */
  onConfirm: (payload: { reason: string; reAuth: string }) => Promise<void> | void;
  /** Loading-Indikator vom Caller (waehrend API-Call). */
  loading?: boolean;
}

export function StepUpModal({ open, onClose, request, onConfirm, loading }: StepUpModalProps) {
  const [reason, setReason] = useState('');
  const [reAuth, setReAuth] = useState('');
  const [showDiff, setShowDiff] = useState(false);
  const descId = useId();

  // Reset bei Open/Close
  useEffect(() => {
    if (!open) { setReason(''); setReAuth(''); setShowDiff(false); }
  }, [open]);

  if (!request) return null;
  const sev: 'warn' | 'danger' = request.severity ?? 'warn';
  const canConfirm = reason.trim().length >= 6 && reAuth.length >= 4 && !loading;

  return (
    <Modal
      open={open}
      onClose={() => { if (!loading) onClose(); }}
      title={request.title}
      desc={request.description}
      preventBackdropClose
      ariaDescribedBy={descId}
      footer={
        <>
          <Button variant="ghost" onClick={() => onClose()} disabled={loading}>Abbrechen</Button>
          <Button
            variant={sev === 'danger' ? 'danger' : 'primary'}
            disabled={!canConfirm}
            loading={loading}
            onClick={() => { void onConfirm({ reason: reason.trim(), reAuth }); }}
          >
            Bestaetigen <Kbd className="ml-1">⏎</Kbd>
          </Button>
        </>
      }
    >
      <div id={descId} className="space-y-4">
        <div className="flex items-center gap-2">
          <Badge variant={sev === 'danger' ? 'danger' : 'warn'} pulse>
            <ShieldAlert className="h-3 w-3" /> Step-Up Required
          </Badge>
          <Badge variant="neutral">{request.action}</Badge>
          {request.autoExpireNote && (
            <Badge variant="info">Auto-Expire: {request.autoExpireNote}</Badge>
          )}
        </div>

        <div>
          <label className="block text-[11px] uppercase tracking-wider text-muted mb-1.5">
            Begruendung <span className="text-danger">*</span>
            <span className="ml-1 normal-case tracking-normal">(Audit-Trail, min 6 Zeichen)</span>
          </label>
          <Input
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder="z. B. Provider-Ausfall, Fallback erzwingen…"
            autoFocus
            maxLength={500}
          />
          <div className="text-right text-[10px] text-muted mt-0.5">{reason.length}/500</div>
        </div>

        <div>
          <label className="block text-[11px] uppercase tracking-wider text-muted mb-1.5">
            <KeyRound className="h-3 w-3 inline mr-1" />
            Re-Auth (Passwort oder TOTP-Code) <span className="text-danger">*</span>
          </label>
          <Input
            type="password"
            value={reAuth}
            onChange={e => setReAuth(e.target.value)}
            placeholder="••••••••"
            autoComplete="current-password"
          />
        </div>

        {request.diff && (
          <div>
            <button
              type="button"
              onClick={() => setShowDiff(s => !s)}
              className="text-[11px] inline-flex items-center gap-1.5 text-muted hover:text-white focus-ring rounded"
            >
              <FileDiff className="h-3 w-3" /> Diff-Preview {showDiff ? 'ausblenden' : 'anzeigen'}
            </button>
            {showDiff && (
              <pre className="mt-2 text-[11px] leading-4 p-2.5 rounded bg-bg-subtle border border-white/[0.06] overflow-auto max-h-40 font-mono text-white/85">
                {JSON.stringify(request.diff, null, 2)}
              </pre>
            )}
          </div>
        )}

        {request.idempotencyKey && (
          <div className="flex items-center gap-2 text-[10px] text-muted">
            <Hash className="h-3 w-3" />
            <span>Idempotency-Key:</span>
            <code className="font-mono text-white/70">{request.idempotencyKey}</code>
          </div>
        )}
      </div>
    </Modal>
  );
}
