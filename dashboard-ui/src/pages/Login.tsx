import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/Button';

export default function Login() {
  const { user, loading } = useAuth();
  const nav = useNavigate();

  useEffect(() => {
    if (!loading && user) nav('/servers', { replace: true });
  }, [loading, user, nav]);

  function startOAuth(): void {
    window.location.href = '/auth/discord';
  }

  return (
    <div className="min-h-full grid place-items-center px-4 py-10 relative overflow-hidden">
      {/* Pulsing Glow Backdrop */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-32 left-1/2 -translate-x-1/2 h-[480px] w-[480px] rounded-full bg-accent/20 blur-3xl animate-pulseGlow"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute bottom-0 right-0 h-[300px] w-[300px] rounded-full bg-accent-dim/30 blur-3xl"
      />

      <div className="glass relative z-10 max-w-md w-full rounded-2xl p-8 sm:p-10 shadow-card animate-fade-in border border-border">
        <div className="flex flex-col items-center text-center">
          <span className="v-logo text-6xl sm:text-7xl font-extrabold tracking-tighter mb-4">V</span>
          <h1 className="text-2xl sm:text-3xl font-bold text-white mb-2">V&#8209;Bot Dashboard</h1>
          <p className="text-muted text-sm sm:text-base mb-8 max-w-xs">
            Server&#8209;Verwaltung &middot; Nitrado&#8209;Steuerung &middot; Live&#8209;Monitoring
          </p>
          <Button onClick={startOAuth} className="w-full" size="lg" disabled={loading}>
            {loading ? 'Pruefe Session…' : 'Mit Discord anmelden'}
          </Button>
          <p className="text-xs text-muted mt-6">
            Mit dem Login akzeptierst du, dass deine Discord&#8209;ID, dein Name und dein Avatar gespeichert werden.
          </p>
        </div>
      </div>
    </div>
  );
}
