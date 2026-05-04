/**
 * Toast: globaler nicht-blockierender Status-Stack (ersetzt alert()).
 * - useToast() liefert push(message, kind?, durationMs?).
 * - <Toaster /> wird einmalig in App.tsx gemountet.
 * - A11y: role="status" (polite), Auto-Dismiss + manuelles Schliessen.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2, AlertTriangle, Info, X, AlertCircle } from 'lucide-react';

export type ToastKind = 'success' | 'error' | 'warn' | 'info';

interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
  duration: number;
}

interface ToastApi {
  push: (message: string, kind?: ToastKind, durationMs?: number) => void;
  success: (message: string, durationMs?: number) => void;
  error: (message: string, durationMs?: number) => void;
  warn: (message: string, durationMs?: number) => void;
  info: (message: string, durationMs?: number) => void;
}

const ToastCtx = createContext<ToastApi | null>(null);

const KIND_STYLE: Record<ToastKind, { border: string; text: string; bg: string; icon: typeof CheckCircle2 }> = {
  success: { border: 'border-ok/40',     text: 'text-ok',     bg: 'bg-ok/10',     icon: CheckCircle2 },
  error:   { border: 'border-danger/40', text: 'text-danger', bg: 'bg-danger/10', icon: AlertCircle },
  warn:    { border: 'border-warn/40',   text: 'text-warn',   bg: 'bg-warn/10',   icon: AlertTriangle },
  info:    { border: 'border-accent/40', text: 'text-accent', bg: 'bg-accent/10', icon: Info },
};

export function Toaster({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const push = useCallback((message: string, kind: ToastKind = 'info', durationMs = 4500): void => {
    const id = ++idRef.current;
    setItems(arr => [...arr, { id, message, kind, duration: durationMs }]);
  }, []);

  const dismiss = useCallback((id: number): void => {
    setItems(arr => arr.filter(t => t.id !== id));
  }, []);

  const api: ToastApi = {
    push,
    success: (m, d) => push(m, 'success', d),
    error:   (m, d) => push(m, 'error', d),
    warn:    (m, d) => push(m, 'warn', d),
    info:    (m, d) => push(m, 'info', d),
  };

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div
        className="fixed top-4 right-4 z-[1000] flex flex-col gap-2 pointer-events-none max-w-sm w-[calc(100%-2rem)]"
        aria-live="polite"
        aria-atomic="false"
      >
        {items.map(t => <ToastRow key={t.id} item={t} onDismiss={() => dismiss(t.id)} />)}
      </div>
    </ToastCtx.Provider>
  );
}

function ToastRow({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const style = KIND_STYLE[item.kind];
  const Icon = style.icon;
  useEffect(() => {
    if (item.duration <= 0) return;
    const t = setTimeout(onDismiss, item.duration);
    return () => clearTimeout(t);
  }, [item.duration, onDismiss]);
  return (
    <div
      role="status"
      className={`pointer-events-auto rounded-md border ${style.border} ${style.bg} shadow-lg backdrop-blur-sm px-3 py-2 flex items-start gap-2 transition-all`}
      style={{ animation: 'toast-in 180ms ease-out' }}
    >
      <Icon className={`h-4 w-4 ${style.text} mt-0.5 shrink-0`} aria-hidden="true" />
      <p className={`flex-1 text-sm ${style.text} break-words`}>{item.message}</p>
      <button
        type="button"
        onClick={onDismiss}
        className={`${style.text} opacity-60 hover:opacity-100 shrink-0`}
        aria-label="Benachrichtigung schliessen"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error('useToast() muss innerhalb von <Toaster> verwendet werden.');
  return ctx;
}
