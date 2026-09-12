import fs from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';

const root = process.cwd();
const srcRoot = path.resolve(root, 'src');
const indexFile = path.resolve(srcRoot, 'index.ts');

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTs(absolute));
    else if (entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(absolute);
  }
  return out;
}

function rel(file: string): string {
  return path.relative(root, file).replace(/\\/g, '/');
}

function resolveRelative(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const fromDir = path.dirname(fromFile);
  const absolute = path.resolve(fromDir, specifier);
  const ext = path.extname(absolute);
  const baseWithoutRuntimeExt = /\.(?:js|mjs|cjs)$/.test(ext) ? absolute.slice(0, -ext.length) : absolute;
  const candidates = [
    absolute,
    `${absolute}.ts`,
    `${absolute}.tsx`,
    `${absolute}.json`,
    `${baseWithoutRuntimeExt}.ts`,
    `${baseWithoutRuntimeExt}.tsx`,
    path.join(absolute, 'index.ts'),
    path.join(absolute, 'index.tsx'),
    path.join(baseWithoutRuntimeExt, 'index.ts'),
    path.join(baseWithoutRuntimeExt, 'index.tsx'),
  ];
  return candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ?? null;
}

type EdgeKind = 'static-import' | 'export-from' | 'dynamic-import' | 'require-literal';
type Edge = { from: string; to: string | null; specifier: string; kind: EdgeKind };
type Parsed = {
  edges: Edge[];
  nonLiteralDynamicImports: string[];
  directClientListeners: string[];
};

function parseFile(file: string): Parsed {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const edges: Edge[] = [];
  const nonLiteralDynamicImports: string[] = [];
  const directClientListeners: string[] = [];

  const add = (specifier: string, kind: EdgeKind): void => {
    if (!specifier.startsWith('.')) return;
    edges.push({ from: file, to: resolveRelative(file, specifier), specifier, kind });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      add(node.moduleSpecifier.text, 'static-import');
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      add(node.moduleSpecifier.text, 'export-from');
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteralLike(arg)) add(arg.text, 'dynamic-import');
        else nonLiteralDynamicImports.push(`${rel(file)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteralLike(arg)) add(arg.text, 'require-literal');
      } else if (
        ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === 'client'
        && (node.expression.name.text === 'on' || node.expression.name.text === 'once')
      ) {
        const eventArg = node.arguments[0];
        if (!eventArg || !ts.isStringLiteralLike(eventArg)) {
          directClientListeners.push(`<non-literal>@${rel(file)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
        } else {
          directClientListeners.push(`${node.expression.name.text}:${eventArg.text}@${rel(file)}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { edges, nonLiteralDynamicImports, directClientListeners };
}

const sourceFiles = walkTs(srcRoot);
const parsed = new Map(sourceFiles.map(file => [file, parseFile(file)]));

function commandRoots(): string[] {
  return ['user', 'admin', 'developer', 'dashboard']
    .flatMap(dir => {
      const absolute = path.resolve(srcRoot, 'commands', dir);
      return fs.existsSync(absolute) ? walkTs(absolute) : [];
    });
}

function reachableFrom(roots: Iterable<string>): Set<string> {
  const reached = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const file = pending.pop();
    if (!file || reached.has(file)) continue;
    reached.add(file);
    const info = parsed.get(file);
    if (!info) continue;
    for (const edge of info.edges) {
      if (edge.to && edge.to.startsWith(srcRoot) && /\.tsx?$/.test(edge.to) && !reached.has(edge.to)) pending.push(edge.to);
    }
  }
  return reached;
}

const productionRoots = [indexFile, ...commandRoots()];
const reachable = reachableFrom(productionRoots);
const indexEdges = parsed.get(indexFile)?.edges ?? [];
const directIndexEventRoots = indexEdges
  .map(edge => edge.to)
  .filter((target): target is string => Boolean(target && path.dirname(target) === path.resolve(srcRoot, 'events')));
const eventReachable = reachableFrom(directIndexEventRoots);
const eventFiles = walkTs(path.resolve(srcRoot, 'events'));

function unresolvedReachableEdges(): string[] {
  return [...reachable]
    .flatMap(file => parsed.get(file)?.edges ?? [])
    .filter(edge => edge.specifier.startsWith('.') && edge.to === null)
    .map(edge => `${rel(edge.from)} -> ${edge.specifier} (${edge.kind})`)
    .sort();
}

describe('Stage 61 complete runtime registry/reachability audit', () => {
  it('keeps every Discord event module reachable from the production index event registry', () => {
    expect(directIndexEventRoots.length).toBeGreaterThan(5);
    const orphanEvents = eventFiles.filter(file => !eventReachable.has(file)).map(rel).sort();
    expect(orphanEvents).toEqual([]);

    // interactionCreate is intentionally behind interactionCreateComposite; this
    // assertion prevents a future static-only cleanup from deleting that live path.
    expect(eventReachable.has(path.resolve(srcRoot, 'events', 'interactionCreate.ts'))).toBe(true);
    expect(directIndexEventRoots.map(rel)).toContain('src/events/interactionCreateComposite.ts');
  });

  it('resolves every relative static/dynamic runtime edge reachable from index or filesystem-loaded commands', () => {
    expect(sourceFiles.length).toBeGreaterThan(100);
    expect(commandRoots().length).toBeGreaterThan(10);
    expect(reachable.size).toBeGreaterThan(100);
    expect(unresolvedReachableEdges()).toEqual([]);
  });

  it('follows all literal dynamic imports and forbids opaque dynamic-import expressions on reachable production paths', () => {
    const reachableParsed = [...reachable].map(file => parsed.get(file)!);
    const dynamicEdges = reachableParsed.flatMap(info => info.edges.filter(edge => edge.kind === 'dynamic-import'));
    expect(dynamicEdges.length).toBeGreaterThan(5);
    expect(dynamicEdges.every(edge => edge.to !== null)).toBe(true);
    expect(reachableParsed.flatMap(info => info.nonLiteralDynamicImports)).toEqual([]);
  });

  it('inventories direct Discord client listeners outside the BotEvent registry with literal names', () => {
    const listeners = parsed.get(indexFile)?.directClientListeners ?? [];
    expect(listeners).toEqual(expect.arrayContaining([
      'once:clientReady@src/index.ts',
      'on:guildCreate@src/index.ts',
      'on:guildUpdate@src/index.ts',
    ]));
    expect(listeners.some(listener => listener.startsWith('<non-literal>'))).toBe(false);
  });

  it('keeps the filesystem command loader itself on the reachable production graph', () => {
    const handler = path.resolve(srcRoot, 'commands', 'handler.ts');
    expect(reachable.has(handler)).toBe(true);
    const source = fs.readFileSync(handler, 'utf8');
    expect(source).toContain('fs.readdirSync(dir)');
    expect(source).toContain('require(path.join(dir, file))');
  });
});
