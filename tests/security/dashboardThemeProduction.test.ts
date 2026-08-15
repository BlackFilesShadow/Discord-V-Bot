import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const html = fs.readFileSync(path.join(root, 'dashboard-ui', 'index.html'), 'utf8');
const main = fs.readFileSync(path.join(root, 'dashboard-ui', 'src', 'main.tsx'), 'utf8');
const shell = fs.readFileSync(path.join(root, 'dashboard-ui', 'src', 'components', 'Shell.tsx'), 'utf8');
const theme = fs.readFileSync(path.join(root, 'dashboard-ui', 'src', 'lib', 'theme.tsx'), 'utf8');
const themeCss = fs.readFileSync(path.join(root, 'dashboard-ui', 'src', 'theme.css'), 'utf8');
const tailwind = fs.readFileSync(path.join(root, 'dashboard-ui', 'tailwind.config.ts'), 'utf8');

describe('dashboard light/dark production invariants', () => {
  it('hat einen CSP-sicheren Dark-Default ohne Inline-Theme-Script', () => {
    expect(html).toContain('data-theme="dark"');
    expect(html).toContain('class="dark"');
    expect(html).toContain('<meta name="color-scheme" content="dark light" />');
    expect(html).not.toMatch(/<script(?![^>]*src=)[^>]*>/i);
  });

  it('persistiert das Theme nur als UI-Praeferenz und synchronisiert <html>', () => {
    expect(theme).toContain("const STORAGE_KEY = 'ui.theme'");
    expect(theme).toContain("root.setAttribute('data-theme', theme)");
    expect(theme).toContain("root.classList.toggle('dark', theme === 'dark')");
    expect(theme).toContain('window.localStorage.setItem(STORAGE_KEY, next)');
    expect(main).toContain('<ThemeProvider>');
    expect(main).toContain("import './theme.css'");
  });

  it('stellt den Theme-Toggle im gemeinsamen Desktop/Mobile-Header bereit', () => {
    expect(shell).toContain('data-testid="theme-toggle"');
    expect(shell).toContain('onClick={toggleTheme}');
    expect(shell).toContain('Darstellung auf ${nextThemeLabel} umschalten');
    expect(shell).not.toMatch(/hidden[^\n]*theme-toggle/i);
  });

  it('verwendet semantische Tailwind-Tokens und echte Light-Surfaces', () => {
    expect(tailwind).toContain("'rgb(var(--color-bg) / <alpha-value>)'");
    expect(tailwind).toContain("white: 'rgb(var(--color-fg) / <alpha-value>)'");
    expect(themeCss).toContain("html[data-theme='light'] .glass");
    expect(themeCss).toContain("html[data-theme='light'] .card-premium");
    expect(themeCss).toContain("html[data-theme='light'] .input-premium");
    expect(themeCss).toContain("html[data-theme='light'] .modal-dialog");
  });
});
