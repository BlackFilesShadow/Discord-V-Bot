import fs from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';

type ButtonKind = 'client-state' | 'client-or-delegated' | 'read-request' | 'write-request' | 'download-export' | 'navigation-auth';
interface MatrixButton {
  id: string; sourceId: string; sourceKey: string; file: string; line: number; component: string;
  tag: 'Button' | 'button'; label: string; handler: string; kind: ButtonKind;
  hasDisabledGuard: boolean; hasLoadingGuard: boolean; coverageRef: string; profile: ButtonKind;
  pendingGuard: 'source-disabled-or-loading' | 'delegated-reviewed' | 'not-applicable'; type: string;
}
interface FileCoverage { file: string; surfaceIds: string[]; permissions: string[]; api: string[]; tests: string[]; mobile: string[]; }
interface ButtonMatrix {
  schemaVersion: number; stage: number; inventoriedMainSha: string; fieldContract: string[];
  reachableTsxCount: number; buttonCount: number; countsByKind: Record<ButtonKind, number>;
  checkProfiles: Record<ButtonKind, Record<string, string>>; fileCoverage: FileCoverage[]; buttons: MatrixButton[];
}

const root = process.cwd();
const read = (relative: string): string => fs.readFileSync(path.resolve(root, relative), 'utf8');
const matrix = JSON.parse(read('docs/dashboard-button-matrix.json')) as ButtonMatrix;

const HISTORICAL_VIRTUAL_ACCOUNT_PANEL = 'dashboard-ui/src/components/economy/VirtualAccountsPanel.tsx';
const CURRENT_VIRTUAL_ACCOUNT_PANEL = 'dashboard-ui/src/components/economy/VirtualAccountsControlPanel.tsx';
const CURRENT_BLACK_MARKET_PANEL = 'dashboard-ui/src/components/economy/BlackMarketPanel.tsx';
const CURRENT_BLACK_MARKET_DISCORD_SETTINGS = 'dashboard-ui/src/components/economy/BlackMarketDiscordSettings.tsx';
const CURRENT_KILLFEED_PANEL = 'dashboard-ui/src/components/KillfeedTab.tsx';
const CURRENT_GOODBYE_PANEL = 'dashboard-ui/src/components/GoodbyePanel.tsx';
const CURRENT_SERVER_SLOT = 'dashboard-ui/src/pages/ServerSlot.tsx';

const REVIEWED_POST_STAGE_FILES = new Set([
  HISTORICAL_VIRTUAL_ACCOUNT_PANEL,
  CURRENT_VIRTUAL_ACCOUNT_PANEL,
  CURRENT_BLACK_MARKET_PANEL,
  CURRENT_BLACK_MARKET_DISCORD_SETTINGS,
  CURRENT_KILLFEED_PANEL,
  CURRENT_GOODBYE_PANEL,
  CURRENT_SERVER_SLOT,
]);

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
  const item = node.attributes.properties.find(property => ts.isJsxAttribute(property) && property.name.getText(source) === name);
  if (!item || !ts.isJsxAttribute(item)) return null;
  if (!item.initializer) return 'true';
  if (ts.isStringLiteral(item.initializer)) return item.initializer.text;
  if (ts.isJsxExpression(item.initializer)) return item.initializer.expression?.getText(source) ?? '';
  return item.initializer.getText(source);
}

function enclosingComponent(node: ts.Node): string {
  let current = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current)) && ts.isVariableDeclaration(current.parent) && ts.isIdentifier(current.parent.name)) return current.parent.name.text;
    current = current.parent;
  }
  return '<module>';
}

