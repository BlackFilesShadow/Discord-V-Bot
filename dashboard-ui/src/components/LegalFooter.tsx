import { Link } from 'react-router-dom';

export function LegalFooter({ className = '' }: { className?: string }) {
  return (
    <nav
      aria-label="Rechtliche Informationen"
      className={`flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-xs text-muted ${className}`}
    >
      <Link className="min-h-11 inline-flex items-center hover:text-white hover:underline focus-ring rounded px-1" to="/legal/privacy">
        Datenschutz
      </Link>
      <span aria-hidden="true" className="hidden sm:inline text-muted/50">·</span>
      <Link className="min-h-11 inline-flex items-center hover:text-white hover:underline focus-ring rounded px-1" to="/legal/terms">
        Nutzungsbedingungen
      </Link>
    </nav>
  );
}
