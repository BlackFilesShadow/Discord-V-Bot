import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X, Smile } from 'lucide-react';
import { twMerge } from 'tailwind-merge';
import { EMOJI_CATEGORIES, ALL_EMOJIS } from '@/lib/emojiData';

interface EmojiPickerProps {
  /** Aktuell gewaehltes Emoji (Unicode oder `<:name:id>`), '' = keins. */
  value: string;
  onChange: (emoji: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  /** Erlaubt die manuelle Eingabe eines Custom-Server-Emojis (`<:name:id>`). */
  allowCustom?: boolean;
}

/**
 * Zentrales Emoji-Dropdown fuer das gesamte Dashboard.
 *
 * Klick oeffnet ein Popover mit Suche + Kategorien; Auswahl setzt das Emoji.
 * Diese Komponente ist die EINZIGE Emoji-Auswahl im Dashboard — sie wird
 * ueberall dort verwendet, wo ein Emoji/Emote gewaehlt werden kann.
 */
export function EmojiPicker({
  value, onChange, placeholder = 'Emoji wählen…',
  disabled = false, className, allowCustom = true,
}: EmojiPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cat, setCat] = useState(EMOJI_CATEGORIES[0].id);
  const [custom, setCustom] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent): void {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
    else { setQuery(''); setCustom(''); }
  }, [open]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q) return ALL_EMOJIS.filter(em => em.k.includes(q) || em.e === q).slice(0, 120);
    return EMOJI_CATEGORIES.find(c => c.id === cat)?.emojis ?? [];
  }, [query, cat]);

  function pick(emoji: string): void {
    onChange(emoji);
    setOpen(false);
  }

  // Anzeige: Custom-Emoji `<:name:id>` als Name darstellen, sonst das Emoji.
  const customMatch = value.match(/^<a?:(\w+):\d+>$/);
  const displayValue = customMatch ? `:${customMatch[1]}:` : value;

  return (
    <div ref={rootRef} className={twMerge('relative', className)}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(o => !o)}
        className="flex w-full items-center gap-2 rounded-md bg-bg-elev border border-border px-3 py-2 text-sm text-white focus-ring disabled:opacity-50"
      >
        {value
          ? <span className="text-lg leading-none">{customMatch ? '🔧' : value}</span>
          : <Smile size={16} className="text-muted" />}
        <span className={twMerge('flex-1 text-left truncate', !value && 'text-muted')}>
          {value ? displayValue : placeholder}
        </span>
        {value && (
          <span
            role="button"
            tabIndex={0}
            aria-label="Emoji entfernen"
            className="text-muted hover:text-red-400"
            onClick={(e) => { e.stopPropagation(); onChange(''); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onChange(''); } }}
          >
            <X size={14} />
          </span>
        )}
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-[300px] rounded-md border border-border bg-bg-elev shadow-xl">
          <div className="p-2 border-b border-border">
            <div className="flex items-center gap-2 rounded bg-bg border border-border px-2">
              <Search size={14} className="text-muted" />
              <input
                ref={inputRef}
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Emoji suchen…"
                className="flex-1 bg-transparent py-1.5 text-sm text-white outline-none"
              />
            </div>
          </div>

          {!query && (
            <div className="flex gap-0.5 px-2 pt-2 overflow-x-auto">
              {EMOJI_CATEGORIES.map(c => (
                <button
                  key={c.id}
                  type="button"
                  title={c.label}
                  onClick={() => setCat(c.id)}
                  className={twMerge(
                    'shrink-0 rounded px-1.5 py-1 text-base leading-none',
                    cat === c.id ? 'bg-brand/20' : 'hover:bg-white/5',
                  )}
                >
                  {c.emojis[0]?.e}
                </button>
              ))}
            </div>
          )}

          <div className="max-h-[200px] overflow-y-auto p-2 grid grid-cols-8 gap-0.5">
            {results.length === 0 && <p className="col-span-8 text-muted text-xs py-3 text-center">Keine Treffer.</p>}
            {results.map((em, i) => (
              <button
                key={`${em.e}-${i}`}
                type="button"
                title={em.k.split(' ')[0]}
                onClick={() => pick(em.e)}
                className="rounded p-1 text-lg leading-none hover:bg-brand/20"
              >
                {em.e}
              </button>
            ))}
          </div>

          {allowCustom && (
            <div className="p-2 border-t border-border">
              <span className="text-muted text-[11px] mb-1 block">Custom-Server-Emoji (&lt;:name:id&gt;)</span>
              <div className="flex gap-1">
                <input
                  value={custom}
                  onChange={e => setCustom(e.target.value)}
                  placeholder="<:name:123456789012345678>"
                  className="flex-1 rounded bg-bg border border-border px-2 py-1 text-xs text-white outline-none focus-ring"
                />
                <button
                  type="button"
                  disabled={!/^<a?:\w+:\d{17,20}>$/.test(custom.trim())}
                  onClick={() => pick(custom.trim())}
                  className="rounded bg-brand/20 px-2 py-1 text-xs text-white disabled:opacity-40"
                >
                  Setzen
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
