/**
 * Code-Block mit Copy-Button + monospace Layout.
 */
import { useState, type ReactNode } from 'react';
import { Copy, Check } from 'lucide-react';
import { twMerge } from 'tailwind-merge';

interface CodeBlockProps {
  children: string;
  language?: string;
  className?: string;
  /** Wenn true: Zeilennummern. */
  lineNumbers?: boolean;
  /** Optional: Header (z. B. Dateiname). */
  header?: ReactNode;
}

export function CodeBlock({ children, language, className, lineNumbers, header }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const onCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(children);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  };

  const lines = lineNumbers ? children.split('\n') : null;

  return (
    <div className={twMerge('relative rounded-lg border border-white/[0.06] bg-bg-subtle/80 overflow-hidden', className)}>
      {(header || language) && (
        <div className="flex items-center justify-between px-3 py-1.5 border-b border-white/[0.06] text-[10px] uppercase tracking-wider text-muted">
          <span>{header ?? language}</span>
        </div>
      )}
      <div className="relative">
        <pre className="overflow-auto text-[12px] leading-5 p-3 font-mono text-white/90">
          {lines ? (
            <code>
              {lines.map((l, i) => (
                <div key={i} className="flex">
                  <span className="select-none text-right pr-3 text-muted/60 w-8 shrink-0">{i + 1}</span>
                  <span className="flex-1 whitespace-pre">{l}</span>
                </div>
              ))}
            </code>
          ) : <code>{children}</code>}
        </pre>
        <button
          type="button"
          onClick={onCopy}
          className="absolute top-2 right-2 inline-flex items-center gap-1 text-[10px] px-1.5 py-1 rounded bg-bg-elev/80 text-muted hover:text-white hover:bg-bg-hover focus-ring"
          aria-label="In Zwischenablage kopieren"
        >
          {copied ? <Check className="h-3 w-3 text-ok" /> : <Copy className="h-3 w-3" />}
          {copied ? 'Kopiert' : 'Kopieren'}
        </button>
      </div>
    </div>
  );
}
