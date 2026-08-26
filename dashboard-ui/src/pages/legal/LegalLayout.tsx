import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { LegalFooter } from '@/components/LegalFooter';

const OPERATOR_NAME = (import.meta.env.VITE_LEGAL_OPERATOR_NAME as string | undefined)?.trim() || 'V-Bot / Void_architect';
const CONTACT_EMAIL = (import.meta.env.VITE_LEGAL_CONTACT_EMAIL as string | undefined)?.trim() || '';
const CONTACT_URL = (import.meta.env.VITE_LEGAL_CONTACT_URL as string | undefined)?.trim() || '';

export function LegalContact() {
  return (
    <div className="space-y-1 break-words">
      <p><span className="font-medium text-white">Betreiber:</span> {OPERATOR_NAME}</p>
      {CONTACT_EMAIL ? (
        <p><span className="font-medium text-white">E-Mail:</span> <a className="underline hover:text-white" href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a></p>
      ) : CONTACT_URL ? (
        <p><span className="font-medium text-white">Kontakt:</span> <a className="underline hover:text-white" href={CONTACT_URL} target="_blank" rel="noreferrer">V-Bot Support</a></p>
      ) : (
        <p><span className="font-medium text-white">Kontakt:</span> über die offiziellen V-Bot-Supportkanäle.</p>
      )}
    </div>
  );
}

export function LegalLayout({ title, updated = '26. August 2026', children }: { title: string; updated?: string; children: ReactNode }) {
  return (
    <div className="min-h-full w-full overflow-x-hidden bg-bg px-4 py-6 sm:px-6 lg:px-8">
      <main className="mx-auto w-full max-w-4xl">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <Link to="/login" className="inline-flex min-h-11 items-center rounded-md px-2 text-sm text-muted hover:text-white focus-ring">
            ← V-Bot Dashboard
          </Link>
          <span className="text-xs text-muted">Stand: {updated}</span>
        </div>
        <article className="glass rounded-2xl border border-border p-5 shadow-card sm:p-8 lg:p-10">
          <header className="mb-8 border-b border-border pb-6">
            <p className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-accent">V-Bot</p>
            <h1 className="break-words text-2xl font-bold text-white sm:text-3xl">{title}</h1>
          </header>
          <div className="legal-copy space-y-7 break-words text-sm leading-7 text-muted sm:text-[15px]">
            {children}
          </div>
        </article>
        <LegalFooter className="mt-5 pb-6" />
      </main>
    </div>
  );
}

export function LegalSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="break-words text-lg font-semibold text-white sm:text-xl">{title}</h2>
      <div className="space-y-2">{children}</div>
    </section>
  );
}