function childLabel(node: ts.JsxElement | ts.JsxSelfClosingElement, source: ts.SourceFile): string {
  const labels: string[] = [];
  const visit = (child: ts.Node): void => {
    if (ts.isJsxText(child)) {
      const value = child.text.replace(/\s+/g, ' ').trim();
      if (value) labels.push(value);
      return;
    }
    if (ts.isJsxExpression(child) && child.expression) {
      if (ts.isStringLiteral(child.expression) || ts.isNoSubstitutionTemplateLiteral(child.expression)) labels.push(child.expression.text);
      else if (ts.isConditionalExpression(child.expression)) labels.push(child.expression.getText(source));
      else if (ts.isIdentifier(child.expression) || ts.isPropertyAccessExpression(child.expression)) labels.push(`{${child.expression.getText(source)}}`);
      return;
    }
    ts.forEachChild(child, visit);
  };
  if (ts.isJsxElement(node)) node.children.forEach(visit);
  return labels.join(' ').replace(/\s+/g, ' ').trim();
}

interface CurrentButton {
  file: string; component: string; tag: 'Button' | 'button'; label: string; handler: string;
  hasDisabledGuard: boolean; hasLoadingGuard: boolean; type: string;
}

function currentButtons(): CurrentButton[] {
  const excluded = new Set(['dashboard-ui/src/components/ui/Button.tsx', 'dashboard-ui/src/components/ui/Switch.tsx']);
  const rows: CurrentButton[] = [];
  for (const absolute of reachableUiModules()) {
    if (!absolute.endsWith('.tsx')) continue;
    const file = path.relative(root, absolute).replace(/\\/g, '/');
    if (excluded.has(file)) continue;
    const source = ts.createSourceFile(absolute, fs.readFileSync(absolute, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node): void => {
      const element = ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) ? node : null;
      const opening = element ? (ts.isJsxElement(element) ? element.openingElement : element) : null;
      if (opening) {
        const tag = opening.tagName.getText(source);
        if (tag === 'Button' || tag === 'button') {
          const label = attribute(opening, 'aria-label', source) || childLabel(element!, source) || attribute(opening, 'title', source) || '<dynamic-or-icon-only>';
          rows.push({
            file,
            component: enclosingComponent(opening),
            tag: tag as 'Button' | 'button',
            label,
            handler: attribute(opening, 'onClick', source) ?? attribute(opening, 'onSubmit', source) ?? '<delegated-or-submit>',
            hasDisabledGuard: attribute(opening, 'disabled', source) !== null,
            hasLoadingGuard: attribute(opening, 'loading', source) !== null,
            type: attribute(opening, 'type', source) ?? 'implicit-button',
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return rows;
}

describe('stage 24 dashboard button matrix architecture', () => {
  test('keeps the immutable historical evidence internally complete', () => {
    expect(matrix.schemaVersion).toBe(1);
    expect(matrix.stage).toBe(24);
    expect(matrix.inventoriedMainSha).toMatch(/^[a-f0-9]{40}$/);
    expect(matrix.buttons).toHaveLength(matrix.buttonCount);
    expect(matrix.buttons).toHaveLength(352);
    expect(new Set(matrix.buttons.map(button => button.id)).size).toBe(matrix.buttons.length);
    expect(new Set(matrix.buttons.map(button => button.sourceId)).size).toBe(matrix.buttons.length);
    for (const entry of matrix.fileCoverage) {
      expect(entry.surfaceIds.length).toBeGreaterThan(0);
      expect(entry.permissions.length).toBeGreaterThan(0);
      expect(entry.api.length).toBeGreaterThan(0);
      expect(entry.tests.length).toBeGreaterThan(0);
      expect(entry.mobile.length).toBeGreaterThan(0);
    }
  });

  test('unchanged reachable files still match the historical per-file inventory exactly', () => {
    const excluded = new Set(['dashboard-ui/src/components/ui/Button.tsx', 'dashboard-ui/src/components/ui/Switch.tsx']);
    const actual = [...reachableUiModules()]
      .filter(file => file.endsWith('.tsx'))
      .map(file => path.relative(root, file).replace(/\\/g, '/'))
      .filter(file => !excluded.has(file) && !REVIEWED_POST_STAGE_FILES.has(file))
      .map(file => ({ file, count: (read(file).match(/<(?:Button|button)\b/g) ?? []).length }))
      .filter(entry => entry.count > 0)
      .sort((a, b) => a.file.localeCompare(b.file));
    const declared = matrix.fileCoverage
      .filter(entry => !REVIEWED_POST_STAGE_FILES.has(entry.file))
      .map(entry => ({ file: entry.file, count: matrix.buttons.filter(button => button.file === entry.file).length }))
      .sort((a, b) => a.file.localeCompare(b.file));
    expect(actual).toEqual(declared);
  });

  test('current buttons remain named, form-safe and direct async actions are single-flight guarded', () => {
    const rows = currentButtons();
    expect(rows.length).toBeGreaterThan(300);
    for (const button of rows) {
      expect(button.label).not.toBe('<dynamic-or-icon-only>');
      expect(button.label.trim().length).toBeGreaterThan(0);
      if (button.tag === 'button') expect(button.type).not.toBe('implicit-button');
      if (/\.mutate\(|\.refetch\(/.test(button.handler)) {
        expect(button.hasDisabledGuard || button.hasLoadingGuard).toBe(true);
      }
    }
  });

  test('Page 1 stays unchanged while Page 2 contains only the requested separated surfaces plus Killfeed', () => {
    const source = read(CURRENT_SERVER_SLOT);
    const pageOne = source.indexOf("['settings', 'Settings', Settings]");
    expect(pageOne).toBeGreaterThanOrEqual(0);
    expect(source.indexOf("['whitelist', 'Whitelist', Shield]", pageOne)).toBeGreaterThan(pageOne);
    expect(source.indexOf("['economy', 'Economy', Coins]", pageOne)).toBeGreaterThan(pageOne);
    expect(source.indexOf("['links', 'Economy-Links', LinkIcon]", pageOne)).toBeGreaterThan(pageOne);
    expect(source).toContain("['virtual-accounts', 'Virtuelle Konten', Banknote]");
    expect(source).toContain("['bank-casino', 'Bank und Casino Funktionen', Dice5]");
    expect(source).toContain("['killfeed', 'Killfeed & ADM', Crosshair]");
    expect(source).toContain("tab === 'virtual-accounts'");
    expect(source).toContain("tab === 'bank-casino'");
    expect(source).not.toContain('function AdminPayForm');
    expect(source).not.toContain('/admin-pay?slot=');
  });

  test('changed economy surfaces have explicit accessible controls and no hidden legacy market limit controls', () => {
    const accounts = read(CURRENT_VIRTUAL_ACCOUNT_PANEL);
    const market = read(CURRENT_BLACK_MARKET_PANEL);
    expect(accounts).toContain('>Audit</Button>');
    expect(accounts).toContain("'Wirklich löschen?' : 'Löschen'");
    expect(accounts).toContain('Grund (optional)');
    expect(accounts).toContain('Discord-User / GUID');
    expect(market).toContain('Angebot ${row.name} entfernen');
    expect(market).not.toContain('Max. pro Kauf');
    expect(market).not.toContain('maxPerPurchase');
  });

  test('shared Button and global CSS preserve pending/form/mobile contracts', () => {
    const button = read('dashboard-ui/src/components/ui/Button.tsx');
    const theme = read('dashboard-ui/src/theme.css');
    const global = read('dashboard-ui/src/index.css');
    expect(button).toContain("type = 'button'");
    expect(button).toContain('type={type}');
    expect(button).toContain('disabled={disabled || loading}');
    expect(button).toContain('min-h-11');
    expect(theme).toMatch(/@media \(max-width: 767px\)[\s\S]*button,[\s\S]*min-height: 44px/);
    expect(global).toMatch(/@media \(pointer: coarse\)[\s\S]*button,[\s\S]*min-height: 44px/);
  });
});
