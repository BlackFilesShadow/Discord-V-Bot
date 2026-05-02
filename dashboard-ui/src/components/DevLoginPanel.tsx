/**
 * DEV-Login-Panel (Spec 1: Page 1 unten links).
 *
 * - Sichtbar nur fuer User mit role===DEVELOPER (Spec 5).
 * - Status-Anzeige: Locked / Unlocked.
 * - Fehler werden rot, exakt und mit role=alert angezeigt (Spec 9).
 * - Bei aktiver Session: Logout + Link zur DEV-Konsole.
 * - Kein localStorage; Session wird serverseitig validiert (Spec 3).
 */
import { useState, type FormEvent } from 'react';
import { Lock, Unlock, ShieldAlert, Terminal, LogOut } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { useDevSession } from '@/lib/devSession';
import { ApiError } from '@/lib/api';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';

export function DevLoginPanel() {
  const { user } = useAuth();
  const { active, eligible, loading, login, logout, expiresAt } = useDevSession();
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!user || user.role !== 'DEVELOPER') return null;

  const onSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await login(pw);
      setPw('');
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

  return (
    <aside
      aria-label="DEV Login Panel"
      className="fixed bottom-4 left-4 z-30 w-[300px] max-w-[calc(100vw-2rem)]
                 rounded-xl border border-border bg-bg-card/85 backdrop-blur-md
                 shadow-[0_8px_32px_rgba(0,0,0,0.5)] p-4"
    >
      <header className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-white">
          <Terminal className="h-4 w-4 text-accent" />
          <span>DEV Login</span>
        </div>
        <StatusBadge active={active} loading={loading} eligible={eligible} />
      </header>

      {!eligible && !loading && (
        <p className="text-xs text-muted">
          <ShieldAlert className="inline h-3 w-3 mr-1" />
          Dein Account hat keine DEVELOPER-Rolle.
        </p>
      )}

      {eligible && !active && (
        <form onSubmit={onSubmit} className="space-y-2" autoComplete="off">
          <label htmlFor="dev-pw" className="sr-only">DEV Passwort</label>
          <Input
            id="dev-pw"
            type="password"
            autoComplete="off"
            value={pw}
            onChange={e => { setPw(e.target.value); if (err) setErr(null); }}
            placeholder="Passwort"
            aria-invalid={err ? true : false}
            aria-describedby={err ? 'dev-pw-err' : undefined}
            disabled={busy}
          />
          {err && (
            <p
              id="dev-pw-err"
              role="alert"
              className="text-[11px] text-danger font-medium border border-danger/40 bg-danger/10 rounded px-2 py-1"
            >
              {err}
            </p>
          )}
          <Button type="submit" loading={busy} disabled={!pw || busy} className="w-full" size="sm">
            Login
          </Button>
        </form>
      )}

      {eligible && active && (
        <div className="space-y-2">
          <p className="text-[11px] text-muted">
            {expiresAt
              ? <>Aktiv bis <span className="text-white font-mono">{new Date(expiresAt).toLocaleTimeString()}</span></>
              : 'Aktiv'}
          </p>
          <div className="flex gap-2">
            <Link to="/dev" className="flex-1">
              <Button size="sm" className="w-full">DEV Tools</Button>
            </Link>
            <Button size="sm" variant="ghost" onClick={onLogout} disabled={busy} title="Logout">
              <LogOut className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}
    </aside>
  );
}

function StatusBadge({ active, loading, eligible }: { active: boolean; loading: boolean; eligible: boolean }) {
  if (loading) {
    return <span className="text-[10px] px-2 py-0.5 rounded-full bg-bg-elev text-muted">…</span>;
  }
  if (!eligible) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-bg-elev text-muted">
        <Lock className="h-3 w-3" /> N/A
      </span>
    );
  }
  if (active) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-ok/15 text-ok font-medium border border-ok/30">
        <Unlock className="h-3 w-3" /> Unlocked
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-danger/15 text-danger font-medium border border-danger/30">
      <Lock className="h-3 w-3" /> Locked
    </span>
  );
}
