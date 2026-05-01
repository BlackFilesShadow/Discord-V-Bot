import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Search, X } from 'lucide-react';
import { twMerge } from 'tailwind-merge';

export interface ComboboxOption {
  id: string;
  label: string;
  /** Optionaler Sub-Text (Discord-ID, Username) */
  hint?: string;
  /** Optionales Avatar/Icon URL */
  avatar?: string;
  /** Optionale Farbe (z. B. Rolle) als linker Punkt */
  color?: string | null;
  /** Disabled? */
  disabled?: boolean;
}

interface ComboboxProps {
  /** Aktuell ausgewaehlter Wert (id) oder null */
  value: string | null;
  onChange: (id: string | null, opt: ComboboxOption | null) => void;
  /** Verfuegbare Optionen (statisch ODER schon vorgefiltert via onSearch) */
  options: ComboboxOption[];
  /** Wird beim Tippen aufgerufen — fuer server-seitige Suche (z. B. Members). */
  onSearch?: (query: string) => void;
  /** Externer Loading-State (z. B. waehrend onSearch laeuft). */
  loading?: boolean;
  placeholder?: string;
  emptyText?: string;
  disabled?: boolean;
  /** Erlaubt Loeschen via X-Button. */
  clearable?: boolean;
  className?: string;
}

/**
 * Premium-Combobox: Klick oeffnet Dropdown, Tippen filtert/sucht,
 * Pfeile + Enter wahlen aus, Esc schliesst, Click-outside schliesst.
 *
 * Wird sowohl fuer User- als auch Rollen-Auswahl genutzt.
 */
export function Combobox({
  value, onChange, options, onSearch, loading,
  placeholder = 'Auswaehlen...',
  emptyText = 'Keine Treffer.',
  disabled = false, clearable = true,
  className,
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = options.find(o => o.id === value) ?? null;

  // Lokale Filterung wenn KEIN onSearch — sonst ist die Filterung server-seitig.
  const filtered = onSearch
    ? options
    : options.filter(o => {
        if (!query) return true;
        const q = query.toLowerCase();
        return o.label.toLowerCase().includes(q) || (o.hint?.toLowerCase().includes(q) ?? false);
      });

  // Click-Outside
  useEffect(() => {
    function onDoc(e: MouseEvent): void {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  // Beim Oeffnen Fokus + Reset
  useEffect(() => {
    if (open) {
      setActiveIdx(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Bei Query-Change: server-Search throttled per Effect.
  useEffect(() => {
    if (!onSearch) return;
    const id = window.setTimeout(() => onSearch(query), 220);
    return () => window.clearTimeout(id);
  }, [query, onSearch]);

  function pick(opt: ComboboxOption): void {
    if (opt.disabled) return;
    onChange(opt.id, opt);
    setOpen(false);
    setQuery('');
  }

  function clear(): void {
    onChange(null, null);
    setQuery('');
  }

  function onKey(e: React.KeyboardEvent): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx(i => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && filtered[activeIdx]) {
      e.preventDefault();
      pick(filtered[activeIdx]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <div ref={rootRef} className={twMerge('relative', className)}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(o => !o)}
        className={twMerge(
          'input-premium w-full rounded-lg text-white px-3.5 py-2.5 text-sm',
          'flex items-center justify-between gap-2 cursor-pointer',
          'disabled:opacity-50 disabled:cursor-not-allowed',
        )}
      >
        <span className="flex items-center gap-2 min-w-0 flex-1">
          {selected ? (
            <SelectedDisplay opt={selected} />
          ) : (
            <span className="text-muted/80 truncate">{placeholder}</span>
          )}
        </span>
        <span className="flex items-center gap-1 shrink-0">
          {clearable && selected && !disabled && (
            <span
              role="button"
              aria-label="Auswahl entfernen"
              tabIndex={0}
              onClick={e => { e.stopPropagation(); clear(); }}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); clear(); } }}
              className="rounded p-0.5 hover:bg-white/10 text-muted hover:text-white inline-flex items-center"
            >
              <X className="h-3.5 w-3.5" />
            </span>
          )}
          <ChevronDown className={twMerge('h-4 w-4 text-muted transition-transform', open && 'rotate-180')} />
        </span>
      </button>

      {open && (
        <div
          className="absolute left-0 right-0 top-[calc(100%+6px)] z-50 card-premium !p-2 max-h-72 overflow-hidden flex flex-col anim-rise"
          role="listbox"
        >
          <div className="flex items-center gap-2 border-b border-white/5 pb-2 mb-1">
            <Search className="h-4 w-4 text-muted ml-1" />
            <input
              ref={inputRef}
              value={query}
              onChange={e => { setQuery(e.target.value); setActiveIdx(0); }}
              onKeyDown={onKey}
              placeholder="Suchen..."
              className="bg-transparent flex-1 text-sm text-white placeholder:text-muted focus:outline-none px-1"
            />
            {loading && <span className="text-[10px] text-muted">laedt...</span>}
          </div>

          <div className="overflow-y-auto pr-1 -mr-1">
            {filtered.length === 0 && (
              <div className="px-3 py-6 text-xs text-muted text-center">{emptyText}</div>
            )}
            {filtered.map((opt, idx) => (
              <button
                type="button"
                key={opt.id}
                onClick={() => pick(opt)}
                onMouseEnter={() => setActiveIdx(idx)}
                disabled={opt.disabled}
                role="option"
                aria-selected={opt.id === value}
                className={twMerge(
                  'w-full text-left px-2.5 py-2 rounded-md flex items-center gap-2.5 text-sm transition-colors',
                  'disabled:opacity-40 disabled:cursor-not-allowed',
                  idx === activeIdx ? 'bg-white/[0.06]' : 'hover:bg-white/[0.04]',
                  opt.id === value && 'ring-1 ring-accent/40',
                )}
              >
                <OptionGlyph opt={opt} />
                <span className="min-w-0 flex-1">
                  <span className="block text-white truncate" style={opt.color ? { color: opt.color } : undefined}>
                    {opt.label}
                  </span>
                  {opt.hint && <span className="block text-[10px] text-muted truncate font-mono">{opt.hint}</span>}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SelectedDisplay({ opt }: { opt: ComboboxOption }) {
  return (
    <span className="flex items-center gap-2 min-w-0">
      <OptionGlyph opt={opt} />
      <span className="truncate" style={opt.color ? { color: opt.color } : undefined}>{opt.label}</span>
      {opt.hint && <span className="text-[10px] text-muted font-mono truncate hidden sm:inline">{opt.hint}</span>}
    </span>
  );
}

function OptionGlyph({ opt }: { opt: ComboboxOption }) {
  if (opt.avatar) {
    return <img src={opt.avatar} alt="" className="h-6 w-6 rounded-full ring-1 ring-white/10 shrink-0" loading="lazy" />;
  }
  if (opt.color && opt.color !== '#000000') {
    return (
      <span
        className="h-2.5 w-2.5 rounded-full shrink-0"
        style={{ background: opt.color, boxShadow: `0 0 8px ${opt.color}66` }}
      />
    );
  }
  return <span className="h-2.5 w-2.5 rounded-full bg-white/30 shrink-0" />;
}
