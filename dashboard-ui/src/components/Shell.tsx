/**
 * Enterprise-Shell: Sticky-Glass-Header + optionale Sidebar + Main.
 *
 * Erweitert ggue. der vorherigen Shell um:
 *   - Density-Toggle (compact|cozy|comfortable)
 *   - Command-Palette-Trigger (Cmd+K Hint sichtbar)
 *   - Status-Pill (DEV-Session aktiv?) — nur fuer DEVELOPER sichtbar
 *   - A11y-Landmark "main"
 *
 * Sidebar bleibt ein flexibler Slot (gleicher API-Vertrag wie zuvor).
 */
import { type ReactNode, useState, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  ArrowLeft, LogOut, Menu, X, Command, Rows3, Rows2, Square,
} from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useDensity } from '@/lib/density';
import { useDevSession } from '@/lib/devSession';
import { useBotAdminSession } from '@/lib/botAdminSession';
import { useHotkey, MOD_LABEL } from '@/lib/hotkeys';
import { CommandPalette } from '@/components/CommandPalette';
import { DevLoginPanel } from '@/components/DevLoginPanel';
import { BotAdminLoginPanel } from '@/components/BotAdminLoginPanel';
import { Tooltip } from '@/components/ui/Tooltip';
import { Kbd } from '@/components/ui/Kbd';

interface ShellProps {
  title: string;
  back?: string;
  sidebar?: ReactNode;
  children: ReactNode;
}

