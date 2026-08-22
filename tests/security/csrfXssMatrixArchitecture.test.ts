import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const r = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), 'utf8');
const m = JSON.parse(r('docs/csrf-xss-matrix.json')) as { stage: number; cases: unknown[] };
const auth = r('src/dashboard/routes/auth.ts');
const server = r('src/dashboard/server.ts');
const csrfRuntime = r('tests/security/csrfPkceRuntime.test.ts');
const originRuntime = r('tests/security/csrfMutationOrigin.test.ts');

function walk(dir: string, out: string[] = []): string[] {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (/\.(tsx|ts)$/.test(ent.name)) out.push(p);
  }
  return out;
}

describe('Stage 41 CSRF XSS matrix', () => {
  it('documents cases', () => {
    expect(m.stage).toBe(41);
    expect(m.cases.length).toBeGreaterThanOrEqual(4);
  });

  it('keeps OAuth state and cookie/cors hardening', () => {
    expect(auth).toContain('generateCsrfToken');
    expect(auth).toContain('generatePKCE');
    expect(server).toContain("sameSite: 'lax'");
    expect(server).toContain('httpOnly: true');
    expect(server).toContain('credentials: true');
    expect(server).toContain('origin: config.dashboard.url');
    expect(server).toContain('createMutationOriginGuard(config.dashboard.url)');
  });

  it('has no executable DOM/JS injection sinks in dashboard source ASTs', () => {
    const roots = [
      path.resolve(process.cwd(), 'dashboard-ui/src'),
      path.resolve(process.cwd(), 'src/dashboard'),
    ];
    const findings: string[] = [];

    for (const root of roots) {
      for (const file of walk(root)) {
        const source = fs.readFileSync(file, 'utf8');
        const sf = ts.createSourceFile(
          file,
          source,
          ts.ScriptTarget.Latest,
          true,
          file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
        );
        const line = (node: ts.Node): number => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        const add = (node: ts.Node, sink: string): void => {
          findings.push(`${path.relative(process.cwd(), file)}:${line(node)}:${sink}`);
        };
        const visit = (node: ts.Node): void => {
          if (ts.isJsxAttribute(node)) {
            const attributeName = node.name.getText(sf);
            if (attributeName === 'dangerouslySetInnerHTML') {
              add(node, 'dangerouslySetInnerHTML');
            }
            if (
              ['href', 'src'].includes(attributeName)
              && node.initializer
              && ts.isStringLiteral(node.initializer)
              && /^\s*javascript:/i.test(node.initializer.text)
            ) {
              add(node, `${attributeName}=javascript:`);
            }
          }
          if (
            ts.isBinaryExpression(node)
            && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
            && ts.isPropertyAccessExpression(node.left)
            && ['innerHTML', 'outerHTML'].includes(node.left.name.text)
          ) {
            add(node, node.left.name.text);
          }
          if (ts.isCallExpression(node)) {
            if (ts.isIdentifier(node.expression) && node.expression.text === 'eval') add(node, 'eval');
            if (
              ts.isPropertyAccessExpression(node.expression)
              && ts.isIdentifier(node.expression.expression)
              && node.expression.expression.text === 'document'
              && node.expression.name.text === 'write'
            ) add(node, 'document.write');
          }
          if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Function') {
            add(node, 'new Function');
          }
          ts.forEachChild(node, visit);
        };
        visit(sf);
      }
    }

    expect(findings).toEqual([]);
  });

  it('pins Stage 41 CSRF/PKCE runtime entropy + OAuth hardening evidence', () => {
    expect(csrfRuntime).toContain('generateCsrfToken yields unique 64-hex high-entropy values');
    expect(csrfRuntime).toContain('generatePKCE binds challenge to verifier via S256');
    expect(auth).toContain('generateCsrfToken');
    expect(auth).toContain('generatePKCE');
    expect(originRuntime).toContain("rejects %s before a cookie-authenticated mutation");
    expect(originRuntime).toContain('CSRF_ORIGIN_DENIED');
    expect(csrfRuntime).not.toMatch(/test\.(only|skip)|describe\.(only|skip)/);
    expect(originRuntime).not.toMatch(/test\.(only|skip)|describe\.(only|skip)/);
  });
});
