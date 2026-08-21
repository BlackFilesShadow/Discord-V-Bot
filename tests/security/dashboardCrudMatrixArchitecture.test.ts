import fs from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';

const root = process.cwd();
const read = (relative: string): string => fs.readFileSync(path.resolve(root, relative), 'utf8');

interface SurfaceInventoryEntry {
  id: string;
  actions?: string[];
}
interface SurfaceInventory { surfaces: SurfaceInventoryEntry[] }
interface CrudEntry { surface: string; evidence: string[] }
interface CrudMatrix {
  schemaVersion: number;
  stage: number;
  basedOnMainSha: string;
  persistentCrud: CrudEntry[];
  ephemeralCrud: CrudEntry[];
  operationalActions: CrudEntry[];
  transportExceptions: Array<{ file: string; reason: string }>;
}

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

function directFetchFiles(): string[] {
  const result = new Set<string>();
  for (const absolute of reachableUiModules()) {
    if (!absolute.endsWith('.ts') && !absolute.endsWith('.tsx')) continue;
    const source = ts.createSourceFile(
      absolute,
      fs.readFileSync(absolute, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      absolute.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'fetch') {
        result.add(path.relative(root, absolute).replace(/\\/g, '/'));
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...result].sort();
}

function matrix(): CrudMatrix {
  return JSON.parse(read('docs/dashboard-crud-matrix.json')) as CrudMatrix;
}

function inventory(): SurfaceInventory {
  return JSON.parse(read('docs/dashboard-surface-inventory.json')) as SurfaceInventory;
}

const MUTATION_SHAPED_ACTION = /\b(create|update|delete|configure|manage|activate|deactivate|revoke|toggle|sync|upload|post|repost|trigger|perform|enable|disable|remove|export)\b|step up|log out/i;

describe('stage 26 dashboard CRUD matrix architecture', () => {
  test('classifies every mutation-shaped stage-23 surface exactly once', () => {
    const doc = matrix();
    const source = inventory();
    expect(doc.schemaVersion).toBe(1);
    expect(doc.stage).toBe(26);
    expect(doc.basedOnMainSha).toBe('d71b21e495da5d309d5776df9d545bce42b0ba8d');

    const entries = [...doc.persistentCrud, ...doc.ephemeralCrud, ...doc.operationalActions];
    const ids = entries.map(entry => entry.surface);
    expect(new Set(ids).size).toBe(ids.length);

    const inventoryIds = new Set(source.surfaces.map(surface => surface.id));
    for (const entry of entries) {
      expect(inventoryIds.has(entry.surface)).toBe(true);
      expect(entry.evidence.length).toBeGreaterThan(0);
      for (const evidence of entry.evidence) {
        expect(fs.existsSync(path.resolve(root, evidence))).toBe(true);
      }
    }

    const classified = new Set(ids);
    const mutationCandidates = source.surfaces
      .filter(surface => (surface.actions ?? []).some(action => MUTATION_SHAPED_ACTION.test(action)))
      .map(surface => surface.id)
      .sort();
    const missing = mutationCandidates.filter(id => !classified.has(id));
    expect(missing).toEqual([]);
  });

  test('central JSON/FormData mutation client keeps scope and idempotency fail-closed', () => {
    const source = read('dashboard-ui/src/lib/api.ts');
    expect(source).toContain('const scopedPath = withServerSlotScope(path);');
    expect(source).toContain("if (method !== 'GET')");
    expect(source).toContain("headers['X-Idempotency-Key'] = lease.key;");
    expect(source).toContain('acquireMutationIdempotencyKey(signature)');
    expect(source).toContain('if (lease) releaseMutationIdempotencyKey(lease);');
    expect(source).toContain("'X-Idempotency-Key': createIdempotencyKey()");
    expect(source).toContain("credentials: 'include'");
  });

  test('reachable direct fetch usage is restricted to the reviewed transport exceptions', () => {
    const doc = matrix();
    const allowed = new Set([
      'dashboard-ui/src/lib/api.ts',
      ...doc.transportExceptions.map(entry => entry.file),
    ]);
    expect(directFetchFiles()).toEqual([...allowed].sort());

    const shell = read('dashboard-ui/src/components/Shell.tsx');
    expect(shell).toContain("fetch('/auth/logout', { method: 'POST', credentials: 'include' })");

    const exportSource = read('dashboard-ui/src/pages/dev/SecureDevExport.tsx');
    expect(exportSource).toContain("method: 'POST'");
    expect(exportSource).toContain("credentials: 'include'");
    expect(exportSource).toContain("'X-Idempotency-Key': idempotencyKey()");
  });

  test('Nitrado Create normalizes aliases before persistence and audit', () => {
    const source = read('src/dashboard/routes/v2/nitrado.ts');
    expect(source).toContain("const normalizedAlias = typeof alias === 'string' ? alias.trim() : '';");
    expect(source).toContain('normalizedAlias.length < 1 || normalizedAlias.length > 40');
    expect(source).toContain('alias: normalizedAlias,');
    expect(source).toContain('details: { slot, alias: normalizedAlias, alias5: created.alias5 }');
  });

  test('DEV upload auto-selection uses the fresh read snapshot, never stale React state', () => {
    const source = read('dashboard-ui/src/components/DevFileUpload.tsx');
    expect(source).toContain('const freshUploads = await reload();');
    expect(source).toContain('freshUploads?.find(u => u.id === firstOk.id)');
    expect(source).not.toContain('const rec = uploads.find(u => u.id === firstOk.id)');
  });
});
