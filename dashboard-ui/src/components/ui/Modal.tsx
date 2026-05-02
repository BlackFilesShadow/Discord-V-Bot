/**
 * Accessible Modal mit Portal, Backdrop, ESC-Close, Focus-Restore.
 *
 * Bewusst minimal (kein Focus-Trap-Polyfill — erste fokussierbare
 * Schaltflaeche bekommt initial Fokus, ESC schliesst, Click auf Backdrop
 * schliesst optional). Fuer Step-up-Workflows reicht das.
 */
import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { twMerge } from 'tailwind-merge';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  desc?: string;
  /** Verhindert Schliessen via Backdrop-Click (wichtig fuer Step-up). */
  preventBackdropClose?: boolean;
  children: ReactNode;
  footer?: ReactNode;
  /** Tailwind-Klassen fuer Inhalts-Container (Default: w-128). */
  className?: string;
  /** ARIA-ID fuer Beschreibung. */
  ariaDescribedBy?: string;
}

export function Modal({
  open, onClose, title, desc, preventBackdropClose, children, footer, className, ariaDescribedBy,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  const handleClose = useCallback(() => onClose(), [onClose]);

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') handleClose(); };
    window.addEventListener('keydown', onKey);
    // initialer Fokus aufs Dialog (oder erstes Button im Dialog)
    requestAnimationFrame(() => {
      const first = dialogRef.current?.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      first?.focus();
    });
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      previouslyFocused.current?.focus?.();
    };
  }, [open, handleClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="modal-backdrop grid place-items-center px-4 py-8"
      onClick={preventBackdropClose ? undefined : handleClose}
      role="presentation"
    >
      <div
        ref={dialogRef}
        className={twMerge('modal-dialog p-6', className)}
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        aria-describedby={ariaDescribedBy}
      >
        <div className="flex items-start justify-between gap-4 mb-4">
          <div className="min-w-0">
            <h2 id="modal-title" className="text-base font-semibold text-white tracking-tight">{title}</h2>
            {desc && <p className="text-xs text-muted mt-1">{desc}</p>}
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="text-muted hover:text-white p-1 rounded focus-ring shrink-0"
            aria-label="Schliessen"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-3">{children}</div>
        {footer && <div className="mt-6 flex items-center justify-end gap-2">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
