import fs from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';

const ROOT = process.cwd();
const SRC_ROOT = path.resolve(ROOT, 'src');
const CLIENT_FILE = path.resolve(SRC_ROOT, 'modules/nitrado/nitradoClient.ts');
const WORKER_FILE = path.resolve(SRC_ROOT, 'modules/nitrado/jobWorker.ts');

const EXPECTED_MUTATORS = [
  'addToBanlist',
  'addToWhitelist',
  'removeFromBanlist',
  'removeFromWhitelist',
  'restart',
  'start',
] as const;
const MUTATING_HTTP_VERBS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkTsFiles(absolute));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(absolute);
    }
  }
  return out.sort();
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function moduleIsNitradoClient(specifier: string): boolean {
  return /(?:^|\/)nitradoClient(?:\.js)?$/.test(specifier);
}

function mutatingClientMethods(): string[] {
  const source = parse(CLIENT_FILE);
  const found = new Set<string>();

  const classNode = source.statements.find(
    (statement): statement is ts.ClassDeclaration =>
      ts.isClassDeclaration(statement) && statement.name?.text === 'NitradoClient',
  );
  if (!classNode) throw new Error('NitradoClient class declaration fehlt.');

  for (const member of classNode.members) {
    if (!ts.isMethodDeclaration(member) || !member.body || !member.name || !ts.isIdentifier(member.name)) continue;
    const isPrivate = member.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.PrivateKeyword) ?? false;
    if (isPrivate) continue;

    let mutates = false;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'request'
        && node.arguments.length >= 2) {
        const verb = node.arguments[1];
        if (ts.isStringLiteralLike(verb) && MUTATING_HTTP_VERBS.has(verb.text.toUpperCase())) {
          mutates = true;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(member.body);
    if (mutates) found.add(member.name.text);
  }

  return [...found].sort();
}

interface ClientUsage {
  hasClientImport: boolean;
  importedClientNames: Set<string>;
  clientInstanceNames: Set<string>;
}

function collectClientUsage(source: ts.SourceFile): ClientUsage {
  const importedClientNames = new Set<string>();
  let hasClientImport = false;

  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    if (!moduleIsNitradoClient(statement.moduleSpecifier.text)) continue;
    hasClientImport = true;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      if (imported === 'NitradoClient') importedClientNames.add(element.name.text);
    }
  }

  const clientInstanceNames = new Set<string>();
  if (importedClientNames.size === 0) return { hasClientImport, importedClientNames, clientInstanceNames };

  const typeIsClient = (type: ts.TypeNode | undefined): boolean =>
    Boolean(type && ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && importedClientNames.has(type.typeName.text));

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (node.initializer
        && ts.isNewExpression(node.initializer)
        && ts.isIdentifier(node.initializer.expression)
        && importedClientNames.has(node.initializer.expression.text)) {
        clientInstanceNames.add(node.name.text);
      } else if (typeIsClient(node.type)) {
        clientInstanceNames.add(node.name.text);
      }
    }
    if (ts.isParameter(node) && ts.isIdentifier(node.name) && typeIsClient(node.type)) {
      clientInstanceNames.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  return { hasClientImport, importedClientNames, clientInstanceNames };
}

function mutationViolations(mutators: ReadonlySet<string>): string[] {
  const violations: string[] = [];
  const uniqueRemoteMethods = new Set([
    'addToBanlist',
    'addToWhitelist',
    'removeFromBanlist',
    'removeFromWhitelist',
  ]);

  for (const file of walkTsFiles(SRC_ROOT)) {
    if (file === CLIENT_FILE || file === WORKER_FILE) continue;
    const source = parse(file);
    const usage = collectClientUsage(source);
    const relative = path.relative(ROOT, file).replaceAll(path.sep, '/');

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        if (!mutators.has(method)) {
          ts.forEachChild(node, visit);
          return;
        }

        let directRemoteMutation = uniqueRemoteMethods.has(method);
        if (!directRemoteMutation && usage.hasClientImport) {
          const target = node.expression.expression;
          if (ts.isIdentifier(target) && usage.clientInstanceNames.has(target.text)) {
            directRemoteMutation = true;
          } else if (ts.isNewExpression(target)
            && ts.isIdentifier(target.expression)
            && usage.importedClientNames.has(target.expression.text)) {
            directRemoteMutation = true;
          }
        }

        if (directRemoteMutation) {
          const position = source.getLineAndCharacterOfPosition(node.getStart(source));
          violations.push(`${relative}:${position.line + 1}:${position.character + 1} -> ${method}()`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  return violations.sort();
}

function workerMutatorCalls(): Set<string> {
  const source = parse(WORKER_FILE);
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      if ((EXPECTED_MUTATORS as readonly string[]).includes(method)) found.add(method);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('Nitrado-1G single remote mutation boundary', () => {
  it('derives the complete public mutating NitradoClient contract from HTTP verbs', () => {
    expect(mutatingClientMethods()).toEqual([...EXPECTED_MUTATORS].sort());
  });

  it('allows direct Nitrado remote mutations only inside the canonical job worker', () => {
    const mutators = new Set(mutatingClientMethods());
    const violations = mutationViolations(mutators);
    expect(violations).toEqual([]);
  });

  it('keeps every declared NitradoClient mutator represented in the canonical worker', () => {
    expect([...workerMutatorCalls()].sort()).toEqual([...EXPECTED_MUTATORS].sort());
  });
});
