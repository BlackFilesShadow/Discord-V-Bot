import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useState,
  type ReactNode,
} from 'react';

export type ThemeMode = 'obsidian' | 'ice';

const STORAGE_KEY = 'ui.theme.session';
const DEFAULT_THEME: ThemeMode = 'obsidian';

interface ThemeContextValue {
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: DEFAULT_THEME,
  setTheme: () => { /* noop */ },
  toggleTheme: () => { /* noop */ },
});

function readTheme(): ThemeMode {
  if (typeof window === 'undefined') return DEFAULT_THEME;
  try {
    const stored = window.sessionStorage.getItem(STORAGE_KEY);
    if (stored === 'obsidian' || stored === 'ice') return stored;
  } catch { /* private mode / blocked storage */ }
  return DEFAULT_THEME;
}

function applyTheme(theme: ThemeMode): void {
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  // Beide V-Bot-Skins sind bewusst dunkle Premium-Oberflaechen. Tailwind `dark:`
  // bleibt damit in beiden Modi konsistent; nur die Farb-Tokens wechseln.
  root.classList.add('dark');
  root.style.colorScheme = 'dark';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeMode>(readTheme);

  useLayoutEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const setTheme = useCallback((next: ThemeMode): void => {
    setThemeState(next);
    try { window.sessionStorage.setItem(STORAGE_KEY, next); } catch { /* ignore */ }
  }, []);

  const toggleTheme = useCallback((): void => {
    setThemeState(previous => {
      const next: ThemeMode = previous === 'obsidian' ? 'ice' : 'obsidian';
      try { window.sessionStorage.setItem(STORAGE_KEY, next); } catch { /* ignore */ }
      return next;
    });
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
