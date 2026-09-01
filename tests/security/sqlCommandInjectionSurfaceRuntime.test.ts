import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function walkTs(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === 'dist' || ent.name === 'coverage') continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkTs(p, out);
    else if (ent.isFile() && ent.name.endsWith('.ts') && !ent.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

function rel(p: string): string {
  return path.relative(root, p).replace(/\\/g, '/');
}

/** Extract first argument text of a call starting at `openParenIndex` (index of '('). */
function firstArg(source: string, openParenIndex: number): string | null {
  let i = openParenIndex + 1;
  while (i < source.length && /\s/.test(source[i])) i++;
  if (i >= source.length) return null;
  const start = i;
  const q = source[i];
  if (q === '`' || q === "'" || q === '"') {
    i++;
    while (i < source.length) {
      if (source[i] === '\\') {
        i += 2;
        continue;
      }
      if (source[i] === q) {
        return source.slice(start, i + 1);
      }
      i++;
    }
    return source.slice(start);
  }
  // bare identifier / expression until comma or paren at depth 0
  let depth = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0 && c === ')') return source.slice(start, i);
      depth = Math.max(0, depth - 1);
    } else if (c === ',' && depth === 0) {
      return source.slice(start, i);
    }
    i++;
  }
  return source.slice(start);
}

/**
 * Stage 42 residual close-out (CI-local):
 * - $queryRawUnsafe / $executeRawUnsafe first arg must not embed ${...}
 * - no child_process exec/spawn with dynamic shell command construction
 */
describe('Stage 42 SQL / command injection surface runtime scan', () => {
  const files = walkTs(path.join(root, 'src'));

  it('enumerates raw SQL call sites and keeps first-arg SQL free of ${ interpolation', () => {
    const sites: Array<{ file: string; index: number }> = [];
    const offenders: string[] = [];

    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      const re = /\$(?:query|execute)RawUnsafe\s*(?:<[^>]*>)?\s*\(/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const open = m.index + m[0].length - 1;
        const arg = firstArg(text, open);
        if (arg == null) continue;
        // skip type-position pseudo matches inside interfaces (no call)
        const before = text.slice(Math.max(0, m.index - 40), m.index);
        if (/\btype\b|\binterface\b|:\s*$/.test(before) && !/\bawait\b|\breturn\b|=/.test(before)) {
          // still count real method signatures on type aliases — ignore pure type members
          if (/RawDb|query:\s*string/.test(text.slice(m.index, m.index + 80))) continue;
        }
        sites.push({ file: rel(file), index: m.index });
        if (/^`/.test(arg) && /\$\{/.test(arg)) {
          // Allow only reviewed identifier/static-fragment slots. Runtime values must
          // still be bound via $1.. and the reusable purchase fragment must remain
          // a no-interpolation constant.
          const embeds = [...arg.matchAll(/\$\{([^}]+)\}/g)].map((x) => x[1].trim());
          const allowed = new Set([
            'column',
            'earnedSql',
            'PURCHASE_SELECT',
            "PURCHASE_SELECT.replace('LEFT JOIN', 'JOIN')",
            'ORDER_SELECT',
          ]);
          const bad = embeds.filter((e) => !allowed.has(e));
          if (bad.length) {
            offenders.push(`${rel(file)} first-arg template embeds \${${bad.join(',')}}: ${arg.slice(0, 100)}`);
          } else {
            // Require nearby allowlist assignment for pocket columns.
            const ctx = text.slice(Math.max(0, m.index - 400), m.index + 200);
            if (embeds.includes('column') && !/walletBalance|bankBalance/.test(ctx)) {
              offenders.push(`${rel(file)} \${column} without wallet/bank allowlist nearby`);
            }
            if (embeds.includes('earnedSql') && !/lifetimeEarned/.test(ctx) && !/earnedSql\s*=/.test(ctx)) {
              offenders.push(`${rel(file)} \${earnedSql} without allowlisted construction nearby`);
            }
            const purchaseEmbeds = embeds.filter((e) => (
              e === 'PURCHASE_SELECT' || e === "PURCHASE_SELECT.replace('LEFT JOIN', 'JOIN')"
            ));
            if (purchaseEmbeds.length > 0) {
              const definition = text.match(/const\s+PURCHASE_SELECT\s*=\s*(`[^`]*`|'[^']*'|"[^"]*");/);
              if (!definition || /\$\{/.test(definition[1])) {
                offenders.push(`${rel(file)} PURCHASE_SELECT must remain a static no-interpolation SQL fragment`);
              }
            }
            if (embeds.includes('ORDER_SELECT')) {
              const definition = text.match(/const\s+ORDER_SELECT\s*=\s*(`[^`]*`|'[^']*'|"[^"]*");/);
              if (!definition || /\$\{/.test(definition[1])) {
                offenders.push(`${rel(file)} ORDER_SELECT must remain a static no-interpolation SQL fragment`);
              }
            }
          }
        }
        // Multi-piece JS concat would appear as non-literal firstArg (identifier) —
        // those are allowed only if they resolve to constant SQL builders; values stay $1-bound.
      }
    }

    expect(sites.length).toBeGreaterThan(10);
    const allSrc = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    expect(allSrc).toMatch(/\$1/);
    expect(offenders).toEqual([]);
  });

  it('forbids child_process dynamic shell command construction in src/', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      if (!/from ['"]node:child_process['"]|from ['"]child_process['"]|require\(['"]child_process['"]\)/.test(text)) {
        continue;
      }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Only real process launchers — not RegExp.prototype.exec
        if (!/\b(?:execSync|execFileSync|spawnSync|execFile|spawn)\s*\(/.test(line) && !/\bexec\s*\(/.test(line)) {
          continue;
        }
        if (/\.exec\s*\(/.test(line) && !/\b(?:execSync|execFileSync|spawnSync|execFile|spawn|child_process)/.test(line)) {
          continue;
        }
        if (
          /(?:execSync|execFileSync|spawnSync|execFile|spawn|\bexec)\s*\(\s*`[^`]*\$\{/.test(line) ||
          /(?:execSync|execFileSync|spawnSync|execFile|spawn|\bexec)\s*\(\s*[a-zA-Z_][\w.]*\s*[,)]/.test(line)
        ) {
          offenders.push(`${rel(file)}:${i + 1}: ${line.trim().slice(0, 120)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('forbids skip/only in this suite', () => {
    const self = fs.readFileSync(
      path.join(root, 'tests/security/sqlCommandInjectionSurfaceRuntime.test.ts'),
      'utf8',
    );
    expect(self).not.toMatch(/test\.(only|skip)|describe\.(only|skip)/);
  });
});