import { type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, LogOut } from 'lucide-react';
import { useAuth } from '@/lib/auth';

interface ShellProps {
  title: string;
  back?: string;
  sidebar?: ReactNode;
  children: ReactNode;
}

export function Shell({ title, back, sidebar, children }: ShellProps) {
  const { user } = useAuth();
  return (
    <div className="min-h-full flex flex-col">
      <header className="h-14 border-b border-border bg-bg-card/80 backdrop-blur flex items-center justify-between px-6">
        <div className="flex items-center gap-4">
          {back && (
            <Link to={back} className="text-muted hover:text-white inline-flex items-center gap-1">
              <ArrowLeft className="h-4 w-4" />
              <span className="text-sm">Zurueck</span>
            </Link>
          )}
          <span className="font-bold text-accent text-lg">V-Bot</span>
          <span className="text-muted">/</span>
          <span className="text-white text-sm">{title}</span>
        </div>
        <div className="flex items-center gap-3 text-sm">
          {user && <span className="text-muted">{user.username}</span>}
          <button
            onClick={async () => {
              try { await fetch('/auth/logout', { method: 'POST', credentials: 'include' }); } catch { /* ignore */ }
              window.location.href = '/login';
            }}
            className="text-muted hover:text-white inline-flex items-center gap-1"
            type="button"
            aria-label="Logout"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </header>
      <div className="flex-1 flex overflow-hidden">
        {sidebar && (
          <aside className="w-60 border-r border-border bg-bg-card/50 p-4 overflow-y-auto">
            {sidebar}
          </aside>
        )}
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
}
