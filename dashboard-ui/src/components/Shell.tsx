/**
 * Enterprise-Shell: Sticky-Glass-Header + optionale Sidebar + Main.
 * Theme- und Density-Praeferenzen sind auf Desktop und Mobile erreichbar.
 */
import { type ReactNode, useState, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  ArrowLeft, LogOut, Menu, X, Command, Rows3, Rows2, Square, Palette,
} from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useTheme } from '@/lib/theme';
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
  const { theme, toggleTheme } = useTheme();
  const { density, cycle } = useDensity();
  const devActive = useDevSession().active;
  const botAdminActive = useBotAdminSession().active;
  const elevated = devActive || botAdminActive;
  const loc = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [isDesktop, setIsDesktop] = useState(
    () => typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(min-width: 768px)').matches,
  );

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia('(min-width: 768px)');
    const onChange = (): void => setIsDesktop(mql.matches);
    onChange();
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    }
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  }, []);

  useHotkey('mod+k', event => {
    event.preventDefault();
    if (elevated) setPaletteOpen(open => !open);
  }, { allowInInputs: true });
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
  const themeLabel = theme === 'obsidian' ? 'Obsidian' : 'Ice';
  const nextThemeLabel = theme === 'obsidian' ? 'Ice' : 'Obsidian';

  return (
    <div className="dashboard-shell min-h-full flex flex-col" data-dashboard-theme={theme}>
      <header className="sticky top-0 z-40 h-16 glass header-premium flex items-center justify-between px-3 sm:px-6">
        <div className="flex items-center gap-2 sm:gap-4 min-w-0">
          {sidebar && (
            <button
              type="button"
              onClick={() => setSidebarOpen(open => !open)}
              className="md:hidden inline-flex items-center justify-center h-11 w-11 rounded-md text-white hover:bg-bg-elev focus-ring shrink-0"
              aria-label={sidebarOpen ? 'Menue schliessen' : 'Menue oeffnen'}
            >
              {sidebarOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          )}
          {back && (
            <Link
              to={back}
              className="text-muted hover:text-white inline-flex min-h-11 md:min-h-0 items-center gap-1 focus-ring rounded-md px-1"
            >
              <ArrowLeft className="h-4 w-4" />
              <span className="text-sm hidden sm:inline">Zurueck</span>
            </Link>
          )}
          <Link to="/servers" className="flex min-h-11 md:min-h-0 items-center gap-2 focus-ring rounded-md px-1 group shrink-0" aria-label="V-Bot">
            <span className="relative inline-flex h-2.5 w-2.5">
              <span
                className="absolute inline-flex h-full w-full rounded-full bg-accent opacity-60 group-hover:opacity-100"
                style={{ animation: 'pulse-ring 2s cubic-bezier(0,0,0.2,1) infinite' }}
              />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-accent shadow-[0_0_10px_rgba(var(--color-accent),0.65)]" />
            </span>
            <span className="v-logo font-extrabold text-xl tracking-tight">V-Bot</span>
          </Link>
          <span className="text-white/15 hidden sm:inline">•</span>
          <span className="text-white/85 text-sm font-medium truncate hidden sm:inline">{title}</span>
        </div>

        <div className="flex items-center gap-0.5 sm:gap-2 text-sm shrink-0">
          {isDesktop && (
            <>
              <DevLoginPanel />
              <BotAdminLoginPanel />
            </>
          )}

          <Tooltip content={<span>Befehlspalette · <Kbd>{MOD_LABEL}</Kbd>+<Kbd>K</Kbd></span>}>
            {elevated ? (
              <button
                type="button"
                onClick={() => setPaletteOpen(true)}
                className="hidden md:inline-flex items-center gap-2 h-9 pl-2.5 pr-2 rounded-md border border-white/[0.06] bg-white/[0.02] hover:bg-bg-elev/60 text-muted hover:text-white focus-ring"
                aria-label="Befehlspalette oeffnen"
              >
                <Command className="h-3.5 w-3.5" />
                <span className="text-xs">Suchen</span>
                <span className="inline-flex items-center gap-0.5"><Kbd>{MOD_LABEL}</Kbd><Kbd>K</Kbd></span>
              </button>
            ) : <span className="hidden" />}
          </Tooltip>

          <Tooltip content={`Farbschema: ${themeLabel} · zu ${nextThemeLabel} wechseln`}>
            <button
              type="button"
              onClick={toggleTheme}
              className="theme-toggle-control inline-flex items-center justify-center sm:justify-start gap-1.5 h-11 min-w-11 md:h-9 md:min-w-[92px] px-2 rounded-md text-muted hover:text-white focus-ring border border-border/60 bg-bg-elev/55"
              aria-label={`Farbschema auf ${nextThemeLabel} umschalten`}
              data-testid="theme-toggle"
            >
              <Palette className="h-4 w-4 shrink-0" />
              <span className="hidden sm:inline text-xs font-semibold">{themeLabel}</span>
            </button>
          </Tooltip>

          <Tooltip content={`Dichte: ${density}`}>
            <button
              type="button"
              onClick={cycle}
              className="inline-flex items-center justify-center h-11 w-11 md:h-9 md:w-9 rounded-md text-muted hover:text-white hover:bg-bg-elev focus-ring"
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
              className="text-muted hover:text-white inline-flex items-center justify-center h-11 w-11 md:h-9 md:w-9 rounded-md hover:bg-bg-elev focus-ring"
              type="button"
              aria-label="Logout"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </Tooltip>
        </div>
      </header>

      {(back || title) && (
        <div className="sm:hidden border-b border-border px-4 py-2 text-sm bg-bg-card/35">
          <span className="text-white truncate">{title}</span>
        </div>
      )}

      {!isDesktop && user && (
        <div className="md:hidden border-b border-border bg-bg-card/55 px-4 py-3 flex flex-col gap-3">
          <DevLoginPanel />
          <BotAdminLoginPanel />
          {elevated && (
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md border border-white/[0.06] bg-white/[0.02] text-muted hover:bg-bg-elev/60 hover:text-white focus-ring"
              aria-label="Befehlspalette oeffnen"
            >
              <Command className="h-4 w-4" />
              <span className="text-sm font-medium">Befehlspalette</span>
            </button>
          )}
        </div>
      )}

      <div className="flex-1 flex overflow-hidden relative z-10">
        {sidebar && (
          <>
            <aside
              className="dashboard-sidebar hidden md:block w-64 lg:w-72 border-r border-border/60 backdrop-blur-md p-5 overflow-y-auto text-[15px]"
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
                  onClick={event => event.stopPropagation()}
                  role="dialog"
                  aria-label="Navigation"
                >
                  {sidebar}
                </aside>
              </div>
            )}
          </>
        )}
        <main className="dashboard-main flex-1 overflow-y-auto p-4 sm:p-6" role="main">{children}</main>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
