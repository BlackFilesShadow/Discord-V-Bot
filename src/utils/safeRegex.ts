/**
 * Leichtgewichtiger ReDoS-Schutz ohne native Abhaengigkeiten.
 *
 * Node's eingebaute RegExp-Engine kann bei "evil" Patterns mit verschachtelten
 * Quantoren (z.B. `(a+)+`, `(.*)*`, `([a-z]+)*`) katastrophal backtracken und
 * den Event-Loop blockieren. Da synchrone Regex in reinem JS nicht zuverlaessig
 * per Timeout abgebrochen werden koennen, kombinieren wir zwei Verteidigungen:
 *
 *   1. Statische Heuristik (Star-Height > 1), die gefaehrliche Patterns ablehnt
 *      — beim Anlegen UND vor jedem Match (Defense-in-Depth).
 *   2. Harte Laengen-Caps fuer Pattern und Input.
 *
 * Die Heuristik ist bewusst konservativ: im Zweifel wird ein Pattern abgelehnt.
 * Sie faengt die klassische Star-Height-ReDoS-Klasse ab. Verbleibende Restrisiken
 * (z.B. ueberlappende Alternationen) werden durch das Input-Laengen-Cap begrenzt.
 */

const MAX_PATTERN_LENGTH = 200;
const MAX_INPUT_LENGTH = 2000;

/**
 * Erkennt verschachtelte Quantoren (Star-Height >= 2), die katastrophales
 * Backtracking ausloesen koennen. Beispiele die TRUE liefern:
 *   (a+)+   (a*)*   ([a-z]+)*   (.*)+   (\d+)*
 */
function hasNestedQuantifier(pattern: string): boolean {
  // Stack pro Gruppe: enthielt diese Gruppe (auf ihrer Ebene) einen Quantor?
  const stack: { quantified: boolean }[] = [];

  const isQuantifierAt = (idx: number): { ok: boolean; len: number } => {
    const ch = pattern[idx];
    if (ch === '*' || ch === '+') return { ok: true, len: 1 };
    if (ch === '{') {
      const m = /^\{\d*,?\d*\}/.exec(pattern.slice(idx));
      if (m) return { ok: true, len: m[0].length };
    }
    return { ok: false, len: 0 };
  };

  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];

    if (c === '\\') { i++; continue; } // escaped Zeichen ueberspringen

    if (c === '[') {
      // Zeichenklasse als Atom ueberspringen
      i++;
      while (i < pattern.length && pattern[i] !== ']') {
        if (pattern[i] === '\\') i++;
        i++;
      }
      continue;
    }

    if (c === '(') { stack.push({ quantified: false }); continue; }

    if (c === ')') {
      const grp = stack.pop();
      const q = isQuantifierAt(i + 1);
      if (q.ok) {
        // Quantifizierte Gruppe, die selbst einen Quantor enthielt -> nested.
        if (grp && grp.quantified) return true;
        // Sonst: diese Gruppe ist quantifiziert -> Eltern-Gruppe "enthaelt Quantor".
        if (stack.length > 0) stack[stack.length - 1].quantified = true;
        i += q.len - 1;
      }
      continue;
    }

    const q = isQuantifierAt(i);
    if (q.ok) {
      if (stack.length > 0) stack[stack.length - 1].quantified = true;
      i += q.len - 1;
    }
  }
  return false;
}

/**
 * Prueft, ob ein vom Nutzer geliefertes Regex-Pattern als "sicher" gelten kann:
 * kompilierbar, in Laengengrenzen und ohne verschachtelte Quantoren.
 */
export function isSafeRegexPattern(pattern: unknown): pattern is string {
  if (typeof pattern !== 'string') return false;
  if (pattern.length === 0 || pattern.length > MAX_PATTERN_LENGTH) return false;
  try { new RegExp(pattern); } catch { return false; }
  return !hasNestedQuantifier(pattern);
}

/**
 * Fuehrt einen ReDoS-gehaerteten `RegExp.test()` aus: nur wenn das Pattern als
 * sicher gilt, und nur gegen einen laengenbegrenzten Input. Bei unsicherem
 * Pattern oder Compile-Fehler wird `false` zurueckgegeben (fail-closed).
 */
export function safeRegexTest(pattern: string, input: string, flags = 'i'): boolean {
  if (!isSafeRegexPattern(pattern)) return false;
  const capped = input.length > MAX_INPUT_LENGTH ? input.slice(0, MAX_INPUT_LENGTH) : input;
  try {
    return new RegExp(pattern, flags).test(capped);
  } catch {
    return false;
  }
}
