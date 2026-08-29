import fs from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';

type ButtonKind =
  | 'client-state'
  | 'client-or-delegated'
  | 'read-request'
  | 'write-request'
  | 'download-export'
  | 'navigation-auth';

interface MatrixButton {
  id: string;
  sourceId: string;
  sourceKey: string;
  file: string;
  line: number;
  component: string;
  tag: 'Button' | 'button';
  label: string;
  handler: string;
  kind: ButtonKind;
  hasDisabledGuard: boolean;
  hasLoadingGuard: boolean;
  coverageRef: string;
  profile: ButtonKind;
  pendingGuard: 'source-disabled-or-loading' | 'delegated-reviewed' | 'not-applicable';
  type: string;
}

interface FileCoverage {
  file: string;
  surfaceIds: string[];
  permissions: string[];
  api: string[];
  tests: string[];
  mobile: string[];
}

interface ButtonMatrix {
  schemaVersion: number;
  stage: number;
  inventoriedMainSha: string;
  fieldContract: string[];
  reachableTsxCount: number;
  buttonCount: number;
  countsByKind: Record<ButtonKind, number>;
  checkProfiles: Record<ButtonKind, Record<string, string>>;
  fileCoverage: FileCoverage[];
  buttons: MatrixButton[];
}

const root = process.cwd();
const read = (relative: string): string => fs.readFileSync(path.resolve(root, relative), 'utf8');
const matrix = JSON.parse(read('docs/dashboard-button-matrix.json')) as ButtonMatrix;

// docs/dashboard-button-matrix.json is immutable stage-24 evidence tied to
// inventoriedMainSha. Intentional post-stage changes are tracked explicitly here
// so historical evidence is preserved while the live replacement surfaces stay
// under an equally strict architecture gate.
const POST_STAGE_LABEL_OVERRIDES: Readonly<Record<string, string>> = {
  'dashboard-ui/src/components/KillfeedTab.tsx#KillfeedTab:4': '🌐 Online List',
};
const POST_STAGE_HANDLER_OVERRIDES: Readonly<Record<string, string>> = {
  'dashboard-ui/src/components/economy/LotteryPanel.tsx#LotteryPanel:1': '() => { void current.refetch(); void history.refetch(); void currency.refetch(); }',
};
const CURRENT_KILLFEED_PANEL = 'dashboard-ui/src/components/KillfeedTab.tsx';
const CURRENT_KILLFEED_BUTTON_COUNT = 10;
const CURRENT_FLAG_FEED_BUTTON_SOURCE_ID = `${CURRENT_KILLFEED_PANEL}#KillfeedTab:5`;
const HISTORICAL_VIRTUAL_ACCOUNT_PANEL = 'dashboard-ui/src/components/economy/VirtualAccountsPanel.tsx';
const CURRENT_VIRTUAL_ACCOUNT_PANEL = 'dashboard-ui/src/components/economy/VirtualAccountsControlPanel.tsx';
const CURRENT_VIRTUAL_ACCOUNT_BUTTON_COUNT = 15;
const CURRENT_BLACK_MARKET_PANEL = 'dashboard-ui/src/components/economy/BlackMarketPanel.tsx';
const CURRENT_BLACK_MARKET_BUTTON_COUNT = 10;

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

