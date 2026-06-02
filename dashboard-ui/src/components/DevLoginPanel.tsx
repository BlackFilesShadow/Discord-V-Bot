/**
 * DEV-Login-Panel — kompakte Inline-Variante fuer die Topbar.
 *
 * Position: oben links neben der DEV-Status-Pille (eingebettet in Shell).
 * Verhalten:
 *   - Loading            → kleines "DEV …"-Pill
 *   - Inaktiv            → schmales Passwort-Input + Submit-Button (immer)
 *   - Aktiv              → "DEV ON"-Pill mit Restzeit + Logout-Icon
 *
 * Errors werden als Tooltip-Text unter dem Feld dargestellt (role=alert).
 * Kein localStorage; Session wird serverseitig validiert.
 */
import { useState, type FormEvent } from 'react';
import { ShieldAlert, LogOut, KeyRound, Check, Loader2, Lock } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useDevSession } from '@/lib/devSession';
import { ApiError } from '@/lib/api';

export function DevLoginPanel() {
  const { user } = useAuth();
  const { active, loading, login, logout, expiresAt } = useDevSession();
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [errCode, setErrCode] = useState<string | null>(null);

  if (!user) return null;

  const onSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!pw || busy) return;
    setBusy(true); setErr(null); setErrCode(null);
    try {
      await login(pw);
      setPw('');
    } catch (ex) {
      // Passwortfeld bei fehlgeschlagenem Login leeren, damit kein
      // (falsches) Geheimnis im DOM-Wert verbleibt.
      setPw('');
      if (ex instanceof ApiError) {
        setErr(ex.message);
        setErrCode(ex.code ?? null);
      } else {
        setErr('Unbekannter Fehler');
      }
    } finally {
      setBusy(false);
    }
  };

  const onLogout = async (): Promise<void> => {
    setBusy(true); setErr(null);
    try { await logout(); } finally { setBusy(false); }
  };

  // ── Loading ───────────────────────────────────────────────────────────
  if (loading) {
    return (
      <span
        data-testid="dev-login-panel"
        className="status-pill"
        data-state="warn"
        title="DEV-Status wird geprueft"
      >
        <Loader2 className="h-3 w-3 animate-spin" />
        DEV
      </span>
    );
  }

  // ── Aktiv: kompakte Pille + Logout ────────────────────────────────────
  if (active) {
    const expLabel = expiresAt ? new Date(expiresAt).toLocaleTimeString() : 'Aktiv';
    return (
      <span
        data-testid="dev-login-panel"
        className="inline-flex items-center gap-1"
      >
        <span
          className="status-pill"
          data-state="ok"
          title={`DEV-Session aktiv bis ${expLabel}`}
        >
          <span className="relative inline-flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full rounded-full bg-current opacity-60 animate-ping" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
          </span>
          DEV
        </span>
        <button
          type="button"
          onClick={onLogout}
          disabled={busy}
          title="DEV-Session beenden"
          aria-label="DEV-Session beenden"
          className="inline-flex items-center justify-center h-7 w-7 rounded-md
                     text-muted hover:text-white hover:bg-bg-elev focus-ring
                     disabled:opacity-50"
        >
          <LogOut className="h-3.5 w-3.5" />
        </button>
      </span>
    );
  }

  // ── Inaktiv: kompaktes Passwort-Feld + Submit ─────────────────────────
  // Form wird IMMER gezeigt (auch fuer Nicht-DEVELOPER): die eigentliche
  // Rollenpruefung passiert serverseitig in POST /api/v2/dev/login. So
  // sieht der User nicht "DEV N/A" bevor er es ueberhaupt versucht hat.
  return (
    <form
      data-testid="dev-login-panel"
      onSubmit={onSubmit}
      autoComplete="off"
      className="relative flex w-full flex-wrap items-center gap-y-1 md:inline-flex md:flex-nowrap md:w-auto"
      aria-label="DEV-Console-Login"
    >
      {/* Dummy-Feld gegen Browser-Autofill. */}
      <input type="text" name="username" autoComplete="username" className="hidden" tabIndex={-1} aria-hidden />
      {/* Gesperrt-Indikator: rot, bis das korrekte Passwort eine DEV-Session
          freischaltet (dann gruene "DEV ON"-Pille im active-Zweig oben). */}
      <span
        className="status-pill mr-1.5 shrink-0"
        data-state="danger"
        title="DEV gesperrt — Passwort eingeben"
      >
        <Lock className="h-3 w-3" aria-hidden /> DEV
      </span>
      <div
        className={
          'flex flex-1 min-w-0 items-center h-11 rounded-md border bg-black/40 ' +
          'md:inline-flex md:w-auto md:h-8 ' +
          'pl-2 pr-1 gap-1 transition-colors ' +
          (err
            ? 'border-danger/60 focus-within:border-danger'
            : 'border-red-900/50 focus-within:border-red-500/80')
        }
      >
        <KeyRound className="h-3.5 w-3.5 text-red-400/90 shrink-0" aria-hidden />
        <label htmlFor="dev-pw" className="sr-only">DEV Passwort</label>
        <input
          id="dev-pw"
          type="password"
          value={pw}
          onChange={e => { setPw(e.target.value); if (err) setErr(null); }}
          disabled={busy}
          placeholder="DEV Passwort"
          autoComplete="new-password"
          aria-invalid={err ? true : false}
          aria-describedby={err ? 'dev-pw-err' : undefined}
          className="bg-transparent outline-none text-sm md:text-xs text-white placeholder:text-muted/70
                     flex-1 w-full h-10 md:flex-none md:w-[160px] md:h-7"
        />
        <button
          type="submit"
          disabled={!pw || busy}
          title="Entsperren"
          aria-label="DEV-Console entsperren"
          className="inline-flex items-center justify-center h-9 w-9 md:h-6 md:w-6 rounded
                     bg-gradient-to-br from-red-600 to-red-800
                     hover:from-red-500 hover:to-red-700
                     shadow-[0_0_10px_rgba(239,68,68,0.45)]
                     disabled:opacity-40 disabled:cursor-not-allowed
                     text-white focus-ring"
        >
          {busy
            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
            : <Check className="h-3.5 w-3.5" strokeWidth={3} />}
        </button>
      </div>
      {err && (
        <div
          id="dev-pw-err"
          role="alert"
          className="relative mt-1 w-full z-50 max-w-full
                     md:absolute md:top-full md:left-0 md:mt-1 md:w-auto md:max-w-[260px]
                     rounded-md border border-danger/60 bg-[#1a0608]/95
                     backdrop-blur px-2 py-1.5 text-[11px] text-danger
                     shadow-[0_8px_24px_-6px_rgba(0,0,0,0.7)]"
        >
          <ShieldAlert className="inline h-3 w-3 mr-1 -mt-0.5" />
          {err}
          {errCode === 'DEV_MFA_REQUIRED' && (
            <a
              href="/profile/security"
              className="block mt-1 underline text-danger-300 hover:text-danger-200"
            >
              2FA jetzt einrichten →
            </a>
          )}
          {errCode === 'DEV_IP_DENIED' && (
            <span className="block mt-1 text-muted">
              Deine IP ist nicht in der DEV-Allowlist.
            </span>
          )}
        </div>
      )}
    </form>
  );
}
