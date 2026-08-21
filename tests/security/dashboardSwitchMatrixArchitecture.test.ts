import fs from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';

const root = process.cwd();
const read = (relative: string): string => fs.readFileSync(path.resolve(root, relative), 'utf8');

function resolveUiModule(from: string, specifier: string): string | null {
  const srcRoot = path.resolve(root, 'dashboard-ui/src');
  let base: string;
  if (specifier.startsWith('.')) base = path.resolve(path.dirname(from), specifier);
  else if (specifier.startsWith('@/')) base = path.resolve(srcRoot, specifier.slice(2));
  else return null;
  return [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]
    .find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ?? null;
}

function reachableUiModules(): Set<string> {
  const pending = [path.resolve(root, 'dashboard-ui/src/App.tsx')];
  const reached = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop();
    if (!file || reached.has(file)) continue;
    reached.add(file);
    const source = fs.readFileSync(file, 'utf8');
    const specs = [
      ...source.matchAll(/(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g),
      ...source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g),
    ].map(match => match[1]);
    for (const specifier of specs) {
      const resolved = resolveUiModule(file, specifier);
      if (resolved && !reached.has(resolved)) pending.push(resolved);
    }
  }
  return reached;
}

function attribute(node: ts.JsxOpeningLikeElement, name: string, source: ts.SourceFile): string | null {
  const item = node.attributes.properties.find(property => (
    ts.isJsxAttribute(property) && property.name.getText(source) === name
  ));
  if (!item || !ts.isJsxAttribute(item)) return null;
  if (!item.initializer) return 'true';
  if (ts.isStringLiteral(item.initializer)) return item.initializer.text;
  if (ts.isJsxExpression(item.initializer)) return item.initializer.expression?.getText(source) ?? '';
  return item.initializer.getText(source);
}

interface SwitchSource {
  file: string;
  component: string;
  checked: string | null;
  onChange: string | null;
  label: string | null;
  ariaLabel: string | null;
  disabled: string | null;
}

function enclosingComponent(node: ts.Node): string {
  let current = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current))
      && ts.isVariableDeclaration(current.parent)
      && ts.isIdentifier(current.parent.name)
    ) return current.parent.name.text;
    current = current.parent;
  }
  return '<module>';
}

function switches(): SwitchSource[] {
  const result: SwitchSource[] = [];
  for (const absolute of reachableUiModules()) {
    if (!absolute.endsWith('.tsx')) continue;
    const file = path.relative(root, absolute).replace(/\\/g, '/');
    if (file === 'dashboard-ui/src/components/ui/Switch.tsx') continue;
    const source = ts.createSourceFile(absolute, fs.readFileSync(absolute, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node): void => {
      const opening = ts.isJsxElement(node)
        ? node.openingElement
        : ts.isJsxSelfClosingElement(node)
          ? node
          : null;
      if (opening && opening.tagName.getText(source) === 'Switch') {
        result.push({
          file,
          component: enclosingComponent(opening),
          checked: attribute(opening, 'checked', source),
          onChange: attribute(opening, 'onChange', source),
          label: attribute(opening, 'label', source),
          ariaLabel: attribute(opening, 'ariaLabel', source),
          disabled: attribute(opening, 'disabled', source),
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return result.sort((a, b) => `${a.file}#${a.component}`.localeCompare(`${b.file}#${b.component}`));
}

function requireContractValue(value: string | null, message: string): void {
  if (!value) throw new Error(message);
}

describe('stage 25 dashboard switch matrix architecture', () => {
  test('inventories every reachable Switch and requires an explicit state contract', () => {
    const inventory = switches();
    expect(inventory.length).toBeGreaterThan(0);
    for (const entry of inventory) {
      requireContractValue(entry.checked, `${entry.file}#${entry.component} missing checked`);
      requireContractValue(entry.onChange, `${entry.file}#${entry.component} missing onChange`);
      requireContractValue(entry.label || entry.ariaLabel, `${entry.file}#${entry.component} missing accessible name`);
    }
  });

  test('keeps Switch usage restricted to the reviewed stage-25 surface set', () => {
    const reviewed = new Set([
      'dashboard-ui/src/pages/ServerSlot.tsx',
      'dashboard-ui/src/components/LeaveCleanupPanel.tsx',
      'dashboard-ui/src/components/GoodbyePanel.tsx',
      'dashboard-ui/src/components/FeedsTab.tsx',
      'dashboard-ui/src/components/EmbedBuilderTab.tsx',
      'dashboard-ui/src/components/WelcomeCoreTab.tsx',
      'dashboard-ui/src/components/ReactionEmbedsTab.tsx',
      'dashboard-ui/src/components/economy/VirtualAccountsPanel.tsx',
    ]);
    const files = new Set(switches().map(entry => entry.file));
    expect([...files].sort()).toEqual([...reviewed].sort());
  });

  test('shared Switch exposes semantic state, disabled state and mobile-safe interaction', () => {
    const source = read('dashboard-ui/src/components/ui/Switch.tsx');
    expect(source).toContain('role="switch"');
    expect(source).toContain('aria-checked={checked}');
    expect(source).toContain('aria-label={accessibleName}');
    expect(source).toContain('aria-disabled={disabled || undefined}');
    expect(source).toContain('disabled={disabled}');
    expect(source).toContain("type=\"button\"");
    expect(source).toContain('min-h-11');
    expect(source).toContain('aria-hidden="true"');
  });

  test('keeps destructive leave-cleanup toggle staged behind explicit save/confirmation', () => {
    const source = read('dashboard-ui/src/components/LeaveCleanupPanel.tsx');
    expect(source).toContain('onChange={setEnabled}');
    expect(source).toContain('if (enabled && !saved)');
    expect(source).toContain('const ok = confirm(');
    expect(source).toContain('await api.post(`/api/v2/guilds/${guildId}/leave-cleanup/config`');
    expect(source).toContain('disabled={busy || !changed}');
  });

  test('keeps server toggle writes scoped through the slot settings endpoint', () => {
    const source = read('dashboard-ui/src/pages/ServerSlot.tsx');
    expect(source).toContain('`/api/v2/guilds/${guildId}/dashboard/server/${slot}/settings`');
    expect(source).toContain('onChange={v => updateSettings.mutate({ whitelistActive: v })}');
    expect(source).toContain('onChange={v => updateSettings.mutate({ economyActive: v })}');
    expect(source).toContain('onChange={v => updateSettings.mutate({ permaOnly: v })}');
  });
});
