/**
 * Globaler Hotkey-Registrar (kein Provider noetig).
 *
 * - useHotkey('mod+k', cb) registriert einen Listener.
 * - 'mod' = Cmd (mac) / Ctrl (sonst).
 * - Listener werden ignoriert, wenn das Event-Target ein Input/Textarea/
 *   ContentEditable ist (verhindert Keystroke-Konflikte beim Tippen).
 *   Ausnahme: Esc und Cmd+K (Palette darf ueberall geoeffnet werden).
 */
import { useEffect } from 'react';

type Combo = string;

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);

function normalizeCombo(c: Combo): Combo {
  return c.toLowerCase().replace(/\s+/g, '').replace('mod', isMac ? 'meta' : 'ctrl');
}

function eventCombo(e: KeyboardEvent): Combo {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('ctrl');
  if (e.metaKey) parts.push('meta');
  if (e.altKey)  parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  parts.push(e.key.toLowerCase());
  return parts.join('+');
}

function isEditable(t: EventTarget | null): boolean {
  if (!t || !(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return t.isContentEditable;
}

export function useHotkey(
  combo: Combo,
  handler: (e: KeyboardEvent) => void,
  opts: { allowInInputs?: boolean; deps?: ReadonlyArray<unknown> } = {},
): void {
  const target = normalizeCombo(combo);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (eventCombo(e) !== target) return;
      if (!opts.allowInInputs && isEditable(e.target)) return;
      handler(e);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [target, opts.allowInInputs, ...(opts.deps ?? [])]);
}

export const MOD_LABEL = isMac ? '⌘' : 'Ctrl';
