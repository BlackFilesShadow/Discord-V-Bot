import fs from 'node:fs';
import path from 'node:path';

const read = (relative: string): string => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');

describe('dashboard vivid color architecture', () => {
  const main = read('dashboard-ui/src/main.tsx');
  const vivid = read('dashboard-ui/src/vivid-theme.css');
  const sectionTabs = read('dashboard-ui/src/components/ui/SectionTabs.tsx');

  it('loads the vivid presentation layer after the canonical theme', () => {
    expect(main).toContain("import './theme.css';");
    expect(main).toContain("import './vivid-theme.css';");
    expect(main.indexOf("import './theme.css';")).toBeLessThan(main.indexOf("import './vivid-theme.css';"));
  });

  it('keeps both dashboard themes vivid through shared semantic tokens', () => {
    expect(vivid).toContain("html[data-theme='obsidian']");
    expect(vivid).toContain("html[data-theme='ice']");
    expect(vivid).toContain('--color-accent: 239 45 66;');
    expect(vivid).toContain('--color-accent: 34 211 238;');
    expect(vivid).toContain('--color-ok:');
    expect(vivid).toContain('--color-warn:');
    expect(vivid).toContain('--color-danger:');
    expect(vivid).toContain('--color-info:');
    expect(vivid).toContain('--color-planned:');
  });

  it('strengthens the shared button, switch, badge and selected-navigation surfaces', () => {
    expect(vivid).toContain('.btn-premium-primary');
    expect(vivid).toContain('.btn-premium-secondary');
    expect(vivid).toContain('.btn-premium-outline');
    expect(vivid).toContain('.btn-premium-danger');
    expect(vivid).toContain(".switch-premium[aria-checked='true']");
    expect(vivid).toContain('.pill-glow-ok');
    expect(vivid).toContain('.pill-glow-warn');
    expect(vivid).toContain('.pill-glow-danger');
    expect(vivid).toContain('.pill-glow-info');
    expect(vivid).toContain('.pill-glow-planned');
    expect(vivid).toContain("[class*='bg-accent/20']");
  });

  it('uses an explicit section-tab hook so badge styling cannot leak into labels', () => {
    expect(sectionTabs).toContain('className="section-tabs');
    expect(sectionTabs).toContain('data-section-badge');
    expect(vivid).toContain(".section-tabs button[aria-current='page'] [data-section-badge]");
    expect(vivid).not.toContain("span span:last-child:not(:only-child)");
  });

  it('remains presentation-only and does not introduce runtime API behaviour', () => {
    expect(vivid).not.toContain('/api/');
    expect(vivid).not.toContain('fetch(');
    expect(vivid).not.toContain('mutation');
    expect(vivid).not.toContain('permission');
  });
});
