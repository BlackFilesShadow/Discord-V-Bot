/**
 * DEV-Login-Panel (Spec 1: Page 1 unten links).
 *
 * - Sichtbar nur fuer User mit role===DEVELOPER (Spec 5).
 * - Status-Anzeige: Locked / Unlocked.
 * - Fehler werden rot, exakt und mit role=alert angezeigt (Spec 9).
 * - Bei aktiver Session: Logout + Link zur DEV-Konsole.
 * - Kein localStorage; Session wird serverseitig validiert (Spec 3).
 *
 * Visual: V-Bot Schwarz/Rot HIGH-END mit Gradient-Border + Pulse-Glow.
 * Position: fixed bottom-6 left-6 (PC-Sicht naeher heran), w-[360px].
 * Wird global in App.tsx gemountet, NICHT auf /login.
 */
import { useState, type FormEvent } from 'react';
import { Lock, Unlock, ShieldAlert, Terminal, LogOut, Zap } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { useDevSession } from '@/lib/devSession';
import { ApiError } from '@/lib/api';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';

export function DevLoginPanel() {
  const { user } = useAuth();
  const { active, eligible, loading, login, logout, expiresAt } = useDevSession();
  const { pathname } = useLocation();
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [errCode, setErrCode] = useState<string | null>(null);

  // Auf der /login-Route nicht rendern (kein Overlay ueber dem Login-Form).
  if (pathname.startsWith('/login')) return null;
  // Nur wenn ein User eingeloggt ist (sonst gibt's nichts zum DEV-Login).
  // Eigentliche Permission wird serverseitig in /api/v2/dev/login geprueft;
  // hier zeigen wir das Panel auch fuer Nicht-DEVELOPER mit Hinweis-Text.
  if (!user) return null;

  const onSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true); setErr(null); setErrCode(null);
    try {
      await login(pw);
      setPw('');
    } catch (ex) {
      if (ex instanceof ApiError) {
        setErr(ex.message);
        setErrCode(ex.code);
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

  return (
    <aside
      aria-label="DEV Login Panel"
      data-testid="dev-login-panel"
      className="fixed bottom-6 left-6 z-50 w-[360px] max-w-[calc(100vw-3rem)]
                 animate-fade-in"
    >
      {/* Gradient-Border-Wrapper (V-Bot Rot Akzent) */}
      <div
        className={
          'rounded-2xl p-[1.5px] shadow-[0_18px_60px_-12px_rgba(0,0,0,0.85)] ' +
          (active
            ? 'bg-gradient-to-br from-red-500/70 via-red-700/40 to-red-900/80 animate-pulse-glow'
            : 'bg-gradient-to-br from-red-500/80 via-red-700/50 to-black')
        }
      >
        <div
          className="rounded-[14px] bg-gradient-to-b from-[#0a0a0f]/97 to-[#050507]/97
                     backdrop-blur-xl px-5 pt-4 pb-5 relative overflow-hidden"
        >
          {/* Top accent shimmer line */}
          <div
            className="pointer-events-none absolute inset-x-0 top-0 h-[2px]
                       bg-gradient-to-r from-transparent via-red-500/80 to-transparent"
          />
          {/* Hintergrund-Glow Top-Left */}
          <div
            className="pointer-events-none absolute -top-16 -left-16 h-40 w-40 rounded-full
                       bg-red-600/15 blur-3xl"
          />

          <header className="relative flex items-center justify-between mb-4">
            <div className="flex items-center gap-2.5">
              <div
                className="grid place-items-center h-9 w-9 rounded-lg
                           bg-gradient-to-br from-red-500 to-red-900
                           shadow-[0_0_18px_rgba(239,68,68,0.55)]"
              >
                <Terminal className="h-4 w-4 text-white" strokeWidth={2.5} />
              </div>
              <div className="flex flex-col leading-tight">
                <span className="text-[10px] uppercase tracking-[0.22em] text-red-400/90 font-bold">
                  V-Bot · DEV
                </span>
                <span className="text-[15px] font-semibold text-white">Console Access</span>
              </div>
            </div>
            <StatusBadge active={active} loading={loading} eligible={eligible} />
          </header>

          {!active && (
            <form onSubmit={onSubmit} className="relative space-y-2.5" autoComplete="off">
              <label htmlFor="dev-pw" className="sr-only">DEV Passwort</label>
              <Input
                id="dev-pw"
                type="password"
                autoComplete="off"
                value={pw}
                onChange={e => { setPw(e.target.value); if (err) setErr(null); }}
                placeholder="DEV Passwort eingeben"
                aria-invalid={err ? true : false}
                aria-describedby={err ? 'dev-pw-err' : undefined}
                disabled={busy}
                className="h-10 text-sm bg-black/60 border-red-900/40 focus:border-red-500
                           focus:ring-1 focus:ring-red-500/40 placeholder:text-muted/70"
              />
              {!eligible && !loading && (
                <p className="text-[11px] text-muted leading-snug
                              border border-border/50 bg-bg-elev/40 rounded-lg px-2.5 py-1.5">
                  <ShieldAlert className="inline h-3 w-3 mr-1 text-warn" />
                  Hinweis: Dein Account hat (laut Server) keine DEVELOPER-Rolle.
                  Login wird beim Absenden serverseitig geprueft.
                </p>
              )}
              {err && (
                <p
                  id="dev-pw-err"
                  role="alert"
                  className="text-[11px] text-danger font-medium border border-danger/50
                             bg-danger/10 rounded-lg px-2.5 py-1.5"
                >
                  {err}
                  {errCode === 'DEV_MFA_REQUIRED' && (
                    <>
                      {' '}
                      <Link
                        to="/profile/security"
                        className="underline text-danger-300 hover:text-danger-200 font-semibold"
                      >
                        2FA jetzt einrichten →
                      </Link>
                    </>
                  )}
                  {errCode === 'DEV_IP_DENIED' && (
                    <span className="block mt-1 text-muted">
                      Deine IP ist nicht in der DEV-Allowlist. Wende dich an einen SUPER_ADMIN.
                    </span>
                  )}
                </p>
              )}
              <Button
                type="submit"
                loading={busy}
                disabled={!pw || busy}
                className="w-full h-10 bg-gradient-to-r from-red-600 to-red-800
                           hover:from-red-500 hover:to-red-700 border-0
                           shadow-[0_0_22px_rgba(239,68,68,0.35)]
                           hover:shadow-[0_0_30px_rgba(239,68,68,0.55)]
                           transition-all font-semibold tracking-wide"
                size="sm"
              >
                <Zap className="h-4 w-4 mr-1.5" />
                Entsperren
              </Button>
            </form>
          )}

          {active && (
            <div className="relative space-y-3">
              <p className="text-[11px] text-muted">
                {expiresAt
                  ? <>Aktiv bis <span className="text-red-300 font-mono font-semibold">{new Date(expiresAt).toLocaleTimeString()}</span></>
                  : <span className="text-red-300 font-semibold">Aktiv</span>}
              </p>
              <div className="flex gap-2">
                <Link to="/dev" className="flex-1">
                  <Button
                    size="sm"
                    className="w-full h-10 bg-gradient-to-r from-red-600 to-red-800
                               hover:from-red-500 hover:to-red-700 border-0
                               shadow-[0_0_22px_rgba(239,68,68,0.35)]
                               font-semibold tracking-wide"
                  >
                    <Terminal className="h-4 w-4 mr-1.5" />
                    DEV Tools
                  </Button>
                </Link>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={onLogout}
                  disabled={busy}
                  title="Logout"
                  className="h-10 w-10 px-0 border border-red-900/40 hover:bg-red-950/40 hover:border-red-700"
                >
                  <LogOut className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

function StatusBadge({ active, loading, eligible }: { active: boolean; loading: boolean; eligible: boolean }) {
  if (loading) {
    return (
      <span className="inline-flex items-center text-[10px] px-2.5 py-1 rounded-full
                       bg-bg-elev/70 text-muted font-medium border border-border">
        …
      </span>
    );
  }
  if (!eligible) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] px-2.5 py-1 rounded-full
                       bg-bg-elev/70 text-muted font-medium border border-border">
        <Lock className="h-3 w-3" /> N/A
      </span>
    );
  }
  if (active) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] px-2.5 py-1 rounded-full
                       bg-emerald-500/15 text-emerald-300 font-bold uppercase tracking-wider
                       border border-emerald-500/40 shadow-[0_0_12px_rgba(16,185,129,0.35)]">
        <Unlock className="h-3 w-3" /> Unlocked
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] px-2.5 py-1 rounded-full
                     bg-red-600/20 text-red-300 font-bold uppercase tracking-wider
                     border border-red-500/50 shadow-[0_0_14px_rgba(239,68,68,0.45)]">
      <Lock className="h-3 w-3" /> Locked
    </span>
  );
}