function classify(label: string, handler: string): ButtonKind {
  const value = `${label} ${handler}`;
  if (/set(?:Tab|View|Mode|Cat|Filter|Open|Expanded|Palette|Sidebar|Query|Show|Creating|Editing|Form|Color|Direction)|toggleTheme|cycle|stopPropagation|onClose|onDone|resetEditor|move(?:Message|Option)|toggleRole|pick\(/i.test(value)) return 'client-state';
  if (/navigate|location\.href|startOAuth|logout|open slot|onRowClick/i.test(value)) return 'navigation-auth';
  if (/refetch|reload|refresh|search\(/i.test(value)) return 'read-request';
  if (/download|export/i.test(value)) return 'download-export';
  if (/mutate|save|delete|remove|create|add|post|repost|sync|reset|run|submit|unlink|force|approve|deny|archive|resolve|cleanup|disable|test\b/i.test(value)) return 'write-request';
  return 'client-or-delegated';
}

function currentButtonSignatures(): Array<Omit<MatrixButton, 'id' | 'sourceKey' | 'line' | 'coverageRef' | 'profile' | 'pendingGuard'>> {
  const excluded = new Set([
    'dashboard-ui/src/components/ui/Button.tsx',
    'dashboard-ui/src/components/ui/Switch.tsx',
  ]);
  const buttons: Array<Omit<MatrixButton, 'id' | 'sourceKey' | 'line' | 'sourceId' | 'coverageRef' | 'profile' | 'pendingGuard'>> = [];
  for (const absolute of reachableUiModules()) {
    if (!absolute.endsWith('.tsx')) continue;
    const file = path.relative(root, absolute).replace(/\\/g, '/');
    if (excluded.has(file)) continue;
    const text = fs.readFileSync(absolute, 'utf8');
    const source = ts.createSourceFile(absolute, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node): void => {
      const element = ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) ? node : null;
      const opening = element ? (ts.isJsxElement(element) ? element.openingElement : element) : null;
      if (opening) {
        const tag = opening.tagName.getText(source);
        if (tag === 'Button' || tag === 'button') {
          const aria = attribute(opening, 'aria-label', source);
          const title = attribute(opening, 'title', source);
          const label = aria || childLabel(element!, source) || title || '<dynamic-or-icon-only>';
          const handler = attribute(opening, 'onClick', source) ?? attribute(opening, 'onSubmit', source) ?? '<delegated-or-submit>';
          buttons.push({
            file,
            component: enclosingComponent(opening),
            tag,
            label: label.slice(0, 240),
            handler: handler.replace(/\s+/g, ' ').slice(0, 300),
            kind: classify(label, handler),
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
  buttons.sort((a, b) => a.file.localeCompare(b.file));
  const ordinals = new Map<string, number>();
  return buttons.map(button => {
    const key = `${button.file}#${button.component}`;
    const ordinal = (ordinals.get(key) ?? 0) + 1;
    ordinals.set(key, ordinal);
    return { ...button, sourceId: `${key}:${ordinal}` };
  });
}

describe('stage 24 dashboard button matrix architecture', () => {
  test('inventories every Button/native button reachable from the real App graph', () => {
    expect(matrix.schemaVersion).toBe(1);
    expect(matrix.stage).toBe(24);
    expect(matrix.inventoriedMainSha).toMatch(/^[a-f0-9]{40}$/);
    expect(matrix.fieldContract).toEqual([
      'permission', 'request', 'effect', 'loading', 'doubleClick', 'race', 'error', 'mobile',
    ]);

    const excluded = new Set([
      'dashboard-ui/src/components/ui/Button.tsx',
      'dashboard-ui/src/components/ui/Switch.tsx',
    ]);
    const actual = [...reachableUiModules()]
      .filter(file => file.endsWith('.tsx'))
      .map(file => path.relative(root, file).replace(/\\/g, '/'))
      .filter(file => !excluded.has(file))
      .map(file => ({ file, count: (read(file).match(/<(?:Button|button)\b/g) ?? []).length }))
      .filter(entry => entry.count > 0)
      .sort((a, b) => a.file.localeCompare(b.file));
    const declared = matrix.fileCoverage
      .map(entry => ({ file: entry.file, count: matrix.buttons.filter(button => button.file === entry.file).length }))
      .sort((a, b) => a.file.localeCompare(b.file));
    const normalizedActual = actual.map(entry => (
      entry.file === CURRENT_KILLFEED_PANEL ? { ...entry, count: entry.count - 1 } : entry
    ));

    // Preserve the immutable stage-24 inventory while requiring deliberate
    // post-stage surfaces to be present with their exact reviewed button counts.
    expect(normalizedActual.filter(entry => (
      entry.file !== CURRENT_VIRTUAL_ACCOUNT_PANEL && entry.file !== CURRENT_BLACK_MARKET_PANEL
    ))).toEqual(declared.filter(entry => (
      entry.file !== HISTORICAL_VIRTUAL_ACCOUNT_PANEL && entry.file !== CURRENT_BLACK_MARKET_PANEL
    )));
    expect(actual.find(entry => entry.file === CURRENT_KILLFEED_PANEL))
      .toEqual({ file: CURRENT_KILLFEED_PANEL, count: CURRENT_KILLFEED_BUTTON_COUNT });
    expect(actual.find(entry => entry.file === CURRENT_VIRTUAL_ACCOUNT_PANEL))
      .toEqual({ file: CURRENT_VIRTUAL_ACCOUNT_PANEL, count: CURRENT_VIRTUAL_ACCOUNT_BUTTON_COUNT });
    expect(actual.find(entry => entry.file === CURRENT_BLACK_MARKET_PANEL))
      .toEqual({ file: CURRENT_BLACK_MARKET_PANEL, count: CURRENT_BLACK_MARKET_BUTTON_COUNT });
    expect(actual.some(entry => entry.file === HISTORICAL_VIRTUAL_ACCOUNT_PANEL)).toBe(false);

    expect(matrix.buttons).toHaveLength(matrix.buttonCount);
    expect(matrix.buttons).toHaveLength(352);
    expect(matrix.fileCoverage).toHaveLength(60);
    expect(matrix.reachableTsxCount).toBe(96);

    const overrideIds = new Set([
      ...Object.keys(POST_STAGE_LABEL_OVERRIDES),
      ...Object.keys(POST_STAGE_HANDLER_OVERRIDES),
    ]);
    expect([...overrideIds].every(sourceId => matrix.buttons.some(button => button.sourceId === sourceId))).toBe(true);

    const declaredSignatures = matrix.buttons.map(({ id: _id, sourceKey: _sourceKey, line: _line, coverageRef: _coverageRef, profile: _profile, pendingGuard: _pendingGuard, ...button }) => ({
      ...button,
      label: POST_STAGE_LABEL_OVERRIDES[button.sourceId] ?? button.label,
      handler: POST_STAGE_HANDLER_OVERRIDES[button.sourceId] ?? button.handler,
    }));
    const currentSignatures = currentButtonSignatures();
    const normalizedCurrentSignatures = currentSignatures
      .filter(button => button.sourceId !== CURRENT_FLAG_FEED_BUTTON_SOURCE_ID)
      .map(button => {
        if (button.file !== CURRENT_KILLFEED_PANEL || button.component !== 'KillfeedTab') return button;
        const prefix = `${CURRENT_KILLFEED_PANEL}#KillfeedTab:`;
        if (!button.sourceId.startsWith(prefix)) return button;
        const ordinal = Number(button.sourceId.slice(prefix.length));
        return ordinal > 5 ? { ...button, sourceId: `${prefix}${ordinal - 1}` } : button;
      });
    expect(normalizedCurrentSignatures.filter(button => (
      button.file !== CURRENT_VIRTUAL_ACCOUNT_PANEL && button.file !== CURRENT_BLACK_MARKET_PANEL
    ))).toEqual(declaredSignatures.filter(button => (
      button.file !== HISTORICAL_VIRTUAL_ACCOUNT_PANEL && button.file !== CURRENT_BLACK_MARKET_PANEL
    )));

    const flagFeedButton = currentSignatures.find(button => button.sourceId === CURRENT_FLAG_FEED_BUTTON_SOURCE_ID);
    expect(flagFeedButton).toMatchObject({
      file: CURRENT_KILLFEED_PANEL,
      component: 'KillfeedTab',
      tag: 'button',
      label: '🚩 Flaggen-Feed',
      kind: 'client-state',
      hasDisabledGuard: false,
      hasLoadingGuard: false,
      type: 'button',
    });
    expect(flagFeedButton?.handler).toContain("setKind('FLAG')");
    expect(flagFeedButton?.handler).toContain('setEditing(null)');

    const replacement = currentSignatures.filter(button => button.file === CURRENT_VIRTUAL_ACCOUNT_PANEL);
    expect(replacement).toHaveLength(CURRENT_VIRTUAL_ACCOUNT_BUTTON_COUNT);
    expect(replacement.every(button => button.label !== '<dynamic-or-icon-only>' && button.label.trim().length > 0)).toBe(true);
    // Native buttons must state type explicitly; shared Button has the separately
    // verified safe type="button" default from the shared component.
    expect(replacement.every(button => button.tag === 'Button' || button.type !== 'implicit-button')).toBe(true);
    const directAsync = replacement.filter(button => /\.mutate\(|\.refetch\(/.test(button.handler));
    expect(directAsync.length).toBeGreaterThan(0);
    expect(directAsync.every(button => button.hasDisabledGuard || button.hasLoadingGuard)).toBe(true);

    const blackMarket = currentSignatures.filter(button => button.file === CURRENT_BLACK_MARKET_PANEL);
    expect(blackMarket).toHaveLength(CURRENT_BLACK_MARKET_BUTTON_COUNT);
    expect(blackMarket.every(button => button.label !== '<dynamic-or-icon-only>' && button.label.trim().length > 0)).toBe(true);
    expect(blackMarket.every(button => button.tag === 'Button' || button.type !== 'implicit-button')).toBe(true);
    const blackMarketDirectAsync = blackMarket.filter(button => /\.mutate\(|\.refetch\(/.test(button.handler));
    expect(blackMarketDirectAsync.length).toBeGreaterThan(0);
    expect(blackMarketDirectAsync.every(button => button.hasDisabledGuard || button.hasLoadingGuard)).toBe(true);
  });

  test('maps every button to all eight mandatory checks and real surface evidence', () => {
    const expectedFields = [...matrix.fieldContract].sort();
    const coverage = new Map(matrix.fileCoverage.map(entry => [entry.file, entry]));
    expect(new Set(matrix.buttons.map(button => button.id)).size).toBe(matrix.buttons.length);
    expect(new Set(matrix.buttons.map(button => button.sourceId)).size).toBe(matrix.buttons.length);

    for (const button of matrix.buttons) {
      expect(button.label).not.toBe('<dynamic-or-icon-only>');
      expect(button.label.trim().length).toBeGreaterThan(0);
      expect(button.profile).toBe(button.kind);
      expect(Object.keys(matrix.checkProfiles[button.profile]).sort()).toEqual(expectedFields);
      expect(button.coverageRef).toBe(button.file);
      const evidence = coverage.get(button.coverageRef);
      expect(evidence).toBeDefined();
      expect(evidence?.surfaceIds.length).toBeGreaterThan(0);
      expect(evidence?.permissions.length).toBeGreaterThan(0);
      expect(evidence?.api.length).toBeGreaterThan(0);
      expect(evidence?.tests.length).toBeGreaterThan(0);
      expect(evidence?.mobile.length).toBeGreaterThan(0);
      expect(fs.existsSync(path.resolve(root, button.file))).toBe(true);
    }
  });

  test('keeps direct read and mutation requests locked while pending', () => {
    const directMutations = matrix.buttons.filter(button => button.handler.includes('.mutate'));
    expect(directMutations.length).toBeGreaterThan(0);
    expect(directMutations.every(button => button.hasDisabledGuard || button.hasLoadingGuard)).toBe(true);

    const directReads = matrix.buttons.filter(button => (
      button.kind === 'read-request'
      && /refetch|reload|refresh/i.test(`${button.label} ${button.handler}`)
    ));
    expect(directReads.length).toBeGreaterThan(0);
    expect(directReads.every(button => button.hasDisabledGuard || button.hasLoadingGuard)).toBe(true);
  });

  test('makes the shared Button safe inside forms and exposes pending state accessibly', () => {
    const source = read('dashboard-ui/src/components/ui/Button.tsx');
    expect(source).toContain("type = 'button'");
    expect(source).toContain('type={type}');
    expect(source).toContain('disabled={disabled || loading}');
    expect(source).toContain('min-h-11');
  });

  test('keeps direct async button families single-flight with visible error handling', () => {
    const translated = read('dashboard-ui/src/components/TranslatedPostsTabV3.tsx');
    expect(translated).toContain('if (busyLock.current) return;');
    expect(translated).toContain('busyLock.current = true;');
    expect(translated).toContain("toast.error(e instanceof ApiError ? e.message : 'Löschen fehlgeschlagen.');");
    expect(translated).toContain("toast.error(e instanceof ApiError ? e.message : 'Statusänderung fehlgeschlagen.');");

    const killfeed = read('dashboard-ui/src/components/KillfeedTab.tsx');
    expect(killfeed).toContain('if (actionLock.current) return;');
    expect(killfeed).toContain('actionLock.current = true;');
    expect(killfeed).toContain('setPendingAction(null);');

    const mirror = read('dashboard-ui/src/pages/dev/NitradoMirror.tsx');
    expect(mirror).toContain('setSnapshotsLoading(true);');
    expect(mirror).toContain('setBrowseLoading(true);');
    expect(mirror).toContain('setFileLoading(true);');
    expect(mirror).toMatch(/invalidateDerivedReads[\s\S]*setSnapshotsLoading\(false\);[\s\S]*setBrowseLoading\(false\);[\s\S]*setFileLoading\(false\);/);

    const uploads = read('dashboard-ui/src/components/DevFileUpload.tsx');
    expect(uploads).toContain('if (operationLock.current) return;');
    expect(uploads).toContain('if (requestSeq !== reloadSeq.current) return;');
    expect(uploads).toContain('if (currentKind.current !== operationKind) return;');
    expect(uploads).toContain('disabled={loading}');
  });

  test('preserves the global mobile touch-target contract for native and shared buttons', () => {
    const theme = read('dashboard-ui/src/theme.css');
    const global = read('dashboard-ui/src/index.css');
    expect(theme).toMatch(/@media \(max-width: 767px\)[\s\S]*button,[\s\S]*min-height: 44px/);
    expect(global).toMatch(/@media \(pointer: coarse\)[\s\S]*button,[\s\S]*min-height: 44px/);
    expect(global).toMatch(/button:not\(\.v-no-touch-min\)[\s\S]*min-width: 44px/);
  });

  test('keeps stage 25 Switch controls outside the button count', () => {
    expect(matrix.buttons.every(button => button.tag === 'Button' || button.tag === 'button')).toBe(true);
    expect(matrix.buttons.every(button => !button.file.endsWith('/ui/Switch.tsx'))).toBe(true);
    expect(read('docs/dashboard-button-matrix.json')).toContain('Reserved for the dedicated toggle matrix in stage 25.');
  });
});