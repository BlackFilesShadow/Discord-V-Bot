/**
 * Toast-Provider mit minimaler API.
 *
 * Ersetzt window.alert/confirm fuer non-blocking Feedback. Wird global
 * in main.tsx eingebunden; Container rendert sich ueber den Hook unten
 * automatisch via <ToastViewport />.
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2, AlertTriangle, XCircle, Info, X } from 'lucide-react';

export type ToastVariant = 'success' | 'warn' | 'danger' | 'info' | 'neutral';

export interface Toast {
  id: number;
  variant: ToastVariant;
  title: string;
  desc?: string;
  /** ms; 0 = sticky bis manueller Close */
  duration?: number;
}

interface Ctx {
  push: (t: Omit<Toast, 'id'>) => number;
  dismiss: (id: number) => void;
  toasts: ReadonlyArray<Toast>;
}

const Context = createContext<Ctx>({
  push: () => 0,
  dismiss: () => { /* noop */ },
  toasts: [],
});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(0);

  const dismiss = useCallback((id: number): void => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const push = useCallback((t: Omit<Toast, 'id'>): number => {
    // Dedup: identische Toasts (variant+title+desc), die binnen 3s mehrfach
    // gepusht werden, koalieren auf den bestehenden Toast. Verhindert das
    // Stapeln von 'Fehler HTTP 429' bei Polling-Storms.
    let dedupedId = 0;
    setToasts(prev => {
      const existing = prev.find(p =>
        p.variant === t.variant && p.title === t.title && (p.desc ?? '') === (t.desc ?? ''),
      );
      if (existing) {
        dedupedId = existing.id;
        return prev;
      }
      idRef.current += 1;
      const id = idRef.current;
      const toast: Toast = { duration: 5000, ...t, id };
      if (toast.duration && toast.duration > 0) {
        window.setTimeout(() => dismiss(id), toast.duration);
      }
      dedupedId = id;
      return [...prev, toast];
    });
    return dedupedId;
  }, [dismiss]);

  const value = useMemo<Ctx>(() => ({ push, dismiss, toasts }), [push, dismiss, toasts]);

  return (
    <Context.Provider value={value}>
      {children}
      <ToastViewport />
    </Context.Provider>
  );
}

export function useToast(): Pick<Ctx, 'push' | 'dismiss'> {
  const c = useContext(Context);
  return { push: c.push, dismiss: c.dismiss };
}

function ToastViewport() {
  const { toasts, dismiss } = useContext(Context);
  if (toasts.length === 0) return null;
  return (
    <div className="toast-container" role="region" aria-label="Benachrichtigungen">
      {toasts.map(t => <ToastItem key={t.id} toast={t} onClose={() => dismiss(t.id)} />)}
    </div>
  );
}

function ToastItem({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  const Icon = toast.variant === 'success' ? CheckCircle2
    : toast.variant === 'warn' ? AlertTriangle
    : toast.variant === 'danger' ? XCircle
    : Info;
  return (
    <div className="toast-item" data-variant={toast.variant} role="status" aria-live="polite">
      <div className="flex items-start gap-2.5">
        <Icon className={`h-4 w-4 mt-0.5 shrink-0 ${
          toast.variant === 'success' ? 'text-ok'
          : toast.variant === 'warn' ? 'text-warn'
          : toast.variant === 'danger' ? 'text-danger'
          : toast.variant === 'info' ? 'text-info'
          : 'text-muted'
        }`} />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-white truncate">{toast.title}</div>
          {toast.desc && <div className="text-[11px] text-muted mt-0.5">{toast.desc}</div>}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-muted hover:text-white p-0.5 rounded focus-ring"
          aria-label="Schliessen"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