export function Shell({ title, back, sidebar, children }: ShellProps) {
  const { user } = useAuth();
  const { density, cycle } = useDensity();
  // Erhoehte Bereiche (DEV / Bot-Admin) steuern Sichtbarkeit von DEV-Tools wie
  // der Befehlspalette. Erst nach korrekter Passwort-Eingabe (active) sichtbar.
  const devActive = useDevSession().active;
  const botAdminActive = useBotAdminSession().active;
  const elevated = devActive || botAdminActive;
  const loc = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Login-Panels (DEV + Bot-Admin) sitzen auf Desktop inline im Header, auf
  // Mobile in einer eigenen gestapelten Leiste darunter. Per matchMedia
  // entscheiden wir, WO sie gerendert werden — so existiert immer nur EINE
  // Instanz (keine doppelten input-IDs, kein Overlap im engen Header).
  const [isDesktop, setIsDesktop] = useState(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(min-width: 768px)').matches,
  );
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia('(min-width: 768px)');
    const onChange = (): void => setIsDesktop(mql.matches);
    // Direkt beim Mount einmal synchronisieren (z. B. nach Hydration/Resize
    // bevor das erste 'change'-Event feuert).
    onChange();
    // Moderne API bevorzugen, aber Fallback auf das veraltete
    // addListener/removeListener fuer aeltere Safari/WebView-Versionen.
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    }
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  }, []);

  // Palette-Hotkey global (Inhalte respektieren ohnehin 3-Gate Auth).
  useHotkey('mod+k', e => { e.preventDefault(); if (elevated) setPaletteOpen(o => !o); }, { allowInInputs: true });
  useHotkey('escape', () => setPaletteOpen(false), { allowInInputs: true });

  useEffect(() => { setSidebarOpen(false); }, [loc.pathname]);
  useEffect(() => {
    const onResize = (): void => { if (window.innerWidth >= 768) setSidebarOpen(false); };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  useEffect(() => {
    document.body.style.overflow = sidebarOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [sidebarOpen]);

  async function logout(): Promise<void> {
    try { await fetch('/auth/logout', { method: 'POST', credentials: 'include' }); } catch { /* ignore */ }
    window.location.href = '/login';
  }

  const DensityIcon = density === 'compact' ? Rows3 : density === 'cozy' ? Rows2 : Square;

  return (
    <div className="min-h-full flex flex-col">
      <header className="sticky top-0 z-40 h-16 glass header-premium flex items-center justify-between px-4 sm:px-6">
        <div className="flex items-center gap-2 sm:gap-4 min-w-0">
          {sidebar && (
            <button
              type="button"
              onClick={() => setSidebarOpen(o => !o)}
              className="md:hidden inline-flex items-center justify-center h-9 w-9 rounded-md text-white hover:bg-bg-elev focus-ring"
              aria-label={sidebarOpen ? 'Menue schliessen' : 'Menue oeffnen'}
            >
              {sidebarOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          )}
          {back && (
            <Link
              to={back}
              className="text-muted hover:text-white inline-flex items-center gap-1 focus-ring rounded-md px-1"
            >
              <ArrowLeft className="h-4 w-4" />
              <span className="text-sm hidden sm:inline">Zurueck</span>
            </Link>
          )}
          <Link to="/servers" className="flex items-center gap-2 focus-ring rounded-md px-1 group">
            <span className="relative inline-flex h-2.5 w-2.5">
              <span
                className="absolute inline-flex h-full w-full rounded-full bg-accent opacity-60 group-hover:opacity-100"
                style={{ animation: 'pulse-ring 2s cubic-bezier(0,0,0.2,1) infinite' }}
              />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-gradient-to-br from-red-400 to-red-700 shadow-[0_0_8px_rgba(239,68,68,0.8)]" />
            </span>
            <span className="v-logo font-extrabold text-xl tracking-tight">V-Bot</span>
          </Link>
          <span className="text-white/15 hidden sm:inline">•</span>
          <span className="text-white/85 text-sm font-medium truncate hidden sm:inline">{title}</span>
        </div>

        <div className="flex items-center gap-1.5 sm:gap-2 text-sm">
          {/* DEV/Bot-Admin-Login: nur auf Desktop inline im Header (Mobile-Bar
              unten rendert sie stattdessen gestapelt). */}
          {isDesktop && (
            <>
              <DevLoginPanel />
              <BotAdminLoginPanel />
            </>
          )}
          <Tooltip content={<span>Befehlspalette · <Kbd>{MOD_LABEL}</Kbd>+<Kbd>K</Kbd></span>}>
            {/* DEV-Tool-Suche nur sichtbar, wenn DEV oder Bot-Admin freigeschaltet ist. */}
            {elevated ? (
              <button
                type="button"
                onClick={() => setPaletteOpen(true)}
                className="inline-flex items-center gap-2 h-9 pl-2.5 pr-2 rounded-md border border-white/[0.06] bg-white/[0.02] hover:bg-bg-elev/60 text-muted hover:text-white focus-ring"
                aria-label="Befehlspalette oeffnen"
              >
                <Command className="h-3.5 w-3.5" />
                <span className="hidden md:inline text-xs">Suchen</span>
                <span className="hidden md:inline-flex items-center gap-0.5">
                  <Kbd>{MOD_LABEL}</Kbd><Kbd>K</Kbd>
                </span>
              </button>
            ) : <span className="hidden" />}
          </Tooltip>


          <Tooltip content={`Dichte: ${density}`}>
            <button
              type="button"
              onClick={cycle}
              className="inline-flex items-center justify-center h-9 w-9 rounded-md text-muted hover:text-white hover:bg-bg-elev focus-ring"
              aria-label={`Dichte umschalten (aktuell: ${density})`}
            >
              <DensityIcon className="h-4 w-4" />
            </button>
          </Tooltip>

          {user && (
            <span className="text-muted hidden lg:inline truncate max-w-[140px]" title={user.username}>
              {user.username}
            </span>
          )}
          <Tooltip content="Logout">
            <button
              onClick={logout}
              className="text-muted hover:text-white inline-flex items-center justify-center h-9 w-9 rounded-md hover:bg-bg-elev focus-ring"
              type="button"
              aria-label="Logout"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </Tooltip>
        </div>
      </header>

      {(back || title) && (
        <div className="sm:hidden border-b border-border px-4 py-2 text-sm">
          <span className="text-white truncate">{title}</span>
        </div>
      )}

      {/* Mobile-Login-Leiste: DEV- und Bot-Admin-Login gestapelt, volle Breite,
          eigener Block unterhalb des Headers — kein Overlap mit Branding/Inhalt. */}
      {!isDesktop && user && (
        <div className="md:hidden border-b border-border bg-bg-card/40 px-4 py-3 flex flex-col gap-3">
          <DevLoginPanel />
          <BotAdminLoginPanel />
        </div>
      )}

      <div className="flex-1 flex overflow-hidden relative z-10">
        {sidebar && (
          <>
            <aside
              className="hidden md:block w-64 lg:w-72 border-r border-white/[0.06] bg-gradient-to-b from-bg-card/50 to-bg-card/20 backdrop-blur-md p-5 overflow-y-auto text-[15px]"
              aria-label="Navigation"
            >
              {sidebar}
            </aside>
            {sidebarOpen && (
              <div
                className="md:hidden fixed inset-0 z-30 bg-black/60 animate-fade-in"
                onClick={() => setSidebarOpen(false)}
                role="presentation"
              >
                <aside
                  className="absolute left-0 top-16 bottom-0 w-72 max-w-[85vw] glass border-r border-border p-4 overflow-y-auto"
                  onClick={e => e.stopPropagation()}
                  role="dialog"
                  aria-label="Navigation"
                >
                  {sidebar}
                </aside>
              </div>
            )}
          </>
        )}
        <main className="flex-1 overflow-y-auto p-4 sm:p-6" role="main">{children}</main>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
