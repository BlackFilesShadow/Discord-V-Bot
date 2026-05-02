import { type ReactNode, useState, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ArrowLeft, LogOut, Menu, X } from 'lucide-react';
import { useAuth } from '@/lib/auth';

interface ShellProps {
  title: string;
  back?: string;
  sidebar?: ReactNode;
  children: ReactNode;
}

export function Shell({ title, back, sidebar, children }: ShellProps) {
  const { user } = useAuth();
  const loc = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Sidebar bei Routen-Wechsel oder Resize zu Desktop schliessen
  useEffect(() => { setSidebarOpen(false); }, [loc.pathname]);
  useEffect(() => {
    const onResize = (): void => { if (window.innerWidth >= 768) setSidebarOpen(false); };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Body-Scroll lock wenn Mobile-Sidebar offen
  useEffect(() => {
    document.body.style.overflow = sidebarOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [sidebarOpen]);

  async function logout(): Promise<void> {
    try { await fetch('/auth/logout', { method: 'POST', credentials: 'include' }); } catch { /* ignore */ }
    window.location.href = '/login';
  }

  return (
    <div className="min-h-full flex flex-col">
      {/* Sticky Glass-Header */}
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
              <span className="absolute inline-flex h-full w-full rounded-full bg-accent opacity-60 group-hover:opacity-100" style={{ animation: 'pulse-ring 2s cubic-bezier(0,0,0.2,1) infinite' }} />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-gradient-to-br from-red-400 to-red-700 shadow-[0_0_8px_rgba(239,68,68,0.8)]" />
            </span>
            <span className="v-logo font-extrabold text-xl tracking-tight">V-Bot</span>
          </Link>
          <span className="text-white/15 hidden sm:inline">•</span>
          <span className="text-white/85 text-sm font-medium truncate hidden sm:inline">{title}</span>
        </div>

        <div className="flex items-center gap-3 text-sm">
          {user && (
            <span className="text-muted hidden sm:inline truncate max-w-[160px]" title={user.username}>
              {user.username}
            </span>
          )}
          <button
            onClick={logout}
            className="text-muted hover:text-white inline-flex items-center justify-center h-9 w-9 rounded-md hover:bg-bg-elev focus-ring"
            type="button"
            aria-label="Logout"
            title="Logout"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </header>

      {/* Mobile-Title-Bar */}
      {(back || title) && (
        <div className="sm:hidden border-b border-border px-4 py-2 text-sm">
          <span className="text-white truncate">{title}</span>
        </div>
      )}

      <div className="flex-1 flex overflow-hidden relative z-10">
        {sidebar && (
          <>
            {/* Desktop Sidebar */}
            <aside className="hidden md:block w-64 lg:w-72 border-r border-white/[0.06] bg-gradient-to-b from-bg-card/50 to-bg-card/20 backdrop-blur-md p-5 overflow-y-auto text-[15px]">
              {sidebar}
            </aside>
            {/* Mobile Drawer */}
            {sidebarOpen && (
              <div
                className="md:hidden fixed inset-0 z-30 bg-black/60 animate-fade-in"
                onClick={() => setSidebarOpen(false)}
                role="presentation"
              >
                <aside
                  className="absolute left-0 top-14 bottom-0 w-72 max-w-[85vw] glass border-r border-border p-4 overflow-y-auto"
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
        <main className="flex-1 overflow-y-auto p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
