import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const html = fs.readFileSync(path.join(root, 'dashboard-ui', 'index.html'), 'utf8');
const main = fs.readFileSync(path.join(root, 'dashboard-ui', 'src', 'main.tsx'), 'utf8');
const shell = fs.readFileSync(path.join(root, 'dashboard-ui', 'src', 'components', 'Shell.tsx'), 'utf8');
const theme = fs.readFileSync(path.join(root, 'dashboard-ui', 'src', 'lib', 'theme.tsx'), 'utf8');
const themeCss = fs.readFileSync(path.join(root, 'dashboard-ui', 'src', 'theme.css'), 'utf8');
const globalCss = fs.readFileSync(path.join(root, 'dashboard-ui', 'src', 'index.css'), 'utf8');
const button = fs.readFileSync(path.join(root, 'dashboard-ui', 'src', 'components', 'ui', 'Button.tsx'), 'utf8');
const switchSource = fs.readFileSync(path.join(root, 'dashboard-ui', 'src', 'components', 'ui', 'Switch.tsx'), 'utf8');
const tailwind = fs.readFileSync(path.join(root, 'dashboard-ui', 'tailwind.config.ts'), 'utf8');

describe('dashboard Obsidian/Ice production invariants', () => {
  it('hat einen CSP-sicheren Obsidian-Default ohne Inline-Theme-Script', () => {
    expect(html).toContain('data-theme="obsidian"');
    expect(html).toContain('class="dark"');
    expect(html).toContain('<meta name="color-scheme" content="dark" />');
    expect(html).not.toMatch(/<script(?![^>]*src=)[^>]*>/i);
  });

  it('persistiert die Palette nur sitzungsbezogen und synchronisiert <html>', () => {
    expect(theme).toContain("const STORAGE_KEY = 'ui.theme.session'");
    expect(theme).toContain("const DEFAULT_THEME: ThemeMode = 'obsidian'");
    expect(theme).toContain("root.setAttribute('data-theme', theme)");
    expect(theme).toContain("root.classList.add('dark')");
    expect(theme).toContain('window.sessionStorage.setItem(STORAGE_KEY, next)');
    expect(theme).not.toContain('window.localStorage');
    expect(main).toContain('<ThemeProvider>');
    expect(main).toContain("import './theme.css'");
  });

  it('stellt den Palette-Toggle im gemeinsamen Desktop/Mobile-Header sichtbar bereit', () => {
    expect(shell).toContain('data-testid="theme-toggle"');
    expect(shell).toContain('onClick={toggleTheme}');
    expect(shell).toContain('Farbschema auf ${nextThemeLabel} umschalten');
    expect(shell).toContain("theme === 'obsidian' ? 'Obsidian' : 'Ice'");
    expect(shell).toContain('theme-toggle-control');
    expect(shell).toContain('{themeLabel}');
    expect(shell).not.toMatch(/hidden[^\n]*theme-toggle/i);
  });

  it('verwendet semantische Tokens fuer Obsidian und Ice statt eines weissen Light-Modes', () => {
    expect(tailwind).toContain("'rgb(var(--color-bg) / <alpha-value>)'");
    expect(tailwind).toContain("DEFAULT: 'rgb(var(--color-accent) / <alpha-value>)'");
    expect(themeCss).toContain('--color-focus: 251 113 133');
    expect(themeCss).toContain('--color-focus: 224 242 254');
    expect(themeCss).toContain("html[data-theme='obsidian'] .glass");
    expect(themeCss).toContain("html[data-theme='ice'] .card-premium");
    expect(themeCss).toContain("html[data-theme='ice'] .input-premium");
    expect(themeCss).toContain("html[data-theme='ice'] .modal-dialog");
    expect(themeCss).not.toContain("html[data-theme='light']");
  });

  it('aendert das komplette Dashboard-Overlay sichtbar zwischen Obsidian und Ice', () => {
    expect(shell).toContain('dashboard-shell');
    expect(shell).toContain('dashboard-sidebar');
    expect(shell).toContain('dashboard-main');
    expect(themeCss).toContain("html[data-theme='obsidian'] .dashboard-sidebar");
    expect(themeCss).toContain("html[data-theme='ice'] .dashboard-sidebar");
    expect(themeCss).toContain("html[data-theme='obsidian'] .dashboard-main");
    expect(themeCss).toContain("html[data-theme='ice'] .dashboard-main");
    expect(themeCss).toContain('rgba(125,211,252,.28)');
    expect(themeCss).toContain('rgba(210,43,58,.08)');
  });

  it('modernisiert gemeinsame Controls nur visuell und respektiert reduzierte Bewegung', () => {
    expect(button).toContain("secondary: 'btn-premium-secondary'");
    expect(button).toContain("outline: 'btn-premium-outline'");
    expect(button).toContain("ghost: 'btn-premium-ghost'");
    expect(switchSource).toContain('switch-premium focus-ring');
    expect(switchSource).toContain('switch-premium-thumb');
    expect(globalCss).toContain('.btn-premium-secondary');
    expect(globalCss).toContain('.btn-premium-outline');
    expect(globalCss).toContain('.btn-premium-ghost');
    expect(globalCss).toContain(".switch-premium[aria-checked='true']");
    expect(globalCss).toContain('@media (hover: hover)');
    expect(globalCss).toContain('@media (prefers-reduced-motion: reduce)');
    expect(globalCss).toContain('animation-delay: 0ms !important');
    expect(globalCss).toContain('transition-delay: 0ms !important');
    expect(globalCss).toContain('rgb(var(--color-focus))');
    expect(themeCss).toContain('.theme-toggle-control:hover');
  });
});
