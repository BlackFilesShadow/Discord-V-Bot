/**
 * Bot-Admin-Login-Panel — kompakte Inline-Variante fuer die Topbar.
 *
 * Position: oben links NEBEN dem DEV-Login-Panel (eingebettet in Shell).
 * Verhalten:
 *   - Loading  → kleines "ADMIN …"-Pill
 *   - Inaktiv  → schmales Passwort-Input + Submit-Button (immer)
 *   - Aktiv    → "ADMIN ON"-Pill mit Restzeit + Logout-Icon
 *
 * Kein localStorage; Session wird serverseitig validiert
 * (POST /api/v2/bot-admin/login, Passwort = BOT_ADMIN_PASSWORD, Default "ASH").
 */
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShieldAlert, LogOut, KeyRound, Check, Loader2 } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useBotAdminSession } from '@/lib/botAdminSession';
import { ApiError } from '@/lib/api';

export function BotAdminLoginPanel() {
  const { user } = useAuth();
  const { active, loading, login, logout, expiresAt } = useBotAdminSession();
  const navigate = useNavigate();
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!user) return null;

  const onSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!pw || busy) return;
    setBusy(true); setErr(null);
    try {
      await login(pw);
      setPw('');
      navigate('/bot-admin');
    } catch (ex) {
      setErr(ex instanceof ApiError ? ex.message : 'Unbekannter Fehler');
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
        data-testid="botadmin-login-panel"
        className="status-pill"
        data-state="warn"
        title="Bot-Admin-Status wird geprueft"
      >
        <Loader2 className="h-3 w-3 animate-spin" />
        ADMIN
      </span>
    );
  }

  // ── Aktiv: kompakte Pille + Logout ────────────────────────────────────
  if (active) {
    const expLabel = expiresAt ? new Date(expiresAt).toLocaleTimeString() : 'Aktiv';
    return (
      <span
        data-testid="botadmin-login-panel"
        className="inline-flex items-center gap-1"
      >
        <span
          className="status-pill"
          data-state="ok"
          title={`Bot-Admin-Session aktiv bis ${expLabel}`}
        >
          <span className="relative inline-flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full rounded-full bg-current opacity-60 animate-ping" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
          </span>
          ADMIN
        </span>
        <button
          type="button"
          onClick={onLogout}
          disabled={busy}
          title="Bot-Admin-Session beenden"
          aria-label="Bot-Admin-Session beenden"
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
  return (
    <form
      data-testid="botadmin-login-panel"
      onSubmit={onSubmit}
      autoComplete="off"
      className="relative inline-flex items-center"
      aria-label="Bot-Admin-Login"
    >
      {/* Dummy-Felder gegen Browser-Autofill. */}
      <input type="text" name="username" autoComplete="username" className="hidden" tabIndex={-1} aria-hidden />
      <div
        className={
          'inline-flex items-center h-8 rounded-md border bg-black/40 ' +
          'pl-2 pr-1 gap-1 transition-colors ' +
          (err
            ? 'border-danger/60 focus-within:border-danger'
            : 'border-indigo-900/50 focus-within:border-indigo-500/80')
        }
      >
        <KeyRound className="h-3.5 w-3.5 text-indigo-400/90 shrink-0" aria-hidden />
        <label htmlFor="botadmin-pw" className="sr-only">Bot-Admin Passwort</label>
        <input
          id="botadmin-pw"
          type="password"
          value={pw}
          onChange={e => { setPw(e.target.value); if (err) setErr(null); }}
          disabled={busy}
          placeholder="Bot Admin Passwort"
          autoComplete="new-password"
          aria-invalid={err ? true : false}
          aria-describedby={err ? 'botadmin-pw-err' : undefined}
          className="bg-transparent outline-none text-xs text-white placeholder:text-muted/70
                     w-[150px] sm:w-[170px] h-7"
        />
        <button
          type="submit"
          disabled={!pw || busy}
          title="Entsperren"
          aria-label="Bot-Admin entsperren"
          className="inline-flex items-center justify-center h-6 w-6 rounded
                     bg-gradient-to-br from-indigo-600 to-indigo-800
                     hover:from-indigo-500 hover:to-indigo-700
                     shadow-[0_0_10px_rgba(99,102,241,0.45)]
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
          id="botadmin-pw-err"
          role="alert"
          className="absolute top-full left-0 mt-1 z-50 max-w-[260px]
                     rounded-md border border-danger/60 bg-[#08081a]/95
                     backdrop-blur px-2 py-1.5 text-[11px] text-danger
                     shadow-[0_8px_24px_-6px_rgba(0,0,0,0.7)]"
        >
          <ShieldAlert className="inline h-3 w-3 mr-1 -mt-0.5" />
          {err}
        </div>
      )}
    </form>
  );
}
