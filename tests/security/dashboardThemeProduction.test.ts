import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const html = fs.readFileSync(path.join(root, 'dashboard-ui', 'index.html'), 'utf8');
const main = fs.readFileSync(path.join(root, 'dashboard-ui', 'src', 'main.tsx'), 'utf8');
const shell = fs.readFileSync(path.join(root, 'dashboard-ui', 'src', 'components', 'Shell.tsx'), 'utf8');
const theme = fs.readFileSync(path.join(root, 'dashboard-ui', 'src', 'lib', 'theme.tsx'), 'utf8');
const themeCss = fs.readFileSync(path.join(root, 'dashboard-ui', 'src', 'theme.css'), 'utf8');
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

  it('stellt den Palette-Toggle im gemeinsamen Desktop/Mobile-Header bereit', () => {
    expect(shell).toContain('data-testid="theme-toggle"');
    expect(shell).toContain('onClick={toggleTheme}');
    expect(shell).toContain('Farbschema auf ${nextThemeLabel} umschalten');
    expect(shell).toContain("theme === 'obsidian' ? 'Obsidian' : 'Ice'");
    expect(shell).not.toMatch(/hidden[^\n]*theme-toggle/i);
  });

  it('verwendet semantische Tokens fuer Obsidian und Ice statt eines weissen Light-Modes', () => {
    expect(tailwind).toContain("'rgb(var(--color-bg) / <alpha-value>)'");
    expect(tailwind).toContain("DEFAULT: 'rgb(var(--color-accent) / <alpha-value>)'");
    expect(themeCss).toContain("html[data-theme='obsidian'] .glass");
    expect(themeCss).toContain("html[data-theme='ice'] .card-premium");
    expect(themeCss).toContain("html[data-theme='ice'] .input-premium");
    expect(themeCss).toContain("html[data-theme='ice'] .modal-dialog");
    expect(themeCss).not.toContain("html[data-theme='light']");
  });
});
