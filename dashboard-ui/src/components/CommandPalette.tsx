/**
 * Command-Palette (Cmd+K).
 *
 * Sucht ueber alle DEV-Tools (Label + Keywords + Category). Auswahl
 * navigiert zum Tool. Ist als globaler Overlay-Mount in Shell.tsx
 * sichtbar; geoeffnet via Hotkey oder Topbar-Button.
 *
 * Entscheidung: Wir zeigen NUR Navigation. Aktionen wie "Provider
 * umschalten" / "Cache leeren" kommen in Phase P2 (Incident-Console)
 * und werden dann hier per Kategorie "Actions" ergaenzt.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Search, ArrowRight } from 'lucide-react';
import { DEV_TOOLS, CATEGORY_LABEL, CATEGORY_ORDER, type DevTool } from '@/lib/devToolsCatalog';
import { Kbd } from '@/components/ui/Kbd';
import { Badge } from '@/components/ui/Badge';

interface PaletteProps {
  open: boolean;
  onClose: () => void;
}

export function CommandPalette({ open, onClose }: PaletteProps) {
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) { setQuery(''); setActiveIdx(0); return; }
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const filtered = useMemo<DevTool[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [...DEV_TOOLS];
    return DEV_TOOLS.filter(t => {
      const hay = [
        t.label, t.slug, t.desc, CATEGORY_LABEL[t.category],
        ...(t.keywords ?? []),
      ].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [query]);

  // Gruppieren nach Kategorie (in CATEGORY_ORDER-Reihenfolge)
  const grouped = useMemo(() => {
    const map = new Map<string, DevTool[]>();
    filtered.forEach(t => {
      const arr = map.get(t.category) ?? [];
      arr.push(t);
      map.set(t.category, arr);
    });
    return CATEGORY_ORDER
      .map(cat => ({ cat, items: map.get(cat) ?? [] }))
      .filter(g => g.items.length > 0);
  }, [filtered]);

  // Reset activeIdx wenn filtered shrinks
  useEffect(() => { setActiveIdx(0); }, [query]);

  if (!open) return null;

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx(i => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const t = filtered[activeIdx];
      if (t) { navigate(`/dev/${t.slug}`); onClose(); }
    }
  };

  // Reverse-Map: globaler Index pro Tool fuer Highlight ueber Gruppen.
  const flatIdx = (slug: string): number => filtered.findIndex(t => t.slug === slug);

  return createPortal(
    <div
      className="modal-backdrop grid place-items-start pt-[12vh] px-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="palette-shell"
        onClick={e => e.stopPropagation()}
        role="dialog" aria-modal="true" aria-label="Command Palette"
      >
        <div className="relative border-b border-white/[0.06]">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Suche Tools, Kategorien, Keywords…"
            className="palette-input"
            aria-label="Suche"
          />
          <div className="absolute right-3 top-1/2 -translate-y-1/2 hidden sm:flex items-center gap-1.5 text-[10px] text-muted">
            <Kbd>↑</Kbd><Kbd>↓</Kbd> nav <span className="text-white/20">·</span>
            <Kbd>↵</Kbd> oeffnen <span className="text-white/20">·</span>
            <Kbd>Esc</Kbd>
          </div>
        </div>

        <div className="max-h-[52vh] overflow-y-auto py-2">
          {filtered.length === 0 && (
            <div className="px-4 py-10 text-center text-xs text-muted">Keine Treffer.</div>
          )}
          {grouped.map(group => (
            <div key={group.cat} className="mb-2 last:mb-0">
              <div className="palette-section">{CATEGORY_LABEL[group.cat as keyof typeof CATEGORY_LABEL]}</div>
              {group.items.map(t => {
                const Icon = t.icon;
                const idx = flatIdx(t.slug);
                const isActive = idx === activeIdx;
                return (
                  <div
                    key={t.slug}
                    className="palette-row"
                    data-active={isActive}
                    onMouseEnter={() => setActiveIdx(idx)}
                    onClick={() => { navigate(`/dev/${t.slug}`); onClose(); }}
                    role="option"
                    aria-selected={isActive}
                  >
                    <Icon className="h-4 w-4 text-muted shrink-0" />
                    <span className="flex-1 min-w-0 truncate">{t.label}</span>
                    {t.status === 'stub' && <Badge variant="neutral">Soon</Badge>}
                    <ArrowRight className="h-3.5 w-3.5 text-muted/60" />
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
